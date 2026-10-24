// Shadow ledger for every completed payment on the platform.
// Document ID pattern: ptx_${sourceId} — deterministic for idempotent writes.

import { FieldValue }  from 'firebase-admin/firestore'
import { adminDb }     from '@/lib/firebase/admin'
import { captureFinancialError } from '@/lib/monitoring/sentry'
import { computeReversalDebit, walletBucketForRelease, buildRevenueCreditUpdate } from '@/lib/firebase/firestore/revenueWallets'
import { readOpenPayoutRequests, planPayoutRefit, stagePayoutReviews } from '@/lib/settlements/payoutReview'
import { writeClawbackOnShortfall, logClawbackEvent } from '@/lib/clawbacks/clawbackService'
import {
  resolveWalletSettlementPure,
  recordWalletSettlementMetric,
  recordWalletCreditMetric,
  type WalletSettlementSource,
} from '@/lib/platform/pricing'
import type {
  PlatformTransactionDocument,
  PlatformTransactionStatus,
  OrganizerRevenueWallet,
} from '@/lib/fees/types'

function txnsCol() {
  return adminDb.collection('platformTransactions')
}

// Ledger payload minus the fields the writer always controls (lifecycle +
// timestamps). All primitive — safe to persist verbatim in a reconciliation
// record and replay later.
export type PlatformTransactionData = Omit<
  PlatformTransactionDocument,
  'status' | 'releaseStatus' | 'releasedAt' | 'gatewayFeeActualPaise' | 'settlementId' | 'paidAt' | 'createdAt' | 'updatedAt'
>

export interface RevenueCreditInput {
  organizerUid:       string
  grossAmountPaise:   number
  feesTotalPaise:     number   // platformFeeTotal + gatewayFeeEstimate
  netSettlementPaise: number
}

/**
 * Atomically writes the platform-transaction ledger entry AND credits the
 * organizer revenue wallet in ONE Firestore transaction. Idempotent on the
 * ledger doc id (`ptx_${sourceId}`): if it already exists, NEITHER write repeats
 * — so the browser-verify path, the webhook recovery path, and the
 * reconciliation retry can run in any order/overlap and the wallet is credited
 * EXACTLY ONCE. Replaces the previous non-atomic
 * `Promise.all(createPlatformTransaction, creditRevenueWallet)`, which could
 * credit without a ledger row (or vice-versa) on partial failure.
 *
 * Returns `{ created }` — false when the entry already existed (already credited).
 */
export async function recordPlatformTransactionAndCredit(
  data:   PlatformTransactionData,
  credit: RevenueCreditInput,
): Promise<{ created: boolean }> {
  const txRef     = txnsCol().doc(data.id)
  const walletRef = adminDb.collection('organizerRevenueWallets').doc(credit.organizerUid)

  const result = await adminDb.runTransaction(async tx => {
    const existing = await tx.get(txRef)
    if (existing.exists) return { created: false }

    tx.set(txRef, {
      ...data,
      status:        'completed' as PlatformTransactionStatus,
      releaseStatus: 'pending',
      paidAt:        FieldValue.serverTimestamp(),
      createdAt:     FieldValue.serverTimestamp(),
      updatedAt:     FieldValue.serverTimestamp(),
    })
    tx.set(
      walletRef,
      buildRevenueCreditUpdate(credit.organizerUid, credit.grossAmountPaise, credit.feesTotalPaise, credit.netSettlementPaise) as unknown as OrganizerRevenueWallet,
      { merge: true },
    )
    return { created: true }
  })

  // Phase 3 (Option C) — clawback debt is NOT recovered here any more: recovering from pendingPaise at
  // credit time left this transaction fully releasable while its pending backing had been spent (its
  // release then failed INSUFFICIENT). Debt is recovered when the transaction is RELEASED, inside the
  // release transaction (lib/settlements/releaseFunds.ts).
  if (result.created) {
    // RD-PRICING-02D: wallet-credit diagnostics. The credited value is already
    // resolved snapshot-first at order time (02C · data.pricingSource); this only
    // records which source fed the wallet. Metrics only — no value change.
    recordWalletCreditMetric(data)
  }
  return result
}

// Idempotent — uses a Firestore transaction to no-op if the document already
// exists. Handles browser verify + webhook race without double-writing.
export async function createPlatformTransaction(
  doc: PlatformTransactionDocument,
): Promise<void> {
  const ref = txnsCol().doc(doc.id)
  await adminDb.runTransaction(async txn => {
    const existing = await txn.get(ref)
    if (existing.exists) return
    txn.set(ref, {
      ...doc,
      releaseStatus: 'pending',   // always starts pending; released by release-funds route
      createdAt:     FieldValue.serverTimestamp(),
      updatedAt:     FieldValue.serverTimestamp(),
    })
  })
}

