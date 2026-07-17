// Automated T+2 settlement release (P0-4). Server-only.
//
// Moves an organizer's net proceeds from pendingPaise → availablePaise once a
// platform transaction has been held ≥ 48h. Shared by the hourly cron AND the
// manual admin endpoint, so there is ONE implementation of the money movement.
//
// Eligibility:
//   platformTransactions.status        == 'completed'
//   platformTransactions.releaseStatus == 'pending'
//   platformTransactions.paidAt        <= now − 48h
//
// Exactly-once guarantee: each transaction is released inside a Firestore
// transaction that RE-READS releaseStatus and aborts if it is already 'released'.
// Firestore's optimistic concurrency serializes concurrent releasers (admin +
// cron + overlapping cron runs) on the transaction doc — the loser retries, sees
// 'released', and makes no wallet mutation. The wallet debit/credit and the
// settlementReleases record commit in the SAME transaction or not at all.
//
// Composite index required: platformTransactions (status, releaseStatus, paidAt).

import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import { captureFinancialError } from '@/lib/monitoring/sentry'
import { notifySettlement } from '@/lib/notifications/inbox/notify'
import { getSettlementConfig } from '@/lib/settlements/resolveSettlementConfig'
import type { PlatformTransactionDocument, ReleaseStatus, OrganizerRevenueWallet } from '@/lib/fees/types'

// Batch size when the caller doesn't specify one. The hold time and the per-run
// MAX are resolved from Business Configuration (settlements.holdHours /
// maximumSettlementsPerRun) at run time.
const DEFAULT_LIMIT = 500

export interface ReleaseFundsResult {
  processed:           number   // transactions released this run
  releasedAmountPaise: number   // total moved pending → available
  failures:            number   // eligible txns that did NOT release (incl. benign races)
}

interface SettlementReleaseDoc {
  transactionId: string
  organizerUid:  string
  amountPaise:   number
  releasedAt:    unknown
  daysHeld:      number
}

// Benign outcomes under concurrency — NOT real failures, never alerted. A
// concurrent releaser already moved this transaction (idempotency working).
const BENIGN = new Set(['ALREADY_RELEASED', 'TX_GONE'])

/**
 * Releases all eligible held funds (bounded by `limit`). Idempotent + safe to run
 * concurrently. Per-transaction failures are isolated (one bad txn never blocks
 * the rest) and real anomalies are reported via captureFinancialError.
 */
export async function releaseEligibleFunds(options?: { limit?: number }): Promise<ReleaseFundsResult> {
  // Settlement policy (Business Configuration): the hold time + per-run max are
  // config-driven, and the whole release is skipped when settlements are disabled.
  const settlements = await getSettlementConfig()
  // Skipped when settlements are disabled OR the subsystem is frozen (default false).
  if (!settlements.enabled || settlements.frozen) return { processed: 0, releasedAmountPaise: 0, failures: 0 }
  const limit  = Math.min(Math.max(options?.limit ?? DEFAULT_LIMIT, 1), settlements.maximumSettlementsPerRun)
  const cutoff = Timestamp.fromMillis(Date.now() - settlements.holdHours * 60 * 60 * 1000)

  const eligibleSnap = await adminDb
    .collection('platformTransactions')
    .where('status',        '==', 'completed')
    .where('releaseStatus', '==', 'pending' satisfies ReleaseStatus)
    .where('paidAt',        '<=', cutoff)
    .orderBy('paidAt', 'asc')
    .limit(limit)
    .get()

  let processed = 0
  let releasedAmountPaise = 0
  let failures = 0

  // Sequential so each in-transaction wallet read sees the latest committed state
  // (multiple held transactions for the same organizer release correctly in order).
  for (const txDoc of eligibleSnap.docs) {
    const txData     = txDoc.data() as PlatformTransactionDocument
    const txRef      = adminDb.doc(`platformTransactions/${txDoc.id}`)
    const walletRef  = adminDb.doc(`organizerRevenueWallets/${txData.organizerUid}`)
    const releaseRef = adminDb.collection('settlementReleases').doc()

    try {
      const amount = await adminDb.runTransaction(async tx => {
        // 1. Re-read inside the txn — guard against concurrent release (exactly-once).
        const freshSnap = await tx.get(txRef)
        if (!freshSnap.exists) throw new Error('TX_GONE')
        const fresh = freshSnap.data() as PlatformTransactionDocument
        if (fresh.releaseStatus === 'released') throw new Error('ALREADY_RELEASED')

        // 2. Read wallet — guard against under-funded pending bucket.
        const walletSnap = await tx.get(walletRef)
        if (!walletSnap.exists) throw new Error('NO_WALLET')
        const wallet = walletSnap.data() as OrganizerRevenueWallet
        const amt = fresh.netSettlementPaise
        if (wallet.pendingPaise < amt) throw new Error(`INSUFFICIENT:${wallet.pendingPaise}:${amt}`)

        const paidAtTs = fresh.paidAt as Timestamp
        const daysHeld = Math.floor((Date.now() - paidAtTs.toMillis()) / (1000 * 60 * 60 * 24))

        // 3. Flip release state.
        tx.update(txRef, {
          releaseStatus: 'released' satisfies ReleaseStatus,
          releasedAt:    FieldValue.serverTimestamp(),
          updatedAt:     FieldValue.serverTimestamp(),
        })

        // 4. Move money (explicit arithmetic on the consistent in-txn read; the
        //    sum pending+available is invariant — no money created or destroyed).
        tx.update(walletRef, {
          pendingPaise:   wallet.pendingPaise   - amt,
          availablePaise: wallet.availablePaise + amt,
          updatedAt:      FieldValue.serverTimestamp(),
        })

        // 5. Audit record (commits atomically with 3+4; the loser of a race never
        //    reaches commit, so no duplicate release doc is written).
        const releaseDoc: SettlementReleaseDoc = {
          transactionId: txDoc.id, organizerUid: fresh.organizerUid, amountPaise: amt,
          releasedAt: FieldValue.serverTimestamp(), daysHeld,
        }
        tx.set(releaseRef, releaseDoc)

        return amt
      })

      processed += 1
      releasedAmountPaise += amount
      // H.4.3: organizer Notification Center inbox (best-effort; deduped per txn).
      void notifySettlement({ workspaceUid: txData.organizerUid, settlementId: txDoc.id, kind: 'released', amountPaise: amount })
    } catch (err) {
      failures += 1
      const code = err instanceof Error ? err.message : 'unknown'
      // Alert only on genuine anomalies — never on idempotency races.
      if (!BENIGN.has(code.split(':')[0])) {
        captureFinancialError(err, {
          scope:         'settlement_release',
          area:          'settlement_release',
          detail:        'release transaction failed',
          transactionId: txDoc.id,
          organizerUid:  txData.organizerUid,
          amountPaise:   txData.netSettlementPaise,
        })
      }
    }
  }

  return { processed, releasedAmountPaise, failures }
}
