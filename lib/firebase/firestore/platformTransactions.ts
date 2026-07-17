// Shadow ledger for every completed payment on the platform.
// Document ID pattern: ptx_${sourceId} — deterministic for idempotent writes.

import { FieldValue }  from 'firebase-admin/firestore'
import { adminDb }     from '@/lib/firebase/admin'
import { captureFinancialError } from '@/lib/monitoring/sentry'
import { computeWalletDebit, buildRevenueCreditUpdate } from '@/lib/firebase/firestore/revenueWallets'
import { reconcileSettlementHoldsAfterRefund } from '@/lib/settlements/reconcile'
import { writeClawbackOnShortfall, recoverClawbacks, logClawbackEvent } from '@/lib/clawbacks/clawbackService'
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

  // New revenue just credited → pay down any open clawbacks for this organizer,
  // oldest first, bounded by the net amount. Best-effort, only on a real credit
  // (created:true); never blocks or fails the credit path.
  if (result.created) {
    await recoverClawbacks(credit.organizerUid, credit.netSettlementPaise).catch(() => {})
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

  // Captured from the committed transaction so post-commit settlement
  // reconciliation can run outside the wallet transaction.
  let reconcileUid: string | null = null   // set only when a hold lost its backing
  // Clawback recorded atomically inside the txn; audited after commit.
  let clawbackInfo: { clawbackId: string; outstandingPaise: number } | null = null

  const result = await adminDb.runTransaction<ReverseAndDebitResult>(async tx => {
    reconcileUid = null   // reset per attempt (transactions may retry)
    clawbackInfo = null

    const snap = await tx.get(txRef)
    if (!snap.exists) {
      return { found: false, reversed: false, debited: 0, insolvent: false }
    }

    const data = snap.data() as PlatformTransactionDocument

    // Idempotent: already reversed (refunded/disputed) → no second debit.
    if (data.status === 'refunded' || data.status === 'disputed') {
      return { found: true, reversed: false, debited: 0, insolvent: false }
    }

    // ── reads before writes ──
    const walletRef  = adminDb.collection('organizerRevenueWallets').doc(data.organizerUid)
    const walletSnap = await tx.get(walletRef)

    let debited   = 0
    let insolvent = false

    if (walletSnap.exists) {
      const wallet = walletSnap.data() as OrganizerRevenueWallet
      const plan   = computeWalletDebit(wallet, data.netSettlementPaise)
      debited      = plan.totalDebited
      insolvent    = plan.totalDebited < data.netSettlementPaise

      const newAvailable = wallet.availablePaise - plan.fromAvailable
      // INVARIANT: inTransitPaise must never exceed availablePaise, so a refund
      // that drains funds backing a settlement hold clamps the hold down. This
      // keeps freeBalance (= available − inTransit) >= 0. The settlement REQUESTS
      // behind a clamped hold are reconciled (rejected) post-commit.
      const oldInTransit = wallet.inTransitPaise ?? 0
      const newInTransit = Math.min(oldInTransit, newAvailable)
      if (newInTransit < oldInTransit) reconcileUid = data.organizerUid

      tx.update(walletRef, {
        pendingPaise:   wallet.pendingPaise - plan.fromPending,
        availablePaise: newAvailable,
        inTransitPaise: newInTransit,
        updatedAt:      FieldValue.serverTimestamp(),
      })
    } else {
      insolvent = data.netSettlementPaise > 0   // no wallet to debit against
    }

    // Durable clawback for the under-debit (atomic with the wallet debit + status
    // flip). The shortfall is persisted as a recoverable debt — never lost to logs.
    if (insolvent) {
      clawbackInfo = writeClawbackOnShortfall(tx, {
        transactionId:       txId,
        organizerUid:        data.organizerUid,
        sourceType:          data.sourceType,
        sourceId:            data.sourceId,
        reversalAmountPaise: data.netSettlementPaise,
        debitedPaise:        debited,
        reason:              newStatus === 'disputed' ? 'dispute' : 'refund',
      })
    }

    // ── status flip commits atomically with the wallet debit ──
    tx.update(txRef, { status: newStatus, updatedAt: FieldValue.serverTimestamp() })

    return { found: true, reversed: true, debited, insolvent }
  })

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
    void logClawbackEvent('system', 'clawback.created', info.clawbackId, {
      txId, outstandingPaise: info.outstandingPaise, debited: result.debited,
    }).catch(() => {})
  }

  // A settlement hold lost its backing — reject the now-unbacked pending/approved
  // requests and rebuild inTransitPaise. Best-effort: the wallet invariant is
  // already guaranteed above, so a failure here can't make the wallet unsafe.
  if (result.reversed && reconcileUid) {
    await reconcileSettlementHoldsAfterRefund(reconcileUid).catch(err =>
      captureFinancialError(err, { scope: 'reversePlatformTransactionAndDebit.settlement_reconcile_failed', txId }),
    )
  }

  return result
}
