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
import { recordReleaseFailure, resolveReleaseAttempt } from '@/lib/settlements/releaseAttempts'
import { randomUUID } from 'crypto'
import type { PlatformTransactionDocument, ReleaseStatus, OrganizerRevenueWallet } from '@/lib/fees/types'
import { planClawbackRecovery, type RecoverableClawback } from '@/lib/clawbacks/recoveryPlan'
import { logClawbackEvent } from '@/lib/clawbacks/clawbackService'
import { releasableNetAfterManualRefunds } from '@/lib/refunds/manualRefundRules'

// Phase 3 (Option C) — outstanding clawback debt is recovered HERE, inside the release transaction, from
// the amount being released (oldest debt first), before the remainder is credited to availablePaise.
// It is never taken from pendingPaise at credit time (that left a transaction fully releasable while its
// pending backing had been spent), and never from money already available / promised to a payout.
const CLAWBACK_COLLECTION = 'walletClawbacks'
const RECOVERABLE_STATUSES = ['open', 'partially_recovered'] as const
/** More open debts than this for one organizer: fail closed (the release waits; alerted) — never a partial, out-of-order recovery. */
const MAX_OPEN_CLAWBACKS = 200

// Batch size when the caller doesn't specify one. The hold time and the per-run
// MAX are resolved from Business Configuration (settlements.holdHours /
// maximumSettlementsPerRun) at run time.
const DEFAULT_LIMIT = 500
/**
 * Phase 3.10C — the run's TIME BUDGET, measured from the job's start. No new row is STARTED once it is spent;
 * a row already started (its release transaction, Firestore's own retries, its evidence call) always finishes,
 * and every row not started stays 'pending' — eligible, oldest first, for the next run. The release cron is
 * killed at maxDuration = 60 s: 40 s leaves ≥ 20 s for the last row in flight, the audit row, the cron metric
 * and the monitoring flush that follow in the route.
 */
export const RELEASE_RUN_BUDGET_MS = 40_000

export interface ReleaseFundsResult {
  processed:           number   // transactions released this run
  releasedAmountPaise: number   // total moved pending → available
  failures:            number   // eligible txns that did NOT release (incl. benign races)
  /** F1 — transactions skipped because a refund of their payment is open for review (present only when > 0). */
  held?:               number
  /** Phase 3.10C — the run stopped STARTING rows because its time budget was spent (present only when true). */
  stoppedByBudget?:    boolean
  /** Phase 3.10C — eligible rows of this run's batch NOT started (still pending; the next run takes them). */
  notStartedForBudget?: number
  /**
   * Phase 3.10E — eligible rows remain BEYOND this run's count limit (at least one, proven by a probe row; the
   * exact number is not counted). Present only when true. Independent of the time budget: both can be set.
   */
  stoppedByRowCap?:    boolean
  /** Phase 3.10E — the run's count limit (min of the requested limit and maximumSettlementsPerRun). */
  rowCap?:             number
}

interface SettlementReleaseDoc {
  transactionId: string
  organizerUid:  string
  /** The transaction's net moved OUT of pendingPaise (unchanged meaning). */
  amountPaise:   number
  releasedAt:    unknown
  daysHeld:      number
  /** Phase 3 — part of amountPaise that paid outstanding clawback debt (absent on records before Phase 3 = 0). */
  recoveredClawbackPaise?: number
  /** Phase 3 — part of amountPaise credited to availablePaise (= amountPaise − recoveredClawbackPaise). */
  creditedAvailablePaise?: number
  clawbackRecoveries?: Array<{ clawbackId: string; amountPaise: number }>
}

// Benign outcomes under concurrency — NOT real failures, never alerted. A
// concurrent releaser already moved this transaction (idempotency working).
const BENIGN = new Set(['ALREADY_RELEASED', 'TX_GONE'])

/**
 * Releases all eligible held funds (bounded by `limit`). Idempotent + safe to run
 * concurrently. Per-transaction failures are isolated (one bad txn never blocks
 * the rest) and real anomalies are reported via captureFinancialError.
 */