export async function getPlatformTransaction(
  txId: string,
): Promise<PlatformTransactionDocument | null> {
  const snap = await txnsCol().doc(txId).get()
  if (!snap.exists) return null
  return snap.data() as PlatformTransactionDocument
}

export interface ReverseAndDebitResult {
  found:     boolean   // the platform transaction (ledger entry) existed
  reversed:  boolean   // THIS call flipped the status and applied the wallet debit
  debited:   number    // paise debited from the organizer's revenue wallet (0 if not reversed)
  insolvent: boolean   // wallet could not fully cover the debit (flag for reconciliation)
}

/**
 * Atomically reverses a platform-transaction ledger entry AND debits the
 * organizer's revenue wallet in a SINGLE Firestore transaction.
 *
 * Idempotency / double-debit protection: the status check and flip happen inside
 * the transaction, so concurrent or duplicate refund signals are serialized on
 * the ledger document. Exactly one call observes a non-terminal status, flips it
 * to `refunded`/`disputed`, and performs the debit (`reversed: true`); every
 * other call observes the terminal status and no-ops (`reversed: false`, no
 * debit). The status flip and the wallet debit can never be split across
 * processes — they commit together or not at all.
 *
 * Insolvency is handled by clamping (debit what's available) and flagging
 * `insolvent`, NOT by throwing: the refund has already happened at the gateway,
 * so the ledger MUST reflect it; rolling back would either lose the reversal or
 * loop on retries. An insolvent reversal is logged for manual reconciliation.
 *
 * Returns `{ found: false }` when the ledger entry doesn't exist (e.g. a refund
 * for a payment that predates the ledger) — safe no-op.
 */
export async function reversePlatformTransactionAndDebit(
  txId:      string,
  newStatus: Extract<PlatformTransactionStatus, 'refunded' | 'disputed'> = 'refunded',
): Promise<ReverseAndDebitResult> {
  const txRef = txnsCol().doc(txId)

  // M1 — payout requests this reversal sent to review (in the transaction; reported after commit).
  let reviewed: string[] = []
  // Clawback recorded atomically inside the txn; audited after commit.
  let clawbackInfo: { clawbackId: string; outstandingPaise: number } | null = null
  // RD-PRICING-02D: which source produced the reversal settlement (metric, post-commit).
  let settlementSource: WalletSettlementSource = 'fallback'

  const result = await adminDb.runTransaction<ReverseAndDebitResult>(async tx => {
    reviewed = []         // reset per attempt (transactions may retry)
    clawbackInfo = null
    settlementSource = 'fallback'

    const snap = await tx.get(txRef)
    if (!snap.exists) {
      return { found: false, reversed: false, debited: 0, insolvent: false }
    }

    const data = snap.data() as PlatformTransactionDocument

    // Idempotent: already reversed (refunded/disputed) → no second debit.
    if (data.status === 'refunded' || data.status === 'disputed') {
      return { found: true, reversed: false, debited: 0, insolvent: false }
    }

    // RD-REFUND-MANUAL-01 — part (or all) of this net was already reversed by MANUAL refunds (negative reversal rows,
    // lib/refunds/manualRefunds.ts). Reversing the full net in place would debit the organizer twice and double-count
    // it in every payable / reconciliation figure. Every caller of this function is a gateway refund, a dispute or a
    // queued retry of one — all are refused before any write; the callers' durable reconciliation queue escalates it
    // to a human (needs_review). The webhook already holds such a refund for review before reaching here.
    if ((data as { manualRefund?: unknown }).manualRefund) {
      throw new Error(`MANUAL_REFUND_PRESENT:${txId}`)
    }

    // RD-PRICING-02D: reverse EXACTLY what was credited, snapshot-first. The resolver
    // guarantees `reversalNetPaise === data.netSettlementPaise` (the credited amount),
    // so the debit is byte-identical to production; it only records WHERE the value
    // came from. Pure (metric-free) so a transaction retry cannot double-count.
    const settlement    = resolveWalletSettlementPure(data)
    settlementSource    = settlement.source
    const reversalNetPaise = settlement.netSettlementPaise

    // The bucket holding THIS transaction's net, from its releaseStatus read in this transaction (the
    // release job flips it in the same transaction that moves the net, so the two cannot disagree). An
    // unknown status fails closed BEFORE any write: the caller's durable ledger-reversal retry keeps it.
    const bucket = walletBucketForRelease(data.releaseStatus)
    if (!bucket) throw new Error(`REVERSAL_BUCKET_UNKNOWN:${txId}:${String(data.releaseStatus)}`)

    // ── reads before writes ──
    const walletRef  = adminDb.collection('organizerRevenueWallets').doc(data.organizerUid)
    const walletSnap = await tx.get(walletRef)

    let debited   = 0
    let insolvent = false

    if (walletSnap.exists) {
      const wallet = walletSnap.data() as OrganizerRevenueWallet
      const plan   = computeReversalDebit(wallet, reversalNetPaise, bucket)
      debited      = plan.totalDebited
      insolvent    = plan.totalDebited < reversalNetPaise

      const newAvailable = wallet.availablePaise - plan.fromAvailable
      // INVARIANT: inTransitPaise must never exceed availablePaise (freeBalance = available − inTransit ≥ 0).
      // M1 — when this refund leaves payout reservations unbacked, the requests that no longer fit go to REVIEW
      // in THIS transaction (never auto-rejected, never reduced); inTransit becomes exactly the reservations
      // kept. Read before any write. Otherwise the existing clamp applies unchanged.
      // M1.1 — checked whenever the refund takes money from AVAILABLE (not only when the clamp bites): a stored
      // inTransit that already drifted below its reservations (pre-M1 donation refunds left it so) must not hide
      // requests this refund leaves unbacked.
      const oldInTransit = wallet.inTransitPaise ?? 0
      let newInTransit = Math.min(oldInTransit, newAvailable)
      if (plan.fromAvailable > 0) {
        const requests = await readOpenPayoutRequests(tx, data.organizerUid)
        const refit = planPayoutRefit(requests, newAvailable)
        if (refit.toReview.length > 0) {
          stagePayoutReviews(tx, { organizerUid: data.organizerUid, availablePaise: newAvailable, trigger: { kind: 'registration_refund', ref: txId }, plan: refit })
          newInTransit = refit.keptPaise
          reviewed = refit.toReview.map(r => r.id)
        }
      }

      tx.update(walletRef, {
        pendingPaise:   wallet.pendingPaise - plan.fromPending,
        availablePaise: newAvailable,
        inTransitPaise: newInTransit,
        updatedAt:      FieldValue.serverTimestamp(),
      })
    } else {
      insolvent = reversalNetPaise > 0   // no wallet to debit against
    }

    // Durable clawback for the under-debit (atomic with the wallet debit + status
    // flip). The shortfall is persisted as a recoverable debt — never lost to logs.
    if (insolvent) {
      clawbackInfo = writeClawbackOnShortfall(tx, {
        transactionId:       txId,
        organizerUid:        data.organizerUid,
        sourceType:          data.sourceType,
        sourceId:            data.sourceId,
        reversalAmountPaise: reversalNetPaise,
        debitedPaise:        debited,
        reason:              newStatus === 'disputed' ? 'dispute' : 'refund',
      })
    }

    // ── status flip commits atomically with the wallet debit ──
    tx.update(txRef, { status: newStatus, updatedAt: FieldValue.serverTimestamp() })

    return { found: true, reversed: true, debited, insolvent }
  })

  // RD-PRICING-02D: record the reversal's settlement source ONCE, post-commit (only on
  // a real reversal, so a retried/idempotent no-op never inflates the counters).
  if (result.reversed) recordWalletSettlementMetric(settlementSource)

  if (result.reversed && result.insolvent) {
    captureFinancialError('wallet_under_debit', {
      scope: 'reversePlatformTransactionAndDebit.under_debit',
      detail: 'WALLET UNDER-DEBIT — clawback recorded',
      txId, debited: result.debited,
    })
  }
  // Audit the clawback creation (system actor) once the txn has committed.
  if (result.reversed && clawbackInfo) {
    const info = clawbackInfo as { clawbackId: string; outstandingPaise: number }
    // RD-PHASE4-S4 — awaited (never throws; a failed write is recorded for reconciliation).
    await logClawbackEvent('system', 'clawback.created', info.clawbackId, {
      txId, outstandingPaise: info.outstandingPaise, debited: result.debited,
    })
  }

  // M1 — the reviews, their audit rows and the organizer notifications committed WITH the reversal (nothing is
  // left to a best-effort follow-up). Surfaced for operations: payouts now wait on a Super Admin.
  if (result.reversed && reviewed.length > 0) {
    captureFinancialError(new Error(`payout request(s) held for review after refund ${txId}`), {
      scope: 'reversePlatformTransactionAndDebit.payout_review_opened', txId, settlementIds: reviewed.join(','),
    })
  }

  return result
}