export async function releaseEligibleFunds(options?: { limit?: number; budgetMs?: number }): Promise<ReleaseFundsResult> {
  // Phase 3.10C — the budget clock starts with the job (config read and the eligibility query count against it)
  const deadline = Date.now() + (options?.budgetMs ?? RELEASE_RUN_BUDGET_MS)
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
    // Phase 3.10E — ONE row past the cap is read as a probe and never processed: it proves eligible rows remain
    // beyond this run's count limit (an exactly-full batch with nothing after it is NOT reported as capped)
    .limit(limit + 1)
    .get()
  const batch = eligibleSnap.docs.slice(0, limit)
  const stoppedByRowCap = eligibleSnap.size > limit

  let processed = 0
  let releasedAmountPaise = 0
  let failures = 0
  let held = 0
  // Phase 3.10A — one id per run: release-attempt evidence is idempotent per run (lib/settlements/releaseAttempts.ts)
  const runId = randomUUID()

  let stoppedByBudget = false
  let notStartedForBudget = 0

  // Sequential so each in-transaction wallet read sees the latest committed state
  // (multiple held transactions for the same organizer release correctly in order).
  for (const [index, txDoc] of batch.entries()) {
    // Phase 3.10C — checked BEFORE a row starts, never during one: an in-flight release is never interrupted
    if (Date.now() >= deadline) { stoppedByBudget = true; notStartedForBudget = batch.length - index; break }
    const txData     = txDoc.data() as PlatformTransactionDocument
    const txRef      = adminDb.doc(`platformTransactions/${txDoc.id}`)
    const walletRef  = adminDb.doc(`organizerRevenueWallets/${txData.organizerUid}`)
    const releaseRef = adminDb.collection('settlementReleases').doc()

    try {
      const out = await adminDb.runTransaction(async tx => {
        // 1. Re-read inside the txn — guard against concurrent release (exactly-once).
        const freshSnap = await tx.get(txRef)
        if (!freshSnap.exists) throw new Error('TX_GONE')
        const fresh = freshSnap.data() as PlatformTransactionDocument
        if (fresh.releaseStatus === 'released') throw new Error('ALREADY_RELEASED')
        // F1 — a refund of this payment is open for review (partial / contradictory): never released here.
        // The query only takes 'pending'; this re-check covers a hold placed after the query ran.
        if (fresh.releaseStatus === 'held' || fresh.releaseHold) throw new Error('REFUND_HOLD')
        // M1 — defence in depth: only a COMPLETED transaction is ever released (a reversed one never is,
        // whatever its releaseStatus — e.g. after its refund hold was closed by a full refund).
        if (fresh.status !== 'completed') throw new Error('TX_GONE')

        // 2. Read wallet — guard against under-funded pending bucket.
        const walletSnap = await tx.get(walletRef)
        if (!walletSnap.exists) throw new Error('NO_WALLET')
        const wallet = walletSnap.data() as OrganizerRevenueWallet
        // RD-REFUND-MANUAL-01 — a manual refund reversed part of this net with a negative reversal row and debited it
        // from pending in the same commit; only what is LEFT of the net is still in pending for this transaction.
        // (Absent on every other row ⇒ the full net, byte-identical to before.)
        const amt = releasableNetAfterManualRefunds(fresh.netSettlementPaise,
          (fresh as { manualRefund?: { reversedNetPaise?: unknown } }).manualRefund?.reversedNetPaise)
        if (!Number.isInteger(amt) || amt < 0) throw new Error(`INVALID_AMOUNT:${amt}`)
        if (wallet.pendingPaise < amt) throw new Error(`INSUFFICIENT:${wallet.pendingPaise}:${amt}`)

        // 2b. Phase 3 — the organizer's OPEN clawback debt, read in THIS transaction (so a concurrent waive,
        //     manual recovery or another release serialises with it). Served by the declared index
        //     (organizerUid ASC, status ASC, createdAt DESC); ordered oldest-first in memory.
        const clawSnap = await tx.get(adminDb.collection(CLAWBACK_COLLECTION)
          .where('organizerUid', '==', fresh.organizerUid)
          .where('status', 'in', [...RECOVERABLE_STATUSES])
          .orderBy('createdAt', 'desc')
          .limit(MAX_OPEN_CLAWBACKS + 1))
        if (clawSnap.size > MAX_OPEN_CLAWBACKS) throw new Error(`CLAWBACK_SET_TOO_LARGE:${clawSnap.size}`)
        const debts: RecoverableClawback[] = clawSnap.docs.map(d => {
          const c = d.data() as { outstandingAmountPaise?: unknown; createdAt?: { toMillis?: () => number } }
          return { id: d.id, outstandingPaise: c.outstandingAmountPaise as number, createdAtMs: c.createdAt?.toMillis?.() ?? 0 }
        })
        const plan = planClawbackRecovery(amt, debts)   // throws CLAWBACK_INVALID (fail closed)

        const paidAtTs = fresh.paidAt as Timestamp
        const daysHeld = Math.floor((Date.now() - paidAtTs.toMillis()) / (1000 * 60 * 60 * 24))

        // 3. Flip release state.
        tx.update(txRef, {
          releaseStatus: 'released' satisfies ReleaseStatus,
          releasedAt:    FieldValue.serverTimestamp(),
          updatedAt:     FieldValue.serverTimestamp(),
        })

        // 4. Move money (explicit arithmetic on the consistent in-txn read). The whole net leaves pending;
        //    the part that pays clawback debt is NOT credited to available (the debt shrinks by exactly it),
        //    so pending + available + outstanding debt is invariant. inTransitPaise is never touched.
        tx.update(walletRef, {
          pendingPaise:   wallet.pendingPaise   - amt,
          availablePaise: wallet.availablePaise + plan.creditedPaise,
          updatedAt:      FieldValue.serverTimestamp(),
        })

        // 4b. Phase 3 — each debt paid, in the same commit (oldest first).
        const byId = new Map(clawSnap.docs.map(d => [d.id, d.data() as { recoveredAmountPaise?: unknown }]))
        for (const t of plan.takes) {
          const prevRecovered = typeof byId.get(t.id)?.recoveredAmountPaise === 'number' ? byId.get(t.id)!.recoveredAmountPaise as number : 0
          const fully = t.remainingPaise === 0
          tx.update(adminDb.collection(CLAWBACK_COLLECTION).doc(t.id), {
            recoveredAmountPaise:   prevRecovered + t.takePaise,
            outstandingAmountPaise: t.remainingPaise,
            status:                 fully ? 'recovered' : 'partially_recovered',
            lastRecovery:           { transactionId: txDoc.id, settlementReleaseId: releaseRef.id, amountPaise: t.takePaise, at: FieldValue.serverTimestamp() },
            updatedAt:              FieldValue.serverTimestamp(),
            ...(fully ? { resolvedAt: FieldValue.serverTimestamp(), resolvedBy: 'system' } : {}),
          })
        }

        // 5. Audit record (commits atomically with 3+4; the loser of a race never
        //    reaches commit, so no duplicate release doc is written).
        const releaseDoc: SettlementReleaseDoc = {
          transactionId: txDoc.id, organizerUid: fresh.organizerUid, amountPaise: amt,
          releasedAt: FieldValue.serverTimestamp(), daysHeld,
          recoveredClawbackPaise: plan.recoveredPaise,
          creditedAvailablePaise: plan.creditedPaise,
          ...(plan.takes.length ? { clawbackRecoveries: plan.takes.map(t => ({ clawbackId: t.id, amountPaise: t.takePaise })) } : {}),
        }
        tx.set(releaseRef, releaseDoc)

        return { amt, plan }
      })
      const amount = out.amt

      processed += 1
      releasedAmountPaise += amount
      // Phase 3 — the system recovery events, audited after commit (never throws; a failed write is recorded).
      for (const t of out.plan.takes) {
        await logClawbackEvent('system', t.remainingPaise === 0 ? 'clawback.recovered' : 'clawback.partially_recovered', t.id, {
          recoveredPaise: t.takePaise, auto: true, at: 'settlement_release', transactionId: txDoc.id, settlementReleaseId: releaseRef.id,
        })
      }
      // H.4.3: organizer Notification Center inbox (best-effort; deduped per txn).
      void notifySettlement({ workspaceUid: txData.organizerUid, settlementId: txDoc.id, kind: 'released', amountPaise: amount })
      // Phase 3.10A — an open release-attempt record for this row is marked resolved (never throws)
      await resolveReleaseAttempt({ ptxId: txDoc.id, releaseId: releaseRef.id })
    } catch (err) {
      const code = err instanceof Error ? err.message : 'unknown'
      if (code === 'REFUND_HOLD') { held += 1; continue }
      failures += 1
      // Phase 3.10A — durable evidence of the refusal, AFTER the transaction's final outcome (never throws;
      // benign races are not recorded; a transient / unknown error is recorded as such, never as a refusal)
      await recordReleaseFailure({ ptxId: txDoc.id, organizerUid: typeof txData.organizerUid === 'string' ? txData.organizerUid : null, runId, message: code })
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

  return {
    processed, releasedAmountPaise, failures, ...(held ? { held } : {}),
    ...(stoppedByBudget ? { stoppedByBudget, notStartedForBudget } : {}),
    ...(stoppedByRowCap ? { stoppedByRowCap, rowCap: limit } : {}),
  }
}
