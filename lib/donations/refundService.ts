// Donation refund engine — server-only (Admin SDK).
//
// Supports full + partial refunds with PROPORTIONAL settlement reversal,
// idempotent exactly-once accounting (shared by the organizer API and the
// refund.processed webhook via the Razorpay refund id), and exact counter
// reconciliation. Distinct from the registration full-reversal path
// (reversePlatformTransactionAndDebit) which it deliberately does not reuse.

import { FieldValue, FieldPath, Timestamp } from 'firebase-admin/firestore'
import { adminDb }          from '@/lib/firebase/admin'
import { computeReversalDebit, walletBucketForRelease } from '@/lib/firebase/firestore/revenueWallets'
import { writeClawbackOnShortfall, logClawbackEvent } from '@/lib/clawbacks/clawbackService'
import { enqueueWebhook }        from '@/lib/integrations/webhooks'
import { crmRecordRefund }       from '@/lib/crm/service'
import { captureFinancialError } from '@/lib/monitoring/sentry'
import { stageAdminAudit, logAdminActionOrRecord } from '@/lib/admin/audit'
import { REFUND_HOLD_MIN_RELEASE_AGE_MS } from '@/lib/licensing/licenceRefundHold'
import { evaluateAttemptEvidence } from '@/lib/donations/refundAttemptEvidence'
import type { AdminAuditAction } from '@/lib/admin/auditConstants'
import { planDonationReversal } from '@/lib/donations/reversalMath'
import { readOpenPayoutRequests, planPayoutRefit, stagePayoutReviews } from '@/lib/settlements/payoutReview'
import type { OrganizerRevenueWallet, FeeModel } from '@/lib/fees/types'
import type { PlatformTransactionDocument } from '@/lib/fees/types'
import type {
  DonationDocument,
  DonationRefundDocument,
  DonationRefundStatus,
  DonationRefundAccountingRecovery,
  DonationRefundAccountingState,
  DonationRefundAttempt,
  DonationRefundAttemptStatus,
} from '@/lib/donations/types'

const refundsCol = () => adminDb.collection('donationRefunds')

export { proportionalReversal, planDonationReversal } from '@/lib/donations/reversalMath'

/** Reversal rows read per donation before the accounting refuses (fail closed) rather than guess. */
const MAX_REVERSAL_ROWS = 200

/**
 * The fee model a reversal ledger entry records — the ORIGINAL transaction's canonical
 * feeModel, never a hardcoded value (RD-PAYMENT-02 Phase 5 / CERT-D5). Legacy transactions
 * that predate the stored field fall back to organizer_pays, so their reversal is
 * byte-identical to the previous hardcode.
 */
export function reversalFeeModel(
  origPtx: Pick<PlatformTransactionDocument, 'feeModel'> | null | undefined,
): FeeModel {
  return origPtx?.feeModel ?? 'organizer_pays'
}

// ─── Record creation (idempotent by refundId) ────────────────────────────────

export interface CreateRefundRecordInput {
  refundId:          string   // Razorpay refund id (doc key)
  donationId:        string
  campaignId:        string
  campaignSlug:      string
  organizerUid:      string
  razorpayPaymentId: string
  amountPaise:       number
  reason:            string
  initiatedBy:       string
  status?:           DonationRefundStatus
}

/**
 * Creates the donationRefunds/{refundId} record if absent (immutable thereafter).
 * Returns whether it was newly created. Both the organizer path and the webhook
 * call this; the deterministic refundId key makes it idempotent.
 */
export async function ensureRefundRecord(input: CreateRefundRecordInput): Promise<{ created: boolean }> {
  const ref = refundsCol().doc(input.refundId)
  return adminDb.runTransaction(async tx => {
    const snap = await tx.get(ref)
    if (snap.exists) return { created: false }
    const doc: DonationRefundDocument = {
      id:                input.refundId,
      donationId:        input.donationId,
      campaignId:        input.campaignId,
      campaignSlug:      input.campaignSlug,
      organizerUid:      input.organizerUid,
      razorpayRefundId:  input.refundId,
      razorpayPaymentId: input.razorpayPaymentId,
      amountPaise:       input.amountPaise,
      reason:            input.reason,
      status:            input.status ?? 'pending',
      initiatedBy:       input.initiatedBy,
      createdAt:         FieldValue.serverTimestamp(),
    }
    tx.set(ref, doc)
    return { created: true }
  })
}

// ─── Reservation (local race-safety; Razorpay is the hard cap) ────────────────

export interface ReserveResult {
  ok:         boolean
  reason?:    'NOT_SUCCESSFUL' | 'EXCEEDS_BALANCE' | 'NOT_FOUND'
  refundable: number
}

/**
 * Transactionally reserves `amountPaise` against the donation's refundable
 * balance (gross − refunded − pending) so concurrent organizer refunds can't
 * locally over-refund before the gateway confirms. Released on Razorpay failure;
 * converted to `refunded` when accounting is applied.
 */
export async function reserveRefund(donationId: string, amountPaise: number): Promise<ReserveResult> {
  const ref = adminDb.collection('donations').doc(donationId)
  return adminDb.runTransaction(async tx => {
    const snap = await tx.get(ref)
    if (!snap.exists) return { ok: false, reason: 'NOT_FOUND' as const, refundable: 0 }
    const d = snap.data() as DonationDocument
    if (d.status !== 'successful') return { ok: false, reason: 'NOT_SUCCESSFUL' as const, refundable: 0 }
    const refundable = d.amountPaise - (d.refundedAmountPaise ?? 0) - (d.pendingRefundPaise ?? 0)
    if (amountPaise > refundable) return { ok: false, reason: 'EXCEEDS_BALANCE' as const, refundable }
    tx.update(ref, { pendingRefundPaise: FieldValue.increment(amountPaise), updatedAt: FieldValue.serverTimestamp() })
    return { ok: true, refundable }
  })
}

export async function releaseReservation(donationId: string, amountPaise: number): Promise<void> {
  await adminDb.collection('donations').doc(donationId)
    .update({ pendingRefundPaise: FieldValue.increment(-amountPaise), updatedAt: FieldValue.serverTimestamp() })
    .catch(err => captureFinancialError(err, { scope: 'refundService.releaseReservation_failed', donationId, amountPaise }))
}

// ─── Accounting (idempotent, exactly-once via refund status) ──────────────────

export interface ApplyResult {
  applied:       boolean
  fullRefund:    boolean
  reversedPaise: number
  insolvent:     boolean
}

/**
 * Applies all financial side effects of a refund EXACTLY ONCE, gated on the
 * donationRefunds/{refundId} status inside one transaction:
 *   - proportional revenue-wallet debit from the bucket holding the ORIGINAL donation's
 *     net (pending, or available once released — never the other bucket; clamped, the
 *     shortfall a clawback; inTransit invariant preserved; no over/double-debit). An
 *     unknown original releaseStatus fails closed before any write.
 *   - reversal ledger entry linked to the original transaction
 *   - counter reconciliation (totalRaisedPaise always; donationCount/donorCount
 *     only on full refund, donorCount only if the donor has no other successful
 *     donation to the campaign)
 *   - donation refundedAmountPaise / pendingRefundPaise; status→refunded on full
 *   - receipt status→refunded on full refund
 *   - a PARTIAL refund of an unreleased donation puts its original ledger row on the settlement
 *     refund hold (releaseStatus 'held' + releaseHold) — never released automatically; a later
 *     full refund closes that hold (evidence kept in releaseHoldHistory)
 * Safe under organizer + webhook + retry concurrency.
 */
export async function applyDonationRefundAccounting(refundId: string): Promise<ApplyResult> {
  const refundRef = refundsCol().doc(refundId)
  // Clawback recorded atomically inside the txn (insolvent reversal); audited after.
  let clawbackInfo: { clawbackId: string; outstandingPaise: number } | null = null
  let refundOrganizerUid = ''   // captured from the committed refund for the post-commit webhook
  let refundDonationId = ''     // captured for the CRM refund activity
  let refundAmountPaise = 0
  // M1 — payout requests this reversal sent to review (in the transaction; reported after commit).
  let payoutReviewed: string[] = []

  const result = await adminDb.runTransaction(async tx => {
    clawbackInfo = null
    payoutReviewed = []
    // ── reads (all before writes) ──
    const refundSnap = await tx.get(refundRef)
    if (!refundSnap.exists) throw new Error(`refund_not_found:${refundId}`)
    const refund = refundSnap.data() as DonationRefundDocument
    refundOrganizerUid = refund.organizerUid
    refundDonationId = refund.donationId
    refundAmountPaise = refund.amountPaise
    if (refund.status === 'processed') {
      return { applied: false, fullRefund: refund.isFullRefund ?? false, reversedPaise: refund.ledgerReversedPaise ?? 0, insolvent: refund.insolvent ?? false }
    }
    // Phase 2.1 — the gateway reported this refund FAILED: it is never accounted as a success. A success
    // signal arriving for it is a contradiction for a human (fails closed, before any write).
    if (refund.status === 'failed') throw new Error(`REFUND_FAILED_AT_GATEWAY:${refundId}`)
    // Phase 3.3 (verification) — the gateway reported CONTRADICTORY outcomes for this refund: it is never
    // accounted on a later signal (a redelivered refund.processed, the sweep, the organizer route) — that would
    // settle the contradiction automatically. Fails closed before any write; a Super Admin decides.
    if (refund.accountingRecovery?.conflict) throw new Error(`REFUND_OUTCOME_CONFLICT:${refundId}:${refund.accountingRecovery.conflict}`)
    // Phase 3.4 — a refund whose accounting was COMPENSATED (confirmed failed after it was accounted) is never
    // accounted again: re-reversing it would debit the wallet a second time against the same reversal row.
    if (refund.compensation) throw new Error(`REFUND_COMPENSATED:${refundId}`)

    const donationRef = adminDb.collection('donations').doc(refund.donationId)
    const counterRef  = adminDb.collection('donationCounters').doc(refund.campaignSlug)
    const walletRef   = adminDb.collection('organizerRevenueWallets').doc(refund.organizerUid)
    const origPtxRef  = adminDb.collection('platformTransactions').doc(`ptx_${refund.donationId}`)

    const [donationSnap, walletSnap, origPtxSnap] = await Promise.all([
      tx.get(donationRef), tx.get(walletRef), tx.get(origPtxRef),
    ])
    if (!donationSnap.exists) throw new Error(`donation_not_found:${refund.donationId}`)
    const donation = donationSnap.data() as DonationDocument

    const origPtx      = origPtxSnap.exists ? (origPtxSnap.data() as PlatformTransactionDocument) : null
    const gross        = donation.amountPaise
    const origNet      = origPtx?.netSettlementPaise ?? 0
    const refundAmount = refund.amountPaise
    // Phase 3.3 — the net already reversed, from the AUTHORITATIVE reversal rows of this donation (read in
    // this transaction; concurrent refunds of the donation serialise on the donation document they both
    // write). The reversal is then cumulatively exact (planDonationReversal).
    const priorRows = await tx.get(adminDb.collection('platformTransactions')
      .where('parentTransactionId', '==', `ptx_${refund.donationId}`).limit(MAX_REVERSAL_ROWS + 1))
    if (priorRows.size > MAX_REVERSAL_ROWS) throw new Error(`REFUND_HISTORY_TOO_LARGE:${refund.donationId}`)
    // Signed: a reversal row is negative (adds to what is reversed); a Phase 3.4 compensating entry is positive
    // (cancels the reversal it compensates).
    const alreadyReversedNet = priorRows.docs.reduce((sum, d) => {
      if (d.id === `ptx_refund_${refundId}`) return sum   // never this refund's own row
      const v = d.get('netSettlementPaise')
      return sum - (typeof v === 'number' && Number.isFinite(v) ? v : 0)
    }, 0)
    const reversalPlan = planDonationReversal({
      grossPaise: gross, netPaise: origNet, alreadyRefundedGrossPaise: donation.refundedAmountPaise ?? 0,
      refundGrossPaise: refundAmount, alreadyReversedNetPaise: alreadyReversedNet,
    })
    const reversalNet  = reversalPlan.reversalNetPaise
    // F.5: the reversal carries the ORIGINAL transaction's plan tier — the refund
    // reverses HISTORICAL stored fee values, never the organizer's current plan.
    const origPlanTier    = origPtx?.planTier    ?? 'starter'
    const origFeeConfigId = origPtx?.feeConfigId ?? 'fallback'
    // RD-PAYMENT-02 Phase 5 (CERT-D5): the reversal records the ORIGINAL transaction's fee
    // model — never a hardcoded 'organizer_pays'. Read from the parent ledger's persisted
    // feeModel (the canonical value Phase 2 writes). Legacy transactions without a stored
    // feeModel default to organizer_pays, so their reversal stays byte-identical to today.
    const origFeeModel    = reversalFeeModel(origPtx)

    const alreadyRefunded = donation.refundedAmountPaise ?? 0
    const fullRefund      = alreadyRefunded + refundAmount >= gross

    // Donor-dedup read (only needed for full refunds) — counts OTHER successful
    // donations by this donor to the campaign.
    let donorHasOther = false
    if (fullRefund) {
      const others = await tx.get(
        adminDb.collection('donations')
          .where('campaignSlug', '==', donation.campaignSlug)
          .where('donorEmail',   '==', donation.donorEmail)
          .where('status',       '==', 'successful'),
      )
      donorHasOther = others.docs.some(d => d.id !== refund.donationId)
    }

    // ── wallet debit (proportional, clamped, invariant-preserving) ──
    let reversedPaise = 0
    let insolvent     = false
    // The bucket holding the ORIGINAL donation's net, from its releaseStatus read in this transaction.
    // Unknown ⇒ fail closed before any write (the refund stays unprocessed; the webhook redelivers).
    const bucket = reversalNet > 0 ? walletBucketForRelease(origPtx?.releaseStatus) : null
    if (reversalNet > 0 && !bucket) throw new Error(`REVERSAL_BUCKET_UNKNOWN:ptx_${refund.donationId}:${String(origPtx?.releaseStatus)}`)
    if (walletSnap.exists && reversalNet > 0 && bucket) {
      const wallet = walletSnap.data() as OrganizerRevenueWallet
      const plan   = computeReversalDebit(wallet, reversalNet, bucket)
      reversedPaise = plan.totalDebited
      insolvent     = plan.totalDebited < reversalNet
      const newAvailable = wallet.availablePaise - plan.fromAvailable
      let newInTransit = Math.min(wallet.inTransitPaise ?? 0, newAvailable)  // invariant
      // M1 — the same payout review as a registration refund, in THIS transaction (read before any write):
      // requests the refund leaves unbacked are held for review; inTransit becomes the reservations kept.
      // M1.1 — whenever the refund takes money from AVAILABLE (a drifted inTransit must not hide unbacked requests).
      if (plan.fromAvailable > 0) {
        const requests = await readOpenPayoutRequests(tx, refund.organizerUid)
        const refit = planPayoutRefit(requests, newAvailable)
        if (refit.toReview.length > 0) {
          stagePayoutReviews(tx, { organizerUid: refund.organizerUid, availablePaise: newAvailable, trigger: { kind: 'donation_refund', ref: refundId }, plan: refit })
          newInTransit = refit.keptPaise
          payoutReviewed = refit.toReview.map(r => r.id)
        }
      }
      tx.update(walletRef, {
        pendingPaise:   wallet.pendingPaise - plan.fromPending,
        availablePaise: newAvailable,
        inTransitPaise: newInTransit,
        updatedAt:      FieldValue.serverTimestamp(),
      })
    } else {
      insolvent = reversalNet > 0  // no wallet to debit against
    }

    // Durable clawback for any under-debit on this proportional reversal — atomic
    // with the wallet debit + reversal ledger. Keyed on the reversal ledger id.
    if (insolvent) {
      clawbackInfo = writeClawbackOnShortfall(tx, {
        transactionId:       `ptx_refund_${refundId}`,
        organizerUid:        refund.organizerUid,
        sourceType:          'donation',
        sourceId:            refund.donationId,
        reversalAmountPaise: reversalNet,
        debitedPaise:        reversedPaise,
        reason:              'refund',
      })
    }

    // ── reversal ledger entry (linked, idempotent doc id) ──
    tx.set(adminDb.collection('platformTransactions').doc(`ptx_refund_${refundId}`), {
      id:                  `ptx_refund_${refundId}`,
      type:                'donation',
      category:            'donation',
      organizerUid:        refund.organizerUid,
      entityId:            donation.campaignSlug,
      entityType:          'campaign',
      sourceId:            refund.donationId,
      sourceType:          'donation',
      payerName:           donation.isAnonymous ? 'Anonymous' : donation.donorName,
      payerEmail:          donation.donorEmail,
      grossAmountPaise:        -refundAmount,
      platformFeeBasePaise:    0,
      platformFeeGstPaise:     0,
      platformFeeTotalPaise:   0,
      gatewayFeeEstimatePaise: 0,
      netSettlementPaise:      -reversalNet,
      feeModel:            origFeeModel,
      planTier:            origPlanTier,
      feeConfigId:         origFeeConfigId,
      currency:            'INR',
      gateway:             'razorpay',
      gatewayPaymentId:    refund.razorpayPaymentId,
      gatewayOrderId:      donation.razorpayOrderId ?? '',
      status:              'refunded',
      parentTransactionId: `ptx_${refund.donationId}`,
      refundId,
      // Preserve the ORIGINAL transaction's canonical breakdown (financialVersion +
      // feeModel + fee split) on the reversal for auditability. Absent for legacy
      // transactions that predate the financials field — reversal stays as today.
      ...(origPtx?.financials ? { financials: origPtx.financials } : {}),
      paidAt:              FieldValue.serverTimestamp(),
      createdAt:           FieldValue.serverTimestamp(),
      updatedAt:           FieldValue.serverTimestamp(),
    } satisfies PlatformTransactionDocument)

    // ── counter reconciliation ──
    const counterUpdate: Record<string, unknown> = {
      campaignSlug:     donation.campaignSlug,
      totalRaisedPaise: FieldValue.increment(-refundAmount),  // gross reduces public raised
      updatedAt:        FieldValue.serverTimestamp(),
    }
    if (fullRefund) {
      counterUpdate.donationCount = FieldValue.increment(-1)
      if (!donorHasOther) counterUpdate.donorCount = FieldValue.increment(-1)
    }
    tx.set(counterRef, counterUpdate, { merge: true })

    // ── donation: finalize reservation → refunded; flip status on full ──
    // Phase 3.3 — only a refund that RESERVED its amount (a RegisterDesk request: initiatedBy is the
    // requester) consumes the reservation. A gateway-originated refund ('webhook', e.g. a Razorpay
    // dashboard refund) never reserved anything, so it must not release another request's reservation.
    // Phase 3.4 — a refund whose reservation was already released (it was recorded failed first) does not
    // release one again: that would consume another request's reservation.
    const ownsReservation = refund.initiatedBy !== 'webhook' && refund.reservationReleased !== true
    const donationUpdate: Record<string, unknown> = {
      refundedAmountPaise: FieldValue.increment(refundAmount),
      ...(ownsReservation ? { pendingRefundPaise: FieldValue.increment(-Math.min(refundAmount, donation.pendingRefundPaise ?? 0)) } : {}),
      updatedAt:           FieldValue.serverTimestamp(),
    }
    if (fullRefund) {
      donationUpdate.status        = 'refunded'
      donationUpdate.paymentStatus = 'refunded'
    }
    tx.update(donationRef, donationUpdate)

    // ── receipt: mark refunded on FULL refund (stays valid on partial) ──
    if (fullRefund && donation.receiptId) {
      tx.update(adminDb.collection('donationReceipts').doc(donation.receiptId), {
        status:     'refunded',
        refundedAt: FieldValue.serverTimestamp(),
      })
    }

    // ── original payment doc refund metadata ──
    if (donation.donationPaymentId) {
      tx.update(adminDb.collection('donationPayments').doc(donation.donationPaymentId), {
        refundId,
        refundStatus:      'processed',
        refundAmountPaise: FieldValue.increment(refundAmount),
        ...(fullRefund ? { status: 'refunded' } : {}),
        updatedAt:         FieldValue.serverTimestamp(),
      })
    }

    // ── original ledger: settlement hold on a PARTIAL refund; flip to refunded on full refund ──
    // A partial refund leaves the original row 'completed' with its FULL net, and the release job
    // moves that full net — so an UNRELEASED donation that is partially refunded is put on the
    // existing settlement refund hold (releaseStatus 'held' + releaseHold, the same shape the
    // registration path uses): the release job never takes it, and it stays held until a Super
    // Admin resolves it. A donation already released is not held (its reversal debited available).
    const origHold = origPtx?.releaseHold as { source?: unknown } | undefined
    const origUnreleased = origPtx?.releaseStatus === 'pending' || origPtx?.releaseStatus === 'held'
    if (!fullRefund && origPtxSnap.exists && origPtx?.status === 'completed' && origUnreleased) {
      tx.update(origPtxRef, {
        releaseStatus:              'held',
        'releaseHold.reason':       'refund_review',
        'releaseHold.source':       'donation_partial_refund',
        'releaseHold.refundIds':    FieldValue.arrayUnion(refundId),
        ...(origPtx?.releaseHold ? {} : { 'releaseHold.heldAt': FieldValue.serverTimestamp() }),
        updatedAt:                  FieldValue.serverTimestamp(),
      })
    }
    if (fullRefund && origPtxSnap.exists) {
      // Fully refunded: nothing is left to settle, so a partial-refund hold has nothing to protect
      // (as for a fully refunded registration). It is closed with its evidence kept in
      // releaseHoldHistory; the row is 'refunded', which the release job never takes.
      const closeHold = origHold?.source === 'donation_partial_refund' || origHold?.source === DONATION_ACCOUNTING_HOLD_SOURCE
        || origHold?.source === DONATION_OUTCOME_PENDING_HOLD_SOURCE || origHold?.source === DONATION_OUTCOME_UNKNOWN_HOLD_SOURCE
        || origHold?.source === DONATION_OUTCOME_CONFLICT_HOLD_SOURCE
      tx.update(origPtxRef, {
        status: 'refunded',
        ...(closeHold ? {
          releaseHold: FieldValue.delete(),
          ...(origPtx?.releaseStatus === 'held' ? { releaseStatus: 'pending' } : {}),
          [`releaseHoldHistory.full_refund_${refundId}`]: {
            hold: origPtx?.releaseHold ?? null, outcome: 'closed_full_refund', by: 'system:donation_full_refund',
            at: FieldValue.serverTimestamp(),
            evidence: { grossPaise: gross, refundedGrossPaise: alreadyRefunded + refundAmount, ledgerStatus: 'refunded' },
          },
        } : {}),
        updatedAt: FieldValue.serverTimestamp(),
      })
    }

    // ── refund record: processed (exactly-once gate) ──
    tx.update(refundRef, {
      status:              'processed' satisfies DonationRefundStatus,
      isFullRefund:        fullRefund,
      ledgerReversedPaise: reversedPaise,
      insolvent,
      processedAt:         FieldValue.serverTimestamp(),
      // Phase 2 — a refund that was in recovery is COMPLETED in the same commit as its accounting.
      ...(refund.accountingRecovery ? {
        'accountingRecovery.state':       'completed',
        'accountingRecovery.completedAt': FieldValue.serverTimestamp(),
        'accountingRecovery.nextAttemptAt': FieldValue.delete(),
      } : {}),
    })

    return { applied: true, fullRefund, reversedPaise, insolvent }
  })

  // Audit the clawback once the reversal has committed (system actor).
  if (result.applied && clawbackInfo) {
    const info = clawbackInfo as { clawbackId: string; outstandingPaise: number }
    // RD-PHASE4-S4 — awaited (never throws; a failed write is recorded for reconciliation).
    await logClawbackEvent('system', 'clawback.created', info.clawbackId, {
      refundId, outstandingPaise: info.outstandingPaise,
    })
  }
  // M1 — reviews, audit rows and organizer notifications committed WITH the reversal; surfaced for operations.
  if (result.applied && payoutReviewed.length > 0) {
    captureFinancialError(new Error(`payout request(s) held for review after donation refund ${refundId}`), {
      scope: 'applyDonationRefundAccounting.payout_review_opened', refundId, settlementIds: payoutReviewed.join(','),
    })
  }
  // Organizer webhook (fire-and-forget) — only on a real reversal.
  if (result.applied && refundOrganizerUid) {
    void enqueueWebhook(refundOrganizerUid, 'donation.refunded', {
      refundId, fullRefund: result.fullRefund, reversedPaise: result.reversedPaise,
    }).catch(() => {})
    // CRM refund activity (resolves donor email from the donation; idempotent).
    crmRecordRefund({ organizerUid: refundOrganizerUid, donationId: refundDonationId, refundId, amountPaise: refundAmountPaise })
  }
  return result
}

// ─── Phase 2 · durable recovery of a refund's ACCOUNTING (never of the gateway refund) ─────────────
//
// The donation webhook claims its event before handling it and always answers 200, so an accounting
// failure used to be recorded once on the event and never retried; the organizer route swallowed its
// own failure. The refund record (donationRefunds/{refundId}) — already the exactly-once gate of the
// accounting — now also carries `accountingRecovery`, drained by the existing donation-reconciliation
// cron. No new collection, no gateway call: only refunds whose SUCCESS is established by trusted
// evidence (the signed refund.processed webhook, or Razorpay's own 'processed' API response) are
// retried, and only the internal accounting is re-run — through applyDonationRefundAccounting, whose
// transaction re-checks status 'processed', so it can never apply twice.

/** Marks the parent donation's hold placed while accounting is pending (closed by a later full refund). */
export const DONATION_ACCOUNTING_HOLD_SOURCE = 'donation_refund_accounting_pending'
export const DONATION_REFUND_ACCOUNTING_MAX_ATTEMPTS = 5
const ACCOUNTING_BACKOFF_BASE_MS = 5 * 60_000
const ACCOUNTING_BACKOFF_MAX_MS  = 6 * 60 * 60_000

/** Failures no retry can fix: fail closed to needs_review at once. */
export function isPermanentAccountingError(message: string): boolean {
  return /^(REVERSAL_BUCKET_UNKNOWN|donation_not_found|refund_not_found|GATEWAY_EVIDENCE_MISSING|REFUND_FAILED_AT_GATEWAY|REFUND_HISTORY_TOO_LARGE|REFUND_OUTCOME_CONFLICT|REFUND_COMPENSATED)/.test(message)
}
/** Delay before the next attempt after `attempts` failures: 5 min, 10, 20, 40 … capped at 6 h. */
export function accountingBackoffMs(attempts: number): number {
  return Math.min(ACCOUNTING_BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1), ACCOUNTING_BACKOFF_MAX_MS)
}

export type AccountingFailureOutcome = { state: DonationRefundAccountingState; attempts: number }

/**
 * Records that a refund the gateway PROCESSED could not be accounted for. One transaction:
 *   • donationRefunds/{id}.accountingRecovery → `retry` (with backoff) or `needs_review` (a permanent
 *     failure, or MAX attempts reached) — attempts, error, source and timestamps kept as evidence;
 *   • the parent donation's ledger row, while unreleased, goes on the existing settlement refund hold
 *     (as Phase 1 does for a partial refund), so it cannot be released while money that left is
 *     unaccounted. A row already held keeps its hold (the refund id is added).
 * The refund stays `pending` — never marked settled. A refund already `processed` (applied meanwhile)
 * is reported `completed` and nothing else changes. Throws if it cannot record (the caller fails loudly).
 */
export async function recordDonationRefundAccountingFailure(refundId: string, input: {
  gatewayEvidence: 'webhook_refund_processed' | 'api_refund_processed' | null
  error: string
  source: 'webhook' | 'organizer' | 'recovery'
}): Promise<AccountingFailureOutcome> {
  const ref = refundsCol().doc(refundId)
  const error = input.error.slice(0, 500)
  const out = await adminDb.runTransaction<AccountingFailureOutcome & { alert: boolean }>(async tx => {
    const snap = await tx.get(ref)
    if (!snap.exists) throw new Error(`refund_not_found:${refundId}`)
    const rec = snap.data() as DonationRefundDocument
    const prev = rec.accountingRecovery
    if (rec.status === 'processed') {
      if (prev?.conflict) return { state: prev.state, attempts: prev.attempts ?? 0, alert: false }   // a contradiction stays for a human
      if (prev && prev.state !== 'completed') tx.update(ref, { 'accountingRecovery.state': 'completed', 'accountingRecovery.completedAt': FieldValue.serverTimestamp() })
      return { state: 'completed', attempts: prev?.attempts ?? 0, alert: false }
    }
    if (prev?.state === 'needs_review') return { state: 'needs_review', attempts: prev.attempts ?? 0, alert: false }
    const ptxRef = adminDb.collection('platformTransactions').doc(`ptx_${rec.donationId}`)
    const ptxSnap = await tx.get(ptxRef)
    const attempts = (prev?.attempts ?? 0) + 1
    const terminal = isPermanentAccountingError(error) || attempts >= DONATION_REFUND_ACCOUNTING_MAX_ATTEMPTS
    const state: DonationRefundAccountingState = terminal ? 'needs_review' : 'retry'
    const now = FieldValue.serverTimestamp()
    const recovery: DonationRefundAccountingRecovery = {
      state, attempts, lastError: error, lastSource: input.source,
      gatewayEvidence: prev?.gatewayEvidence ?? input.gatewayEvidence,
      firstFailedAt: prev?.firstFailedAt ?? now, lastAttemptAt: now,
      ...(prev?.gatewayStatus !== undefined ? { gatewayStatus: prev.gatewayStatus } : {}),
      ...(terminal ? {} : { nextAttemptAt: Timestamp.fromMillis(Date.now() + accountingBackoffMs(attempts)) }),
    }
    tx.update(ref, { accountingRecovery: recovery })
    const ptx = ptxSnap.exists ? ptxSnap.data() as PlatformTransactionDocument & { releaseHold?: unknown } : null
    if (ptx && ptx.status === 'completed' && (ptx.releaseStatus === 'pending' || ptx.releaseStatus === 'held')) {
      tx.update(ptxRef, {
        releaseStatus:           'held',
        'releaseHold.reason':    'refund_review',
        'releaseHold.refundIds': FieldValue.arrayUnion(refundId),
        ...(ptx.releaseHold ? {} : { 'releaseHold.source': DONATION_ACCOUNTING_HOLD_SOURCE, 'releaseHold.heldAt': now }),
        updatedAt: now,
      })
    }
    return { state, attempts, alert: true }
  })
  if (out.alert) {
    captureFinancialError(new Error(`donation refund accounting ${out.state === 'needs_review' ? 'NEEDS REVIEW' : 'deferred for retry'}: ${error}`), {
      scope: out.state === 'needs_review' ? 'donationRefundAccounting.needs_review' : 'donationRefundAccounting.retry',
      refundId, attempts: out.attempts, source: input.source,
    })
  }
  return { state: out.state, attempts: out.attempts }
}

/** Phase 2.1 — the hold placed while a refund is accepted but its outcome is not yet known. */
export const DONATION_OUTCOME_PENDING_HOLD_SOURCE = 'donation_refund_outcome_pending'

/** In a transaction (after its reads): put an UNRELEASED donation's ledger row on the settlement refund hold. */
function txnHoldDonationSettlement(
  tx: FirebaseFirestore.Transaction, ptxRef: FirebaseFirestore.DocumentReference,
  ptx: (PlatformTransactionDocument & { releaseHold?: unknown }) | null, refundId: string, source: string,
): boolean {
  if (!ptx || ptx.status !== 'completed' || (ptx.releaseStatus !== 'pending' && ptx.releaseStatus !== 'held')) return false
  const now = FieldValue.serverTimestamp()
  tx.update(ptxRef, {
    releaseStatus:           'held',
    'releaseHold.reason':    'refund_review',
    'releaseHold.refundIds': FieldValue.arrayUnion(refundId),
    ...(ptx.releaseHold ? {} : { 'releaseHold.source': source, 'releaseHold.heldAt': now }),
    updatedAt: now,
  })
  return true
}

/**
 * The gateway ACCEPTED the refund but has not reported it processed (organizer path, status ≠
 * 'processed'): its outcome is unresolved, and it could reduce the donation's payable proceeds. In ONE
 * transaction: recorded as `awaiting_gateway` (never accounted from this — only the signed
 * refund.processed webhook accounts it) and, while unreleased, the donation is put on the settlement
 * refund hold, so it cannot be released in the meantime. No-op once processed or already in recovery.
 * Never throws: a failure is alerted (the refund itself already happened at the gateway).
 */
export async function markDonationRefundAwaitingGateway(refundId: string, gatewayStatus: string): Promise<void> {
  const ref = refundsCol().doc(refundId)
  await adminDb.runTransaction(async tx => {
    const snap = await tx.get(ref)
    if (!snap.exists) return
    const rec = snap.data() as DonationRefundDocument
    if (rec.status !== 'pending' || rec.accountingRecovery) return
    const ptxRef = adminDb.collection('platformTransactions').doc(`ptx_${rec.donationId}`)
    const ptxSnap = await tx.get(ptxRef)
    const recovery: DonationRefundAccountingRecovery = { state: 'awaiting_gateway', gatewayStatus: String(gatewayStatus).slice(0, 40), lastAttemptAt: FieldValue.serverTimestamp() }
    tx.update(ref, { accountingRecovery: recovery })
    txnHoldDonationSettlement(tx, ptxRef, ptxSnap.exists ? ptxSnap.data() as PlatformTransactionDocument : null, refundId, DONATION_OUTCOME_PENDING_HOLD_SOURCE)
  }).catch(err => captureFinancialError(err, { scope: 'donationRefundAccounting.awaiting_gateway_mark_failed', refundId }))
}

export type GatewayFailureOutcome = 'recorded' | 'recorded_new' | 'duplicate' | 'conflict'

/**
 * Phase 2.1 — the SIGNED refund.failed event: the gateway reports THIS refund (by its own id) failed.
 * One transaction; never touches the gateway; never accounts anything; never lifts a hold.
 *   pending record (no success evidence) → status 'failed', recovery `gateway_failed`; an organizer
 *        refund's local reservation is released (no money left — the refundable balance is restored)
 *   no record (a refund made outside RegisterDesk) → recorded 'failed' (no reservation to release)
 *   already 'failed'                    → duplicate, nothing changes
 *   'processed', or trusted success evidence already held (recovery `retry`) → CONFLICT: the recorded
 *        outcome is NOT overwritten; flagged needs_review for a human; nothing reversed
 * Any settlement hold stays until a Super Admin resolves it (the evidence-gated lift).
 */
export async function recordDonationRefundGatewayFailure(input: {
  refundId: string; donationId: string; paymentId: string; amountPaise: number; failureReason: string | null
  /** Phase 2.2 — the refund belongs to a RegisterDesk attempt (notes.attemptId) that reserved its amount. */
  attemptBy?: string | null
}): Promise<GatewayFailureOutcome> {
  // Phase 3.1 — one implementation of the outcome rules (recordDonationRefundGatewayOutcome).
  const r = await recordDonationRefundGatewayOutcome({
    donationId: input.donationId, refundId: input.refundId, paymentId: input.paymentId, amountPaise: input.amountPaise,
    gatewayStatus: 'failed', evidence: 'webhook_refund_processed', source: 'webhook', failureReason: input.failureReason,
    initiatedBy: input.attemptBy ?? 'webhook',
  })
  return r.record === 'created' ? 'recorded_new' : r.record === 'updated' ? 'recorded' : r.record === 'conflict' ? 'conflict' : 'duplicate'
}

/** A refund applied by another worker: close its recovery state (idempotent). */
async function markAccountingCompletedIfProcessed(refundId: string): Promise<boolean> {
  const ref = refundsCol().doc(refundId)
  return adminDb.runTransaction(async tx => {
    const snap = await tx.get(ref)
    if (!snap.exists) return false
    const rec = snap.data() as DonationRefundDocument
    if (rec.status !== 'processed') return false
    if (rec.accountingRecovery?.conflict) return true                     // applied, but a contradiction stays for a human
    if (rec.accountingRecovery && rec.accountingRecovery.state !== 'completed') {
      tx.update(ref, { 'accountingRecovery.state': 'completed', 'accountingRecovery.completedAt': FieldValue.serverTimestamp(), 'accountingRecovery.nextAttemptAt': FieldValue.delete() })
    }
    return true
  })
}

export interface DonationAccountingRetryResult { scanned: number; completed: number; deferred: number; retrying: number; needsReview: number }
const DONATION_DRAIN_PAGE = 100
const DONATION_DRAIN_SCAN_CAP = 2_000

/**
 * The donation-reconciliation cron's drain: re-runs the ACCOUNTING of refunds in `retry` whose backoff
 * has elapsed. Never calls the gateway. Safe to run concurrently and repeatedly: the accounting
 * transaction re-checks `processed`, so two workers can never both apply; a worker that loses records
 * the refund completed. A failure counts an attempt (bounded; then needs_review, alerted). A record
 * without trusted gateway evidence is never accounted — it is escalated to needs_review.
 */
export async function retryDonationRefundAccounting(limitN = 50): Promise<DonationAccountingRetryResult> {
  // Phase 3.3 — page through the retry set in document-id order (equality + __name__: no composite index)
  // and take up to limitN DUE records, so records still backing off can never fill the batch and starve
  // due ones behind them. Bounded by DONATION_DRAIN_SCAN_CAP reads per run.
  const due: FirebaseFirestore.QueryDocumentSnapshot[] = []
  const out: DonationAccountingRetryResult = { scanned: 0, completed: 0, deferred: 0, retrying: 0, needsReview: 0 }
  const now = Date.now()
  let cursor: string | null = null
  while (due.length < limitN && out.scanned < DONATION_DRAIN_SCAN_CAP) {
    let q = refundsCol().where('accountingRecovery.state', '==', 'retry').orderBy(FieldPath.documentId())
    if (cursor) q = q.startAfter(cursor)
    const page = await q.limit(DONATION_DRAIN_PAGE).get()
    for (const doc of page.docs) {
      out.scanned++
      const next = (doc.data() as DonationRefundDocument).accountingRecovery?.nextAttemptAt as { toMillis?: () => number } | undefined
      if (next?.toMillis && next.toMillis() > now) out.deferred++
      else if (due.length < limitN) due.push(doc)
    }
    if (page.size < DONATION_DRAIN_PAGE) break
    cursor = page.docs[page.docs.length - 1].id
  }
  for (const doc of due) {
    const rec = doc.data() as DonationRefundDocument
    const evidence = rec.accountingRecovery?.gatewayEvidence
    try {
      if (evidence !== 'webhook_refund_processed' && evidence !== 'api_refund_processed') {
        throw new Error('GATEWAY_EVIDENCE_MISSING: no trusted proof the gateway processed this refund')
      }
      const r = await applyDonationRefundAccounting(doc.id)
      if (!r.applied) await markAccountingCompletedIfProcessed(doc.id)
      out.completed++
    } catch (err) {
      try {
        const f = await recordDonationRefundAccountingFailure(doc.id, {
          gatewayEvidence: evidence ?? null, error: err instanceof Error ? err.message : 'accounting_failed', source: 'recovery',
        })
        if (f.state === 'needs_review') out.needsReview++
        else if (f.state === 'completed') out.completed++
        else out.retrying++
      } catch (e) {
        captureFinancialError(e, { scope: 'donationRefundAccounting.record_failed', refundId: doc.id })
        out.retrying++
      }
    }
  }
  return out
}

// ─── Phase 2.2 · gateway refund ATTEMPTS — an outcome that is not known is never treated as "no refund" ───
//
// Razorpay's refund API has no idempotency key (lib/licensing/licenceRefundHold.ts, H1), and a request can
// fail after the refund was created. So every gateway refund REQUEST is recorded on the donation BEFORE the
// call, keyed by an attempt id that is also sent in the refund's notes (Razorpay echoes notes on the
// refund entity — in the webhook and in the refund list). In the SAME transaction the unreleased donation
// is put on the settlement refund hold, so it can never be released while a request is in flight or
// unresolved. Outcomes:
//   linked        — the refund id is known (API response, webhook notes, or the refund list's notes)
//   rejected      — a structured 4xx gateway response (isDefinitiveGatewayRejection): no refund exists;
//                   the reservation is freed, and the hold placed for THIS attempt alone is removed
//   unknown       — anything else (timeout, network, 5xx…): reservation KEPT, hold KEPT
//   resolved_none — only through the Super Admin lift (≥ REFUND_HOLD_MIN_RELEASE_AGE_MS old AND Razorpay
//                   shows no live refund on the payment — PD-2)
// At most one attempt per donation may be open: a second refund request is refused until it resolves,
// so a retry can never create a second gateway refund.

export const DONATION_OUTCOME_UNKNOWN_HOLD_SOURCE = 'donation_refund_outcome_unknown'
/** Phase 3.3 (verification) — the hold placed when the gateway reports contradictory outcomes for a refund. */
export const DONATION_OUTCOME_CONFLICT_HOLD_SOURCE = 'donation_refund_outcome_conflict'
const OPEN_ATTEMPT: ReadonlySet<string> = new Set(['submitting', 'unknown'])
const hasOpen = (attempts: Record<string, DonationRefundAttempt> | undefined, except?: string): boolean =>
  Object.entries(attempts ?? {}).some(([id, a]) => id !== except && OPEN_ATTEMPT.has(a?.status))

export type BeginAttemptResult = { ok: true } | { ok: false; code: 'REFUND_ATTEMPT_UNRESOLVED' | 'NOT_FOUND' }

/**
 * Records a gateway refund attempt BEFORE the gateway is called and holds the unreleased donation, in
 * ONE transaction. Refused while another attempt of the donation is open. If this throws, nothing was
 * written and the gateway must NOT be called (a confirmed pre-submission failure).
 */
export async function beginDonationRefundAttempt(input: {
  donationId: string; attemptId: string; amountPaise: number; paymentId: string; by: string
}): Promise<BeginAttemptResult> {
  const donationRef = adminDb.collection('donations').doc(input.donationId)
  const ptxRef = adminDb.collection('platformTransactions').doc(`ptx_${input.donationId}`)
  return adminDb.runTransaction<BeginAttemptResult>(async tx => {
    const [dSnap, ptxSnap] = await Promise.all([tx.get(donationRef), tx.get(ptxRef)])
    if (!dSnap.exists) return { ok: false, code: 'NOT_FOUND' }
    const d = dSnap.data() as DonationDocument
    if (hasOpen(d.refundAttempts)) return { ok: false, code: 'REFUND_ATTEMPT_UNRESOLVED' }
    const now = FieldValue.serverTimestamp()
    const attempt: DonationRefundAttempt = { status: 'submitting', amountPaise: input.amountPaise, paymentId: input.paymentId, by: input.by, startedAt: now }
    tx.update(donationRef, { [`refundAttempts.${input.attemptId}`]: attempt, hasOpenRefundAttempt: true, updatedAt: now })
    const ptx = ptxSnap.exists ? ptxSnap.data() as PlatformTransactionDocument & { releaseHold?: unknown } : null
    if (ptx && ptx.status === 'completed' && (ptx.releaseStatus === 'pending' || ptx.releaseStatus === 'held')) {
      tx.update(ptxRef, {
        releaseStatus:            'held',
        'releaseHold.reason':     'refund_review',
        'releaseHold.attemptIds': FieldValue.arrayUnion(input.attemptId),
        ...(ptx.releaseHold ? {} : { 'releaseHold.source': DONATION_OUTCOME_UNKNOWN_HOLD_SOURCE, 'releaseHold.refundIds': [], 'releaseHold.heldAt': now }),
        updatedAt: now,
      })
    }
    return { ok: true }
  })
}

export type SettleAttemptOutcome =
  | { kind: 'linked'; refundId: string }
  | { kind: 'rejected'; error: string }
  | { kind: 'unknown'; error: string }

/**
 * Records the outcome of an attempt, in ONE transaction (idempotent; only an OPEN attempt moves —
 * a resolved attempt is never overwritten, and a link to a DIFFERENT refund id is refused):
 *   linked   → refund id recorded; the id joins the donation's hold (the refund's own outcome now governs)
 *   rejected → reservation freed; the attempt leaves the hold, and a hold that held ONLY this attempt
 *              (placed by beginDonationRefundAttempt, nothing else in it) is removed — a 4xx proves no refund
 *   unknown  → reservation and hold KEPT
 * Returns false when nothing changed.
 */
export async function settleDonationRefundAttempt(donationId: string, attemptId: string, outcome: SettleAttemptOutcome): Promise<boolean> {
  const donationRef = adminDb.collection('donations').doc(donationId)
  const ptxRef = adminDb.collection('platformTransactions').doc(`ptx_${donationId}`)
  const changed = await adminDb.runTransaction<boolean | 'conflict'>(async tx => {
    const [dSnap, ptxSnap] = await Promise.all([tx.get(donationRef), tx.get(ptxRef)])
    if (!dSnap.exists) return false
    const d = dSnap.data() as DonationDocument
    const a = d.refundAttempts?.[attemptId]
    if (!a) return false
    if (a.status === 'linked') return outcome.kind === 'linked' && a.refundId !== outcome.refundId ? 'conflict' : false
    if (!OPEN_ATTEMPT.has(a.status)) return false
    if (outcome.kind === 'unknown' && a.status === 'unknown') return false
    const now = FieldValue.serverTimestamp()
    const status: DonationRefundAttemptStatus = outcome.kind
    const stillOpen = status === 'unknown' || hasOpen(d.refundAttempts, attemptId)
    tx.update(donationRef, {
      [`refundAttempts.${attemptId}.status`]: status,
      ...(outcome.kind === 'linked' ? { [`refundAttempts.${attemptId}.refundId`]: outcome.refundId } : { [`refundAttempts.${attemptId}.error`]: outcome.error.slice(0, 300) }),
      ...(status !== 'unknown' ? { [`refundAttempts.${attemptId}.resolvedAt`]: now } : {}),
      // a definitive rejection created no refund: its reservation is freed
      ...(outcome.kind === 'rejected' ? { pendingRefundPaise: FieldValue.increment(-Math.min(a.amountPaise, d.pendingRefundPaise ?? 0)) } : {}),
      hasOpenRefundAttempt: stillOpen,
      updatedAt: now,
    })
    const ptx = ptxSnap.exists ? ptxSnap.data() as { releaseStatus?: unknown; releaseHold?: { attemptIds?: unknown; refundIds?: unknown; source?: unknown } } : null
    const hold = ptx?.releaseHold
    const holdsAttempt = Array.isArray(hold?.attemptIds) && (hold!.attemptIds as unknown[]).includes(attemptId)
    if (hold && holdsAttempt) {
      if (outcome.kind === 'linked') {
        // The refund id is now known: an in-flight hold becomes the Phase 2.1 "outcome pending" hold, and
        // the refund's own outcome governs it from here (partial → manual review; full → closed; failed → kept).
        tx.update(ptxRef, {
          'releaseHold.refundIds': FieldValue.arrayUnion(outcome.refundId),
          ...(hold.source === DONATION_OUTCOME_UNKNOWN_HOLD_SOURCE ? { 'releaseHold.source': DONATION_OUTCOME_PENDING_HOLD_SOURCE } : {}),
          updatedAt: now,
        })
      } else if (outcome.kind === 'rejected') {
        const others = (hold.attemptIds as unknown[]).filter(x => x !== attemptId)
        const refundIds = Array.isArray(hold.refundIds) ? hold.refundIds : []
        if (hold.source === DONATION_OUTCOME_UNKNOWN_HOLD_SOURCE && others.length === 0 && refundIds.length === 0) {
          tx.update(ptxRef, {
            releaseHold: FieldValue.delete(),
            ...(ptx?.releaseStatus === 'held' ? { releaseStatus: 'pending' } : {}),
            [`releaseHoldHistory.attempt_rejected_${attemptId}`]: { hold, outcome: 'attempt_rejected', by: 'system:gateway_rejection', at: now, evidence: { error: outcome.error.slice(0, 300) } },
            updatedAt: now,
          })
        } else {
          tx.update(ptxRef, { 'releaseHold.attemptIds': FieldValue.arrayRemove(attemptId), updatedAt: now })
        }
      }
    }
    return true
  })
  if (changed === 'conflict') {
    captureFinancialError(new Error('refund attempt already linked to a different refund'), { scope: 'donationRefundAttempt.link_conflict', donationId, attemptId })
    return false
  }
  if (changed && outcome.kind === 'unknown') {
    captureFinancialError(new Error(`donation refund outcome UNKNOWN: ${outcome.error}`), { scope: 'donationRefundAttempt.unknown', donationId, attemptId })
  }
  return changed
}

/** The attempt (if any) a signed gateway refund entity names in its notes, and whether it owns a reservation. */
export async function attemptForRefund(donationId: string, attemptId: string | null | undefined): Promise<DonationRefundAttempt | null> {
  if (!attemptId || !/^att_[A-Za-z0-9_-]{8,80}$/.test(attemptId)) return null
  const d = await adminDb.collection('donations').doc(donationId).get()
  return (d.data() as DonationDocument | undefined)?.refundAttempts?.[attemptId] ?? null
}

export interface AttemptReconcileResult { scanned: number; linked: number; stillOpen: number; deferred: number }
const ATTEMPT_SWEEP_PAGE = 100
const ATTEMPT_SWEEP_SCAN_CAP = 2_000
/** Delay before re-checking an attempt the refund list did not show: 2 min, 4, 8 … capped at 1 h. */
export function attemptCheckBackoffMs(checks: number): number {
  return Math.min(2 * 60_000 * 2 ** Math.max(0, checks - 1), 60 * 60_000)
}

/**
 * The donation-reconciliation sweep for OPEN attempts (read-only gateway evidence; never creates a
 * refund, never resolves an attempt as "none"): Razorpay's refund list for the payment is searched for a
 * refund whose notes carry the attempt id. Found → the attempt is linked and the refund recorded; its
 * outcome is then applied exactly as Razorpay states it (processed → accounted; failed → recorded failed;
 * otherwise awaiting the gateway). Not found, or the lookup failed → left open (still held, still visible).
 */
export async function reconcileDonationRefundAttempts(limitN = 25, minAgeMs = 2 * 60_000): Promise<AttemptReconcileResult> {
  // Phase 3.3 — limitN bounds the gateway LOOKUPS per run. Donations are paged in document-id order
  // (equality + __name__: no composite index) and an attempt the refund list did not show is re-checked
  // only after a backoff (refundAttempts.{id}.nextCheckAt), so attempts that stay unresolved (until a
  // Super Admin resolves them) can never fill every run and starve the others.
  const out: AttemptReconcileResult = { scanned: 0, linked: 0, stillOpen: 0, deferred: 0 }
  // The gateway client is loaded on the first lookup (as before this change: never when there is nothing to check).
  let gateway: typeof import('@/lib/razorpay/client')['razorpay'] | null = null
  const now = Date.now()
  let lookups = 0
  let cursor: string | null = null
  const noteMiss = (ref: FirebaseFirestore.DocumentReference, attemptId: string, checks: number) =>
    ref.update({
      [`refundAttempts.${attemptId}.checks`]: checks + 1,
      [`refundAttempts.${attemptId}.nextCheckAt`]: Timestamp.fromMillis(Date.now() + attemptCheckBackoffMs(checks + 1)),
    }).catch(err => captureFinancialError(err, { scope: 'donationRefundAttempt.sweep_check_record_failed', donationId: ref.id, attemptId }))
  sweep: while (lookups < limitN && out.scanned < ATTEMPT_SWEEP_SCAN_CAP) {
    let q = adminDb.collection('donations').where('hasOpenRefundAttempt', '==', true).orderBy(FieldPath.documentId())
    if (cursor) q = q.startAfter(cursor)
    const page = await q.limit(ATTEMPT_SWEEP_PAGE).get()
    for (const doc of page.docs) {
      out.scanned++
      const d = doc.data() as DonationDocument
      for (const [attemptId, a] of Object.entries(d.refundAttempts ?? {})) {
        if (!OPEN_ATTEMPT.has(a.status)) continue
        const started = (a.startedAt as { toMillis?: () => number } | undefined)?.toMillis?.() ?? 0
        if (now - started < minAgeMs) { out.stillOpen++; continue }
        const nextCheck = (a.nextCheckAt as { toMillis?: () => number } | undefined)?.toMillis?.()
        if (typeof nextCheck === 'number' && nextCheck > now) { out.deferred++; continue }
        if (lookups >= limitN) break sweep
        lookups++
        const checks = typeof a.checks === 'number' ? a.checks : 0
        let items: Array<{ id?: unknown; status?: unknown; notes?: { attemptId?: unknown } }> = []
        gateway ??= (await import('@/lib/razorpay/client')).razorpay   // a load failure fails the sweep loudly
        try {
          const res = await gateway.payments.fetchMultipleRefund(a.paymentId) as { items?: unknown }
          if (!Array.isArray(res?.items)) { out.stillOpen++; await noteMiss(doc.ref, attemptId, checks); continue }
          items = res.items as typeof items
        } catch { out.stillOpen++; await noteMiss(doc.ref, attemptId, checks); continue }
        const hit = items.find(r => r?.notes?.attemptId === attemptId && typeof r.id === 'string')
        if (!hit) { out.stillOpen++; await noteMiss(doc.ref, attemptId, checks); continue }
        // Phase 3.1 — link + record (+ accounting-pending for a processed refund) in ONE transaction, then account.
        await settleDonationRefundOutcome({
          donationId: doc.id, refundId: hit.id as string, paymentId: a.paymentId, amountPaise: a.amountPaise,
          gatewayStatus: String(hit.status ?? 'unknown'), evidence: 'api_refund_processed', source: 'recovery',
          attemptId, failureReason: hit.status === 'failed' ? 'reported failed by the gateway refund list' : null, reason: 'organizer_initiated',
        })
        out.linked++
      }
    }
    if (page.size < ATTEMPT_SWEEP_PAGE) break
    cursor = page.docs[page.docs.length - 1].id
  }
  return out
}

// ─── Phase 3 · G9 — Super Admin resolution of an UNKNOWN attempt on an already-RELEASED donation ──────
//
// An attempt on a donation whose settlement was already released gets no settlement hold (nothing is
// left to hold), so the hold-review lift can never reach it — it kept its reservation and blocked every
// later refund. This is its own audited Super Admin action, on the SAME evidence rules (PD-2):
//   • the attempt is open and at least REFUND_HOLD_MIN_RELEASE_AGE_MS old (age is necessary, never proof);
//   • Razorpay's refund list for the payment is read successfully (read-only; never a refund request) and
//     classified by evaluateAttemptEvidence:
//       linked        → the attempt is linked to EXACTLY that refund and the refund is handled as the
//                       gateway states it (processed → accounted once; failed → recorded failed; else awaiting)
//       none          → resolved_none in ONE transaction with its audit row; the reservation is freed
//       contradictory / inconclusive / lookup failure → NOTHING changes (reservation and state kept)
// Idempotent: an attempt no longer open is reported, never re-resolved; the audit row id is deterministic.

export type ResolveAttemptResult =
  | { ok: true; outcome: 'resolved_none' | 'linked'; refundId?: string; gatewayStatus?: string; duplicate: boolean }
  | { ok: false; status: number; code: string; error: string; detail?: Record<string, unknown> }

export async function resolveReleasedDonationRefundAttempt(input: {
  donationId: string; attemptId: string; adminUid: string; reason: string; requestId: string
}): Promise<ResolveAttemptResult> {
  const donationRef = adminDb.collection('donations').doc(input.donationId)
  const ptxRef = adminDb.collection('platformTransactions').doc(`ptx_${input.donationId}`)

  // ── preconditions (re-checked inside the transaction for the no-refund outcome) ──
  const [dSnap, ptxSnap] = await Promise.all([donationRef.get(), ptxRef.get()])
  if (!dSnap.exists) return { ok: false, status: 404, code: 'NOT_FOUND', error: 'Donation not found.' }
  const d = dSnap.data() as DonationDocument
  const attempt = d.refundAttempts?.[input.attemptId]
  if (!attempt) return { ok: false, status: 404, code: 'ATTEMPT_NOT_FOUND', error: 'Refund attempt not found.' }
  if (!OPEN_ATTEMPT.has(attempt.status)) {
    if (attempt.status === 'resolved_none' || attempt.status === 'linked') {
      return { ok: true, outcome: attempt.status, ...(attempt.refundId ? { refundId: attempt.refundId } : {}), duplicate: true }
    }
    return { ok: false, status: 409, code: 'ATTEMPT_NOT_OPEN', error: `This attempt is already ${attempt.status}.` }
  }
  const ptx = ptxSnap.exists ? ptxSnap.data() as { releaseStatus?: unknown; releaseHold?: { attemptIds?: unknown } } : null
  const heldHere = Array.isArray(ptx?.releaseHold?.attemptIds) && (ptx!.releaseHold!.attemptIds as unknown[]).includes(input.attemptId)
  if (heldHere) return { ok: false, status: 409, code: 'USE_REFUND_HOLD_REVIEW', error: 'This attempt is on a settlement hold — resolve it through the refund-hold review.' }
  if (ptx?.releaseStatus !== 'released') return { ok: false, status: 409, code: 'NOT_RELEASED', error: 'Only an attempt on an already-released donation is resolved here.' }
  const started = (attempt.startedAt as { toMillis?: () => number } | undefined)?.toMillis?.()
  if (typeof started !== 'number' || Date.now() - started < REFUND_HOLD_MIN_RELEASE_AGE_MS) {
    return { ok: false, status: 409, code: 'ATTEMPT_TOO_RECENT', error: 'The attempt is younger than 15 minutes; its outcome cannot be concluded yet.' }
  }

  // ── authoritative gateway evidence (read-only) ──
  let lookup: unknown
  try {
    const { razorpay } = await import('@/lib/razorpay/client')
    lookup = await razorpay.payments.fetchMultipleRefund(attempt.paymentId)
  } catch {
    return { ok: false, status: 503, code: 'GATEWAY_UNVERIFIED', error: 'Razorpay could not be read. Nothing was changed; try again later.' }
  }
  const recorded = await refundsCol().where('donationId', '==', input.donationId).limit(200).get()
  const evidence = evaluateAttemptEvidence(lookup, input.attemptId, new Set(recorded.docs.map(x => x.id)))
  if (evidence.kind === 'inconclusive') {
    return { ok: false, status: 503, code: 'GATEWAY_UNVERIFIED', error: 'Razorpay\'s refund list could not be read completely. Nothing was changed.', detail: { why: evidence.why } }
  }
  if (evidence.kind === 'contradictory') {
    captureFinancialError(new Error(`refund attempt evidence contradictory: ${evidence.why}`), { scope: 'donationRefundAttempt.g9_contradictory', donationId: input.donationId, attemptId: input.attemptId })
    return { ok: false, status: 409, code: 'CONTRADICTORY_EVIDENCE', error: 'Razorpay\'s refunds for this payment do not establish this attempt\'s outcome. Nothing was changed; reconcile manually.', detail: { why: evidence.why, refundIds: evidence.refundIds } }
  }

  if (evidence.kind === 'linked') {
    // The attempt created a refund: link it to exactly that refund and record the gateway's outcome in ONE
    // transaction (Phase 3.1 — crash-safe: a processed refund is left accounting-pending for the drain).
    const settled = await settleDonationRefundOutcome({
      donationId: input.donationId, refundId: evidence.refundId, paymentId: attempt.paymentId, amountPaise: attempt.amountPaise,
      gatewayStatus: evidence.status, evidence: 'api_refund_processed', source: 'recovery', attemptId: input.attemptId,
      failureReason: evidence.status === 'failed' ? 'reported failed by the gateway refund list' : null, reason: 'organizer_initiated',
    })
    const changed = settled.attempt === 'linked'
    await logAdminActionOrRecord({
      adminUid: input.adminUid, actorRole: 'super_admin', action: 'donation.refund_attempt_linked', entityType: 'donation', entityId: input.donationId,
      reason: input.reason,
      metadata: { attemptId: input.attemptId, refundId: evidence.refundId, gatewayStatus: evidence.status, requestId: input.requestId, linkedNow: changed },
      correlation: { donationId: input.donationId, refundId: evidence.refundId, paymentId: attempt.paymentId },
    })
    return { ok: true, outcome: 'linked', refundId: evidence.refundId, gatewayStatus: evidence.status, duplicate: !changed }
  }

  // evidence.kind === 'none' — conclude "no refund" in ONE transaction with its audit row.
  return adminDb.runTransaction<ResolveAttemptResult>(async tx => {
    const [d2, p2] = await Promise.all([tx.get(donationRef), tx.get(ptxRef)])
    const dd = d2.data() as DonationDocument | undefined
    const a2 = dd?.refundAttempts?.[input.attemptId]
    if (!dd || !a2) return { ok: false, status: 404, code: 'ATTEMPT_NOT_FOUND', error: 'Refund attempt not found.' }
    if (a2.status === 'resolved_none') return { ok: true, outcome: 'resolved_none', duplicate: true }
    if (!OPEN_ATTEMPT.has(a2.status)) return { ok: false, status: 409, code: 'ATTEMPT_STATE_CHANGED', error: `The attempt became ${a2.status} meanwhile. Nothing was changed.` }
    const pp = p2.exists ? p2.data() as { releaseStatus?: unknown; releaseHold?: { attemptIds?: unknown } } : null
    if (pp?.releaseStatus !== 'released' || (Array.isArray(pp?.releaseHold?.attemptIds) && (pp!.releaseHold!.attemptIds as unknown[]).includes(input.attemptId))) {
      return { ok: false, status: 409, code: 'ATTEMPT_STATE_CHANGED', error: 'The donation\'s settlement state changed meanwhile. Nothing was changed.' }
    }
    const now = FieldValue.serverTimestamp()
    const evidenceDoc = { requestId: input.requestId, refundsAtGateway: 'none_for_attempt', listedRefunds: evidence.listedRefunds, minAgeMs: REFUND_HOLD_MIN_RELEASE_AGE_MS, path: 'g9_released_donation' }
    const freed = Math.min(a2.amountPaise, dd.pendingRefundPaise ?? 0)
    tx.update(donationRef, {
      [`refundAttempts.${input.attemptId}.status`]:     'resolved_none',
      [`refundAttempts.${input.attemptId}.resolvedAt`]: now,
      [`refundAttempts.${input.attemptId}.resolvedBy`]: input.adminUid,
      [`refundAttempts.${input.attemptId}.evidence`]:   evidenceDoc,
      pendingRefundPaise: FieldValue.increment(-freed),
      hasOpenRefundAttempt: hasOpen(dd.refundAttempts, input.attemptId),
      updatedAt: now,
    })
    stageAdminAudit(tx, {
      adminUid: input.adminUid, actorRole: 'super_admin', action: 'donation.refund_attempt_resolved_none',
      entityType: 'donation', entityId: input.donationId, reason: input.reason,
      changedFields: ['refundAttempts.status', 'pendingRefundPaise', 'hasOpenRefundAttempt'],
      before: { attemptStatus: a2.status, pendingRefundPaise: dd.pendingRefundPaise ?? 0 },
      after:  { attemptStatus: 'resolved_none', pendingRefundPaise: (dd.pendingRefundPaise ?? 0) - freed },
      metadata: { attemptId: input.attemptId, amountPaise: a2.amountPaise, reservationFreedPaise: freed, ...evidenceDoc },
      correlation: { donationId: input.donationId, paymentId: a2.paymentId },
    }, `donation_refund_attempt_${input.attemptId}`)
    return { ok: true, outcome: 'resolved_none', duplicate: false }
  })
}

// ─── Phase 3.1 · ONE durable step for a gateway refund outcome (crash-safe linking + recording) ─────────
//
// Linking an attempt, creating the refund record and accounting it used to be separate writes: a crash
// between them could leave a linked attempt with no refund record, or a processed refund recorded but
// never accounted and invisible to every sweep. Now ONE transaction (re-reading donation, refund record
// and ledger row) does everything the gateway's outcome establishes:
//   • the attempt that created the refund (notes.attemptId), if open, becomes `linked` to it; a conflicting
//     link is never overwritten (alerted);
//   • processed (trusted evidence: signed webhook / Razorpay API) → the record exists and is marked
//     ACCOUNTING PENDING (`accountingRecovery.state 'retry'`, attempts kept, the evidence recorded, a short
//     grace before the drain may take it). The caller then accounts it; if the process dies first, the
//     existing donation-reconciliation drain completes it. Accounting stays gated on `processed` (once).
//   • failed → the record is `failed` (never accounted); an attempt-owned reservation is freed
//   • any other status → `awaiting_gateway`, and the unreleased donation is held
//   • a contradiction (processed vs failed, either order; failed after success evidence) never overwrites
//     the recorded outcome: needs_review, alerted. Holds are never lifted here; no gateway call is made.

export type RefundOutcomeEvidence = 'webhook_refund_processed' | 'api_refund_processed'
export interface RefundOutcomeResult {
  record:  'created' | 'updated' | 'unchanged' | 'conflict'
  attempt: 'linked' | 'unchanged' | 'conflict' | 'none'
  kind:    'processed' | 'failed' | 'other'
}

/** The drain may take an accounting-pending record only after this grace (the caller is accounting it now). */
export const ACCOUNTING_PENDING_GRACE_MS = 2 * 60_000
const ATTEMPT_ID_RE = /^att_[A-Za-z0-9_-]{8,80}$/

export async function recordDonationRefundGatewayOutcome(input: {
  donationId: string; refundId: string; paymentId: string; amountPaise: number
  gatewayStatus: string; evidence: RefundOutcomeEvidence; source: 'webhook' | 'organizer' | 'recovery'
  attemptId?: string | null; failureReason?: string | null
  /** For a record created here without an attempt: who initiated it ('webhook' = not RegisterDesk). */
  initiatedBy?: string; reason?: string
}): Promise<RefundOutcomeResult> {
  const ref = refundsCol().doc(input.refundId)
  const donationRef = adminDb.collection('donations').doc(input.donationId)
  const ptxRef = adminDb.collection('platformTransactions').doc(`ptx_${input.donationId}`)
  const kind: RefundOutcomeResult['kind'] = input.gatewayStatus === 'processed' ? 'processed' : input.gatewayStatus === 'failed' ? 'failed' : 'other'
  const failureReason = (input.failureReason ?? '').slice(0, 300) || null
  const out = await adminDb.runTransaction<RefundOutcomeResult & { conflict?: string }>(async tx => {
    const [snap, dSnap, ptxSnap] = await Promise.all([tx.get(ref), tx.get(donationRef), tx.get(ptxRef)])
    if (!dSnap.exists) throw new Error(`donation_not_found:${input.donationId}`)
    const d = dSnap.data() as DonationDocument
    const now = FieldValue.serverTimestamp()
    const donationUpdate: Record<string, unknown> = {}
    const ptxUpdate: Record<string, unknown> = {}

    // ── the attempt (if this refund names one) ──
    let attemptOut: RefundOutcomeResult['attempt'] = 'none'
    const attemptId = input.attemptId && ATTEMPT_ID_RE.test(input.attemptId) ? input.attemptId : null
    const a = attemptId ? d.refundAttempts?.[attemptId] : undefined
    if (attemptId && a) {
      if (OPEN_ATTEMPT.has(a.status)) {
        donationUpdate[`refundAttempts.${attemptId}.status`] = 'linked'
        donationUpdate[`refundAttempts.${attemptId}.refundId`] = input.refundId
        donationUpdate[`refundAttempts.${attemptId}.resolvedAt`] = now
        donationUpdate.hasOpenRefundAttempt = hasOpen(d.refundAttempts, attemptId)
        attemptOut = 'linked'
      } else {
        attemptOut = a.status === 'linked' && a.refundId === input.refundId ? 'unchanged' : 'conflict'
      }
    }

    // ── the refund record ──
    const rec = snap.exists ? snap.data() as DonationRefundDocument : null
    const st = rec?.accountingRecovery?.state
    const initiatedBy = rec?.initiatedBy ?? (a ? a.by : (input.initiatedBy ?? 'webhook'))
    const ownsReservation = initiatedBy !== 'webhook'
    const base = {
      id: input.refundId, donationId: input.donationId, campaignId: d.campaignId, campaignSlug: d.campaignSlug,
      organizerUid: d.organizerUid, razorpayRefundId: input.refundId, razorpayPaymentId: input.paymentId,
      amountPaise: input.amountPaise, reason: input.reason ?? (a ? 'organizer_initiated' : 'gateway_refund'),
      initiatedBy, createdAt: now,
    }
    const freeReservation = () => {
      const free = Math.min(rec?.amountPaise ?? input.amountPaise, d.pendingRefundPaise ?? 0)
      if (free > 0) donationUpdate.pendingRefundPaise = FieldValue.increment(-free)
    }
    let recordOut: RefundOutcomeResult['record'] = 'unchanged'
    let conflict: string | undefined
    const flagConflict = (why: string) => {
      tx.update(ref, {
        'accountingRecovery.state': 'needs_review', 'accountingRecovery.conflict': why,
        'accountingRecovery.lastError': why, 'accountingRecovery.lastSource': input.source,
        'accountingRecovery.lastAttemptAt': now, 'accountingRecovery.nextAttemptAt': FieldValue.delete(),
      })
      recordOut = 'conflict'; conflict = why
      // Phase 3.3 (verification) — an UNRELEASED donation is held while the contradiction stands (the
      // release job only takes 'pending'); the refund-hold lift refuses it too (refundHoldReview).
      const p = ptxSnap.exists ? ptxSnap.data() as PlatformTransactionDocument & { releaseHold?: unknown } : null
      if (p && p.status === 'completed' && (p.releaseStatus === 'pending' || p.releaseStatus === 'held')) {
        ptxUpdate.releaseStatus = 'held'
        ptxUpdate['releaseHold.reason'] = 'refund_review'
        ptxUpdate['releaseHold.refundIds'] = FieldValue.arrayUnion(input.refundId)
        if (!p.releaseHold) { ptxUpdate['releaseHold.source'] = DONATION_OUTCOME_CONFLICT_HOLD_SOURCE; ptxUpdate['releaseHold.heldAt'] = now }
      }
    }
    const pending = (prevAttempts: number, prevEvidence: unknown) => ({
      state: 'retry' as const, attempts: prevAttempts, gatewayEvidence: (prevEvidence as RefundOutcomeEvidence | undefined) ?? input.evidence,
      lastSource: input.source, lastError: null, lastAttemptAt: now,
      nextAttemptAt: Timestamp.fromMillis(Date.now() + ACCOUNTING_PENDING_GRACE_MS),
    })
    if (kind === 'processed') {
      if (!rec) {
        tx.set(ref, { ...base, status: 'pending', accountingRecovery: pending(0, undefined) } satisfies DonationRefundDocument)
        recordOut = 'created'
      } else if (rec.status === 'failed') {
        flagConflict('PROCESSED_EVENT_AFTER_FAILED')
      } else if (rec.status === 'pending' && st !== 'needs_review' && st !== 'retry') {
        tx.update(ref, { accountingRecovery: pending(rec.accountingRecovery?.attempts ?? 0, rec.accountingRecovery?.gatewayEvidence) })
        recordOut = 'updated'
      }
    } else if (kind === 'failed') {
      if (!rec) {
        tx.set(ref, { ...base, status: 'failed', failedAt: now, failureReason, accountingRecovery: { state: 'gateway_failed', lastSource: input.source, lastAttemptAt: now },
          ...(ownsReservation ? { reservationReleased: true } : {}) } satisfies DonationRefundDocument)   // Phase 3.4 — never released twice
        if (ownsReservation) freeReservation()
        recordOut = 'created'
      } else if (rec.status === 'processed' || st === 'retry' || st === 'needs_review') {
        flagConflict(`FAILED_EVENT_AFTER_${rec.status === 'processed' ? 'PROCESSED' : 'SUCCESS_EVIDENCE'}`)
      } else if (rec.status === 'pending') {
        tx.update(ref, { status: 'failed', failedAt: now, failureReason, 'accountingRecovery.state': 'gateway_failed', 'accountingRecovery.lastSource': input.source, 'accountingRecovery.lastAttemptAt': now,
          ...(ownsReservation ? { reservationReleased: true } : {}) })   // Phase 3.4 — never released twice
        if (ownsReservation) freeReservation()
        recordOut = 'updated'
      }
    } else {
      if (!rec) {
        tx.set(ref, { ...base, status: 'pending', accountingRecovery: { state: 'awaiting_gateway', gatewayStatus: input.gatewayStatus.slice(0, 40), lastAttemptAt: now } } satisfies DonationRefundDocument)
        recordOut = 'created'
      } else if (rec.status === 'pending' && !rec.accountingRecovery) {
        tx.update(ref, { accountingRecovery: { state: 'awaiting_gateway', gatewayStatus: input.gatewayStatus.slice(0, 40), lastAttemptAt: now } })
        recordOut = 'updated'
      }
    }

    // ── the donation's settlement hold ──
    const ptx = ptxSnap.exists ? ptxSnap.data() as PlatformTransactionDocument & { releaseHold?: { attemptIds?: unknown; source?: unknown } } : null
    const holdsAttempt = !!attemptId && Array.isArray(ptx?.releaseHold?.attemptIds) && (ptx!.releaseHold!.attemptIds as unknown[]).includes(attemptId)
    if (holdsAttempt && attemptOut === 'linked') {
      ptxUpdate['releaseHold.refundIds'] = FieldValue.arrayUnion(input.refundId)
      if (ptx!.releaseHold!.source === DONATION_OUTCOME_UNKNOWN_HOLD_SOURCE) ptxUpdate['releaseHold.source'] = DONATION_OUTCOME_PENDING_HOLD_SOURCE
    }
    if (kind === 'other' && (rec?.status ?? 'pending') === 'pending' && ptx && ptx.status === 'completed' && (ptx.releaseStatus === 'pending' || ptx.releaseStatus === 'held')) {
      ptxUpdate.releaseStatus = 'held'
      ptxUpdate['releaseHold.reason'] = 'refund_review'
      ptxUpdate['releaseHold.refundIds'] = FieldValue.arrayUnion(input.refundId)
      if (!ptx.releaseHold) { ptxUpdate['releaseHold.source'] = DONATION_OUTCOME_PENDING_HOLD_SOURCE; ptxUpdate['releaseHold.heldAt'] = now }
    }
    if (Object.keys(ptxUpdate).length) tx.update(ptxRef, { ...ptxUpdate, updatedAt: now })
    if (Object.keys(donationUpdate).length) tx.update(donationRef, { ...donationUpdate, updatedAt: now })
    return { record: recordOut, attempt: attemptOut, kind, conflict }
  })
  if (out.conflict || out.attempt === 'conflict') {
    captureFinancialError(new Error(`donation refund outcome contradiction: ${out.conflict ?? 'attempt_link_conflict'}`), {
      scope: 'donationRefundOutcome.conflict', refundId: input.refundId, donationId: input.donationId, attemptId: input.attemptId ?? null,
    })
  }
  return { record: out.record, attempt: out.attempt, kind: out.kind }
}

/**
 * Records the outcome, then — for a processed refund — accounts it now. A failure of the accounting is
 * recorded for the drain (bounded retries → needs_review); a crash before or during it is recovered by the
 * drain from the accounting-pending state written in the same transaction as the record.
 */
export async function settleDonationRefundOutcome(input: Parameters<typeof recordDonationRefundGatewayOutcome>[0]): Promise<RefundOutcomeResult & { applied: boolean; failure?: AccountingFailureOutcome }> {
  const r = await recordDonationRefundGatewayOutcome(input)
  if (r.kind !== 'processed' || r.record === 'conflict') return { ...r, applied: false }
  try {
    const a = await applyDonationRefundAccounting(input.refundId)
    return { ...r, applied: a.applied }
  } catch (err) {
    // The accounting-pending state is already durable (same transaction as the record): even if this
    // bookkeeping write fails, the drain completes the accounting.
    const failure = await recordDonationRefundAccountingFailure(input.refundId, { gatewayEvidence: input.evidence, error: err instanceof Error ? err.message : 'accounting_failed', source: input.source })
      .catch(e => { captureFinancialError(e, { scope: 'donationRefundOutcome.accounting_failure_record_failed', refundId: input.refundId }); return undefined })
    return { ...r, applied: false, ...(failure ? { failure } : {}) }
  }
}

// ─── Phase 3.3 · E — Super Admin resolution of a refund whose ACCOUNTING is in `needs_review` ─────────────
//
// `needs_review` is terminal for the automatic drain. A Super Admin may resolve it ONLY on authoritative
// evidence: a fresh, read-only Razorpay refund-list lookup for the payment, read now (never a cached or
// inferred outcome). Three actions, each refused unless its evidence holds:
//   retry_accounting — the gateway shows the refund PROCESSED (amount matching) and the record is still
//                      pending: the accounting is re-queued and run ONCE now (a failure returns it to
//                      needs_review through the normal bounded path — never an unbounded loop)
//   record_failed    — the gateway shows the refund FAILED, NO success evidence was ever recorded for it,
//                      and it is ≥ REFUND_HOLD_MIN_RELEASE_AGE_MS old (PD-2): recorded failed; a reservation
//                      the refund owned is freed. Nothing is reversed (no money left)
//   link_attempt     — an OPEN refund attempt of the donation is proven (the gateway's own notes, via the
//                      attempt-evidence evaluator) to have created THIS refund: the attempt is linked to it
//                      and the reservation ownership follows (PD-2 age applies)
// Refused, with nothing changed: a record carrying a CONFLICT (contradictory gateway signals), a lookup
// that fails or cannot be read completely, a refund the gateway does not list, an amount or status that
// contradicts the record. Never: an inferred "no refund", a resolution from age or missing evidence, a
// force-release, a hold lift (holds stay for the settlement hold review), a gateway refund call.
// Every resolution is ONE transaction with its audit row (deterministic id from the requestId), so a
// repeated submission returns the first result and changes nothing.

export type RefundReviewAction = 'retry_accounting' | 'record_failed' | 'link_attempt'
export type RefundReviewResult =
  | { ok: true; action: RefundReviewAction; outcome: string; duplicate: boolean; detail?: Record<string, unknown> }
  | { ok: false; status: number; code: string; error: string; detail?: Record<string, unknown> }

const REVIEW_AUDIT_ACTION: Record<RefundReviewAction, AdminAuditAction> = {
  retry_accounting: 'donation.refund_review_accounting_retried',
  record_failed:    'donation.refund_review_recorded_failed',
  link_attempt:     'donation.refund_review_attempt_linked',
}
const PROCESSED_EVIDENCE: ReadonlySet<unknown> = new Set(['webhook_refund_processed', 'api_refund_processed'])

type GatewayRefundLookup =
  | { ok: true; lookup: unknown; refund: { status: string; amountPaise: number | null; attemptId: string | null; acquirerRef: string | null } | null }
  | { ok: false; why: 'lookup_failed' | 'lookup_malformed' }

/** Razorpay's refund list for the payment (read-only), and THIS refund's entry in it (null = not listed). */
async function lookupGatewayRefund(paymentId: string, refundId: string): Promise<GatewayRefundLookup> {
  let lookup: unknown
  try {
    const { razorpay } = await import('@/lib/razorpay/client')
    lookup = await razorpay.payments.fetchMultipleRefund(paymentId)
  } catch { return { ok: false, why: 'lookup_failed' } }
  const items = (lookup as { items?: unknown } | null | undefined)?.items
  if (!Array.isArray(items)) return { ok: false, why: 'lookup_malformed' }
  for (const raw of items) {
    const r = raw as { id?: unknown; status?: unknown; amount?: unknown; notes?: unknown; acquirer_data?: unknown } | null
    if (!r || typeof r !== 'object' || typeof r.id !== 'string' || typeof r.status !== 'string' || !r.status) return { ok: false, why: 'lookup_malformed' }
    if (r.id !== refundId) continue
    const notes = r.notes && typeof r.notes === 'object' ? r.notes as { attemptId?: unknown } : {}
    // Phase 3.4 — the acquirer's reference (ARN / RRN): evidence the refund reached the card or bank network.
    const acq = r.acquirer_data && typeof r.acquirer_data === 'object' ? r.acquirer_data as { arn?: unknown; rrn?: unknown } : {}
    const acquirerRef = typeof acq.arn === 'string' && acq.arn ? acq.arn : typeof acq.rrn === 'string' && acq.rrn ? acq.rrn : null
    return { ok: true, lookup, refund: { status: r.status, amountPaise: typeof r.amount === 'number' ? r.amount : null, attemptId: typeof notes.attemptId === 'string' ? notes.attemptId : null, acquirerRef } }
  }
  return { ok: true, lookup, refund: null }
}

const olderThanPd2 = (ts: unknown): boolean => {
  const t = (ts as { toMillis?: () => number } | null | undefined)?.toMillis?.()
  return typeof t === 'number' && Date.now() - t >= REFUND_HOLD_MIN_RELEASE_AGE_MS
}

export async function resolveDonationRefundReview(input: {
  refundId: string; action: RefundReviewAction; attemptId?: string | null; adminUid: string; reason: string; requestId: string
}): Promise<RefundReviewResult> {
  const ref = refundsCol().doc(input.refundId)
  const auditId = `donation_refund_review_${input.refundId}_${input.requestId}`.slice(0, 1400)
  const auditRef = adminDb.collection('adminAuditLogs').doc(auditId)
  const duplicateOf = (prior: FirebaseFirestore.DocumentSnapshot): RefundReviewResult => {
    const m = (prior.data() as { metadata?: { action?: unknown; outcome?: unknown } }).metadata
    if (m?.action !== input.action) return { ok: false, status: 409, code: 'REQUEST_ID_REUSED', error: 'This requestId was already used for a different resolution.' }
    return { ok: true, action: input.action, outcome: String(m?.outcome ?? ''), duplicate: true }
  }

  // ── preconditions (each re-checked in the transaction) ──
  const [snap, prior] = await Promise.all([ref.get(), auditRef.get()])
  if (prior.exists) return duplicateOf(prior)
  if (!snap.exists) return { ok: false, status: 404, code: 'NOT_FOUND', error: 'Refund record not found.' }
  const rec = snap.data() as DonationRefundDocument
  if (rec.accountingRecovery?.state !== 'needs_review') return { ok: false, status: 409, code: 'NOT_IN_REVIEW', error: 'This refund is not awaiting review.' }
  if (rec.accountingRecovery.conflict) {
    return { ok: false, status: 409, code: 'CONTRADICTORY_OUTCOME', error: 'The gateway reported contradictory outcomes for this refund. It stays held; reconcile it with Razorpay manually.', detail: { conflict: rec.accountingRecovery.conflict } }
  }

  // ── authoritative evidence: a fresh read-only lookup ──
  const gw = await lookupGatewayRefund(rec.razorpayPaymentId, input.refundId)
  if (!gw.ok) return { ok: false, status: 503, code: 'GATEWAY_UNVERIFIED', error: 'Razorpay\'s refunds for this payment could not be read completely. Nothing was changed; try again later.', detail: { why: gw.why } }
  if (!gw.refund) return { ok: false, status: 409, code: 'REFUND_NOT_AT_GATEWAY', error: 'Razorpay does not list this refund for the payment. Nothing was changed; it stays held.' }
  if (gw.refund.amountPaise === null || gw.refund.amountPaise !== rec.amountPaise) {
    return { ok: false, status: 409, code: 'AMOUNT_MISMATCH', error: 'Razorpay\'s amount for this refund does not match the record. Nothing was changed.', detail: { gatewayAmountPaise: gw.refund.amountPaise, recordAmountPaise: rec.amountPaise } }
  }
  const gatewayStatus = gw.refund.status
  const evidenceDoc = { requestId: input.requestId, gatewayStatus, gatewayAmountPaise: gw.refund.amountPaise, lookup: 'razorpay_refund_list' }
  const stage = (tx: FirebaseFirestore.Transaction, outcome: string, before: Record<string, unknown>, after: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    stageAdminAudit(tx, {
      adminUid: input.adminUid, actorRole: 'super_admin', action: REVIEW_AUDIT_ACTION[input.action],
      entityType: 'donation', entityId: rec.donationId, reason: input.reason,
      changedFields: Object.keys(after), before, after,
      metadata: { action: input.action, outcome, refundId: input.refundId, ...evidenceDoc, ...extra },
      correlation: { donationId: rec.donationId, refundId: input.refundId, paymentId: rec.razorpayPaymentId },
    }, auditId)

  if (input.action === 'retry_accounting') {
    if (rec.status !== 'pending') return { ok: false, status: 409, code: 'NOT_PENDING', error: `This refund is already ${rec.status}.` }
    if (gatewayStatus !== 'processed') {
      return { ok: false, status: 409, code: 'NOT_PROCESSED_AT_GATEWAY', error: `Razorpay shows this refund as "${gatewayStatus}", not processed. Nothing was accounted; it stays held.` }
    }
    const scheduled = await adminDb.runTransaction<RefundReviewResult | null>(async tx => {
      const [s2, p2] = await Promise.all([tx.get(ref), tx.get(auditRef)])
      if (p2.exists) return duplicateOf(p2)
      const r2 = s2.data() as DonationRefundDocument | undefined
      if (!r2 || r2.status !== 'pending' || r2.accountingRecovery?.state !== 'needs_review' || r2.accountingRecovery.conflict) {
        return { ok: false, status: 409, code: 'STATE_CHANGED', error: 'The refund changed meanwhile. Nothing was changed; reload.' }
      }
      const now = FieldValue.serverTimestamp()
      const evidence = PROCESSED_EVIDENCE.has(r2.accountingRecovery.gatewayEvidence) ? r2.accountingRecovery.gatewayEvidence! : 'api_refund_processed'
      tx.update(ref, {
        'accountingRecovery.state': 'retry', 'accountingRecovery.gatewayEvidence': evidence,
        'accountingRecovery.lastSource': 'recovery', 'accountingRecovery.nextAttemptAt': Timestamp.fromMillis(Date.now()),
        [`reviewResolutions.${input.requestId}`]: { action: input.action, by: input.adminUid, at: now, reason: input.reason, ...evidenceDoc },
      })
      stage(tx, 'retry_scheduled', { accountingState: 'needs_review', attempts: r2.accountingRecovery.attempts ?? 0, lastError: r2.accountingRecovery.lastError ?? null },
        { accountingState: 'retry', gatewayEvidence: evidence })
      return null
    })
    if (scheduled) return scheduled
    // ONE accounting run now. A failure goes back through the bounded path (attempts already at the cap ⇒
    // needs_review again, alerted) — never a loop, never a gateway call.
    try {
      const r = await applyDonationRefundAccounting(input.refundId)
      if (!r.applied) await markAccountingCompletedIfProcessed(input.refundId)
      return { ok: true, action: input.action, outcome: 'accounted', duplicate: false, detail: { reversedPaise: r.reversedPaise, fullRefund: r.fullRefund } }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'accounting_failed'
      const f = await recordDonationRefundAccountingFailure(input.refundId, { gatewayEvidence: 'api_refund_processed', error: message, source: 'recovery' })
      return { ok: true, action: input.action, outcome: 'still_failing', duplicate: false, detail: { error: message.slice(0, 300), state: f.state, attempts: f.attempts } }
    }
  }

  if (input.action === 'record_failed') {
    if (rec.status !== 'pending') return { ok: false, status: 409, code: 'NOT_PENDING', error: `This refund is already ${rec.status}.` }
    if (gatewayStatus !== 'failed') return { ok: false, status: 409, code: 'NOT_FAILED_AT_GATEWAY', error: `Razorpay shows this refund as "${gatewayStatus}", not failed. Nothing was changed.` }
    if (PROCESSED_EVIDENCE.has(rec.accountingRecovery.gatewayEvidence)) {
      return { ok: false, status: 409, code: 'CONTRADICTORY_OUTCOME', error: 'Success was recorded for this refund earlier; Razorpay now shows it failed. It stays held; reconcile it with Razorpay manually.' }
    }
    if (!olderThanPd2(rec.createdAt)) return { ok: false, status: 409, code: 'TOO_RECENT', error: 'The refund is younger than 15 minutes; its outcome cannot be concluded yet.' }
    const donationRef = adminDb.collection('donations').doc(rec.donationId)
    return adminDb.runTransaction<RefundReviewResult>(async tx => {
      const [s2, p2, d2] = await Promise.all([tx.get(ref), tx.get(auditRef), tx.get(donationRef)])
      if (p2.exists) return duplicateOf(p2)
      const r2 = s2.data() as DonationRefundDocument | undefined
      if (!r2 || r2.status !== 'pending' || r2.accountingRecovery?.state !== 'needs_review' || r2.accountingRecovery.conflict || PROCESSED_EVIDENCE.has(r2.accountingRecovery.gatewayEvidence)) {
        return { ok: false, status: 409, code: 'STATE_CHANGED', error: 'The refund changed meanwhile. Nothing was changed; reload.' }
      }
      const d = d2.exists ? d2.data() as DonationDocument : null
      const now = FieldValue.serverTimestamp()
      const freed = r2.initiatedBy !== 'webhook' && d ? Math.min(r2.amountPaise, d.pendingRefundPaise ?? 0) : 0
      tx.update(ref, {
        status: 'failed', failedAt: now, failureReason: 'reported failed by the gateway refund list (Super Admin review)', reservationReleased: true,
        'accountingRecovery.state': 'gateway_failed', 'accountingRecovery.lastSource': 'recovery',
        'accountingRecovery.lastAttemptAt': now, 'accountingRecovery.nextAttemptAt': FieldValue.delete(),
        [`reviewResolutions.${input.requestId}`]: { action: input.action, by: input.adminUid, at: now, reason: input.reason, ...evidenceDoc },
      })
      if (freed > 0) tx.update(donationRef, { pendingRefundPaise: FieldValue.increment(-freed), updatedAt: now })
      stage(tx, 'recorded_failed', { status: 'pending', accountingState: 'needs_review', pendingRefundPaise: d?.pendingRefundPaise ?? 0 },
        { status: 'failed', accountingState: 'gateway_failed', pendingRefundPaise: (d?.pendingRefundPaise ?? 0) - freed },
        { reservationFreedPaise: freed, minAgeMs: REFUND_HOLD_MIN_RELEASE_AGE_MS })
      return { ok: true, action: input.action, outcome: 'recorded_failed', duplicate: false, detail: { reservationFreedPaise: freed } }
    })
  }

  // link_attempt
  const attemptId = input.attemptId && ATTEMPT_ID_RE.test(input.attemptId) ? input.attemptId : null
  if (!attemptId) return { ok: false, status: 400, code: 'INVALID_ATTEMPT_ID', error: 'An attemptId is required to link a refund.' }
  const recorded = await refundsCol().where('donationId', '==', rec.donationId).limit(200).get()
  const ev = evaluateAttemptEvidence(gw.lookup, attemptId, new Set(recorded.docs.map(x => x.id)))
  if (ev.kind !== 'linked' || ev.refundId !== input.refundId) {
    return { ok: false, status: 409, code: 'ATTEMPT_NOT_PROVEN', error: 'Razorpay does not show this refund as created by that attempt. Nothing was changed.', detail: { evidence: ev.kind } }
  }
  if ((rec.status === 'processed' && gatewayStatus !== 'processed') || (rec.status === 'failed' && gatewayStatus !== 'failed')) {
    return { ok: false, status: 409, code: 'CONTRADICTORY_OUTCOME', error: `The record says ${rec.status}; Razorpay says ${gatewayStatus}. It stays held.` }
  }
  const donationRef = adminDb.collection('donations').doc(rec.donationId)
  return adminDb.runTransaction<RefundReviewResult>(async tx => {
    const [s2, p2, d2] = await Promise.all([tx.get(ref), tx.get(auditRef), tx.get(donationRef)])
    if (p2.exists) return duplicateOf(p2)
    const r2 = s2.data() as DonationRefundDocument | undefined
    const d = d2.exists ? d2.data() as DonationDocument : null
    const a = d?.refundAttempts?.[attemptId]
    if (!r2 || !d || r2.accountingRecovery?.state !== 'needs_review' || r2.accountingRecovery.conflict || r2.status !== rec.status) {
      return { ok: false, status: 409, code: 'STATE_CHANGED', error: 'The refund changed meanwhile. Nothing was changed; reload.' }
    }
    if (!a) return { ok: false, status: 404, code: 'ATTEMPT_NOT_FOUND', error: 'Refund attempt not found on this donation.' }
    if (!OPEN_ATTEMPT.has(a.status)) return { ok: false, status: 409, code: 'ATTEMPT_NOT_OPEN', error: `This attempt is already ${a.status}.` }
    if (a.amountPaise !== r2.amountPaise) return { ok: false, status: 409, code: 'AMOUNT_MISMATCH', error: 'The attempt\'s amount does not match the refund. Nothing was changed.' }
    if (r2.initiatedBy !== 'webhook') return { ok: false, status: 409, code: 'REFUND_ALREADY_OWNED', error: 'This refund already belongs to a RegisterDesk request. Nothing was changed.' }
    if (!olderThanPd2(a.startedAt)) return { ok: false, status: 409, code: 'TOO_RECENT', error: 'The attempt is younger than 15 minutes; it cannot be concluded yet.' }
    const now = FieldValue.serverTimestamp()
    // Reservation ownership follows the link: a still-pending refund now consumes the attempt's
    // reservation when it is accounted; a refund already accounted (or failed) without it frees it now.
    const freed = r2.status === 'pending' ? 0 : Math.min(a.amountPaise, d.pendingRefundPaise ?? 0)
    tx.update(donationRef, {
      [`refundAttempts.${attemptId}.status`]:     'linked',
      [`refundAttempts.${attemptId}.refundId`]:   input.refundId,
      [`refundAttempts.${attemptId}.resolvedAt`]: now,
      [`refundAttempts.${attemptId}.resolvedBy`]: input.adminUid,
      hasOpenRefundAttempt: hasOpen(d.refundAttempts, attemptId),
      ...(freed > 0 ? { pendingRefundPaise: FieldValue.increment(-freed) } : {}),
      updatedAt: now,
    })
    tx.update(ref, {
      initiatedBy: a.by, reason: 'organizer_initiated',
      [`reviewResolutions.${input.requestId}`]: { action: input.action, attemptId, by: input.adminUid, at: now, reason: input.reason, ...evidenceDoc },
    })
    stage(tx, 'linked', { attemptStatus: a.status, initiatedBy: r2.initiatedBy, pendingRefundPaise: d.pendingRefundPaise ?? 0 },
      { attemptStatus: 'linked', initiatedBy: a.by, pendingRefundPaise: (d.pendingRefundPaise ?? 0) - freed },
      { attemptId, reservationFreedPaise: freed, minAgeMs: REFUND_HOLD_MIN_RELEASE_AGE_MS })
    return { ok: true, action: input.action, outcome: 'linked', duplicate: false, detail: { attemptId, reservationFreedPaise: freed } }
  })
}

// ─── Phase 3.4 · resolving a CONTRADICTORY refund outcome on authoritative evidence ──────────────────────
//
// A refund carries a conflict when the gateway reported both outcomes for it (recordDonationRefundGatewayOutcome):
//   PROCESSED_EVENT_AFTER_FAILED        — recorded failed (never accounted), then a processed signal
//   FAILED_EVENT_AFTER_SUCCESS_EVIDENCE — success evidence recorded (not yet accounted), then failed
//   FAILED_EVENT_AFTER_PROCESSED        — accounted (wallet debited, reversal row written), then failed
// While it stands, nothing settles it: the accounting refuses (REFUND_OUTCOME_CONFLICT), the unreleased donation
// is held, the hold lift refuses, no reservation is released, and the generic review actions refuse.
//
// The LATEST webhook never wins. A Super Admin may close a conflict only when two independent sources agree:
//   1. Razorpay's own refund record, read NOW (read-only refund list): this refund id, the recorded amount and a
//      TERMINAL status ('processed' | 'failed'). A 'failed' refund carrying an acquirer reference (ARN/RRN) is
//      not proof that no money left — it is treated as a discrepancy;
//   2. settlement / bank evidence the operator cites (source + reference + what it shows): a refund debit was
//      seen ('refund_debited') or not ('no_refund_debit').
// The claimed outcome must equal Razorpay's terminal status AND the cited evidence. When Razorpay and the
// cited evidence disagree, the discrepancy is RECORDED (evidence kept, audited) and the conflict STAYS. When
// Razorpay is unreadable, non-terminal, missing the refund or shows another amount, nothing changes.
//
// Agreed outcomes:
//   PROCESSED_EVENT_AFTER_FAILED · failed           → confirmed failed (state gateway_failed). Nothing moves.
//                                · processed        → the refund left after all: re-queued and ACCOUNTED once
//                                                     (its reservation was already released when it failed —
//                                                     marked, so it is never released twice)
//   FAILED_EVENT_AFTER_SUCCESS_EVIDENCE · processed → accounted once (as the evidence said)
//                                · failed           → recorded failed; an owned reservation is released (PD-2 age)
//   FAILED_EVENT_AFTER_PROCESSED · processed        → confirmed (state completed). Nothing moves.
//                                · failed           → COMPENSATING ledger entry (below), when it is provably exact
// Every decision is ONE transaction with its audit row (deterministic id from the requestId): idempotent, and
// two Super Admins racing serialise on the refund record — the second sees the conflict gone and is refused.
// Holds are never removed here (the evidence-gated hold lift does that); there is no force-resolve.
//
// The compensating entry (FAILED_EVENT_AFTER_PROCESSED · failed) never rewrites history: the reversal row stays,
// and a new row `ptx_refundcomp_{refundId}` (parentTransactionId = the original, net = +what the reversal
// debited, compensatesTransactionId = the reversal) cancels it in every ledger reader (Σ net, the per-bucket
// pending derivation, the cumulative reversal of later refunds, the admin report). The SAME bucket the reversal
// debited is credited back: pending while the original is unreleased; available if it was released before the
// reversal. It is applied ONLY when that is provable and complete:
//   • the reversal was SOLVENT (no clawback): an insolvent one has a debt that may since be part-recovered from
//     later releases or collected off-platform — cancelling it is an owner decision;
//   • the refund was PARTIAL and the donation is not fully refunded: a full refund flipped the original row to
//     'refunded' (and the donation, receipt and donor counts) — re-opening it is an owner decision;
//   • the reversal row matches the record exactly and the original row's release history fixes the bucket.
// Anything else stays needs_review with the decision required.

export const REFUND_CONFLICTS = ['PROCESSED_EVENT_AFTER_FAILED', 'FAILED_EVENT_AFTER_SUCCESS_EVIDENCE', 'FAILED_EVENT_AFTER_PROCESSED'] as const
export type RefundConflict = typeof REFUND_CONFLICTS[number]
export type ConflictEvidenceSource = 'razorpay_settlement_report' | 'bank_statement' | 'acquirer_confirmation'
export const CONFLICT_EVIDENCE_SOURCES: ReadonlySet<string> = new Set<ConflictEvidenceSource>(['razorpay_settlement_report', 'bank_statement', 'acquirer_confirmation'])
export interface ConflictEvidence { source: ConflictEvidenceSource; reference: string; observation: 'refund_debited' | 'no_refund_debit' }
export type ConflictResolutionResult =
  | { ok: true; outcome: string; duplicate: boolean; detail?: Record<string, unknown> }
  | { ok: false; status: number; code: string; error: string; investigation?: string; detail?: Record<string, unknown> }

const conflictMsg: Record<string, string> = {
  insolvent_reversal: 'The reversal was insolvent (a clawback exists, possibly part-recovered from later releases or collected off-platform). Cancelling that debt and returning any off-platform collection needs an owner decision.',
  full_refund: 'The refund completed the donation\'s full refund: the original ledger row, the donation, its receipt and donor counts were closed as refunded. Re-opening them needs an owner decision.',
  reversal_record_inconsistent: 'The reversal ledger row does not match the refund record; reconcile the ledger before compensating.',
  parent_state: 'The original transaction\'s release history does not prove which wallet bucket the reversal debited.',
  no_wallet: 'The organizer has no revenue wallet to credit.',
}

export async function resolveDonationRefundConflict(input: {
  refundId: string; outcome: 'processed' | 'failed'; evidence: ConflictEvidence; adminUid: string; reason: string; requestId: string
}): Promise<ConflictResolutionResult> {
  const ref = refundsCol().doc(input.refundId)
  const auditId = `donation_refund_conflict_${input.refundId}_${input.requestId}`.slice(0, 1400)
  const auditRef = adminDb.collection('adminAuditLogs').doc(auditId)
  const discrepancyInvestigation = 'Razorpay\'s refund record and the cited settlement/bank evidence disagree. Obtain Razorpay\'s settlement report entry and the acquirer confirmation (ARN/RRN) for this refund; resolve only when both establish the same outcome.'
  const duplicateOf = (prior: FirebaseFirestore.DocumentSnapshot): ConflictResolutionResult => {
    const m = (prior.data() as { metadata?: { claimedOutcome?: unknown; outcome?: unknown } }).metadata
    if (m?.claimedOutcome !== input.outcome) return { ok: false, status: 409, code: 'REQUEST_ID_REUSED', error: 'This requestId was already used for a different decision.' }
    if (m?.outcome === 'discrepancy_recorded') return { ok: false, status: 409, code: 'EVIDENCE_DISCREPANCY', error: 'The evidence disagreed; the discrepancy is recorded and the conflict stays.', investigation: discrepancyInvestigation, detail: { duplicate: true } }
    return { ok: true, outcome: String(m?.outcome ?? ''), duplicate: true }
  }

  // ── preconditions ──
  const ev = input.evidence
  if (input.outcome !== 'processed' && input.outcome !== 'failed') return { ok: false, status: 400, code: 'INVALID_OUTCOME', error: 'outcome must be "processed" or "failed".' }
  const reference = typeof ev?.reference === 'string' ? ev.reference.trim() : ''
  if (!ev || !CONFLICT_EVIDENCE_SOURCES.has(ev.source) || reference.length < 3 || reference.length > 120 || (ev.observation !== 'refund_debited' && ev.observation !== 'no_refund_debit')) {
    return { ok: false, status: 400, code: 'EVIDENCE_REQUIRED', error: 'Settlement or bank evidence is required: source, a 3–120 character reference, and what it shows.' }
  }
  const [snap, prior] = await Promise.all([ref.get(), auditRef.get()])
  if (prior.exists) return duplicateOf(prior)
  if (!snap.exists) return { ok: false, status: 404, code: 'NOT_FOUND', error: 'Refund record not found.' }
  const rec = snap.data() as DonationRefundDocument
  const conflict = rec.accountingRecovery?.conflict as RefundConflict | undefined
  if (!conflict) return { ok: false, status: 409, code: 'NOT_IN_CONFLICT', error: 'This refund has no contradictory outcome to resolve.' }
  if (!REFUND_CONFLICTS.includes(conflict)) return { ok: false, status: 409, code: 'UNKNOWN_CONFLICT', error: `Unrecognised conflict "${conflict}". It stays held.` }
  const expectedStatus = conflict === 'PROCESSED_EVENT_AFTER_FAILED' ? 'failed' : conflict === 'FAILED_EVENT_AFTER_PROCESSED' ? 'processed' : 'pending'
  if (rec.status !== expectedStatus) return { ok: false, status: 409, code: 'STATE_INCONSISTENT', error: `The record is ${rec.status}, not ${expectedStatus} as its conflict implies. It stays held.` }

  // ── authoritative gateway evidence: Razorpay's own record of THIS refund, read now ──
  const gw = await lookupGatewayRefund(rec.razorpayPaymentId, input.refundId)
  if (!gw.ok) return { ok: false, status: 503, code: 'GATEWAY_UNVERIFIED', error: 'Razorpay\'s refunds could not be read completely. Nothing was changed.', investigation: 'Retry once Razorpay is reachable.' }
  if (!gw.refund) return { ok: false, status: 409, code: 'REFUND_NOT_AT_GATEWAY', error: 'Razorpay does not list this refund for the payment. Nothing was changed.', investigation: 'Confirm the refund id with Razorpay support; the conflict stays.' }
  if (gw.refund.amountPaise !== rec.amountPaise) return { ok: false, status: 409, code: 'AMOUNT_MISMATCH', error: 'Razorpay\'s amount differs from the record. Nothing was changed.', investigation: 'Reconcile the amount with Razorpay.', detail: { gatewayAmountPaise: gw.refund.amountPaise, recordAmountPaise: rec.amountPaise } }
  const gwStatus = gw.refund.status
  if (gwStatus !== 'processed' && gwStatus !== 'failed') {
    return { ok: false, status: 409, code: 'GATEWAY_NOT_TERMINAL', error: `Razorpay reports this refund as "${gwStatus}". Nothing was changed.`, investigation: 'Wait until Razorpay reports a terminal status (processed or failed).' }
  }
  if (gwStatus !== input.outcome) {
    return { ok: false, status: 409, code: 'GATEWAY_DISAGREES', error: `Razorpay reports this refund as "${gwStatus}", not "${input.outcome}". Nothing was changed.` }
  }
  const citedOutcome = ev.observation === 'refund_debited' ? 'processed' : 'failed'
  const acquirerContradicts = gwStatus === 'failed' && !!gw.refund.acquirerRef
  const evidenceDoc = {
    claimedOutcome: input.outcome, gatewayStatus: gwStatus, gatewayAmountPaise: gw.refund.amountPaise, gatewayAcquirerRef: gw.refund.acquirerRef,
    evidenceSource: ev.source, evidenceReference: reference, evidenceObservation: ev.observation, requestId: input.requestId,
  }
  const stage = (tx: FirebaseFirestore.Transaction, action: AdminAuditAction, outcome: string, before: Record<string, unknown>, after: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    stageAdminAudit(tx, {
      adminUid: input.adminUid, actorRole: 'super_admin', action, entityType: 'donation', entityId: rec.donationId, reason: input.reason,
      changedFields: Object.keys(after), before, after,
      metadata: { outcome, conflict, refundId: input.refundId, ...evidenceDoc, ...extra },
      correlation: { donationId: rec.donationId, refundId: input.refundId, paymentId: rec.razorpayPaymentId },
    }, auditId)
  const unchanged = (r2: DonationRefundDocument | undefined) => !!r2 && r2.accountingRecovery?.conflict === conflict && r2.status === rec.status
  const changed: ConflictResolutionResult = { ok: false, status: 409, code: 'STATE_CHANGED', error: 'The refund changed meanwhile (another decision or gateway event). Nothing was changed; reload.' }

  // ── the cited evidence disagrees with Razorpay: record the discrepancy, keep the conflict ──
  if (citedOutcome !== gwStatus || acquirerContradicts) {
    const r = await adminDb.runTransaction<ConflictResolutionResult>(async tx => {
      const [s2, p2] = await Promise.all([tx.get(ref), tx.get(auditRef)])
      if (p2.exists) return duplicateOf(p2)
      const r2 = s2.data() as DonationRefundDocument | undefined
      if (!unchanged(r2)) return changed
      tx.update(ref, { [`conflictInvestigations.${input.requestId}`]: { ...evidenceDoc, by: input.adminUid, at: FieldValue.serverTimestamp(), reason: input.reason, finding: acquirerContradicts ? 'failed_with_acquirer_reference' : 'gateway_vs_evidence' } })
      stage(tx, 'donation.refund_conflict_discrepancy', 'discrepancy_recorded', { conflict }, { conflict, investigation: 'open' })
      return { ok: false, status: 409, code: 'EVIDENCE_DISCREPANCY', error: acquirerContradicts
        ? 'Razorpay reports the refund failed but carries an acquirer reference (money may have reached the customer). The discrepancy is recorded; the conflict stays.'
        : `Razorpay reports "${gwStatus}" but the cited ${ev.source} shows "${ev.observation}". The discrepancy is recorded; the conflict stays.`, investigation: discrepancyInvestigation }
    })
    return r
  }

  const resolution = (previousState: unknown) => ({ conflict, outcome: input.outcome, previousStatus: rec.status, previousState: previousState ?? null, ...evidenceDoc, by: input.adminUid, at: FieldValue.serverTimestamp(), reason: input.reason })
  const now = () => FieldValue.serverTimestamp()

  // ── agreed: processed, refund not yet accounted → re-queue and account once ──
  if (input.outcome === 'processed' && (conflict === 'PROCESSED_EVENT_AFTER_FAILED' || conflict === 'FAILED_EVENT_AFTER_SUCCESS_EVIDENCE')) {
    if (rec.compensation) {
      return { ok: false, status: 409, code: 'COMPENSATION_UNSUPPORTED', error: 'This refund was confirmed failed and its accounting compensated; a later "processed" signal contradicts that decision. Nothing was changed; it stays under review.',
        investigation: 'A refund confirmed failed (and compensated) is now reported processed: reconcile the settlement report and acquirer records; reversing a compensation needs an owner decision.', detail: { why: 'already_compensated' } }
    }
    const first = await adminDb.runTransaction<ConflictResolutionResult | null>(async tx => {
      const [s2, p2] = await Promise.all([tx.get(ref), tx.get(auditRef)])
      if (p2.exists) return duplicateOf(p2)
      const r2 = s2.data() as DonationRefundDocument | undefined
      if (!unchanged(r2)) return changed
      tx.update(ref, {
        status: 'pending',
        // A refund that was recorded FAILED had its reservation released then (or never owned one).
        ...(conflict === 'PROCESSED_EVENT_AFTER_FAILED' ? { reservationReleased: true } : {}),
        'accountingRecovery.state': 'retry', 'accountingRecovery.conflict': FieldValue.delete(),
        'accountingRecovery.gatewayEvidence': 'api_refund_processed', 'accountingRecovery.lastSource': 'recovery',
        'accountingRecovery.lastError': null, 'accountingRecovery.nextAttemptAt': Timestamp.fromMillis(Date.now()),
        [`conflictResolutions.${input.requestId}`]: resolution(r2!.accountingRecovery?.state),
      })
      stage(tx, 'donation.refund_conflict_resolved', 'confirmed_processed', { status: r2!.status, conflict }, { status: 'pending', accountingState: 'retry' })
      return null
    })
    if (first) return first
    try {
      const a = await applyDonationRefundAccounting(input.refundId)
      return { ok: true, outcome: 'confirmed_processed', duplicate: false, detail: { accounted: a.applied, reversedPaise: a.reversedPaise, fullRefund: a.fullRefund } }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'accounting_failed'
      const f = await recordDonationRefundAccountingFailure(input.refundId, { gatewayEvidence: 'api_refund_processed', error: message, source: 'recovery' })
      return { ok: true, outcome: 'confirmed_processed', duplicate: false, detail: { accounted: false, error: message.slice(0, 300), state: f.state } }
    }
  }

  // ── agreed: the record already says what happened → only the conflict closes ──
  if ((input.outcome === 'failed' && conflict === 'PROCESSED_EVENT_AFTER_FAILED') || (input.outcome === 'processed' && conflict === 'FAILED_EVENT_AFTER_PROCESSED')) {
    return adminDb.runTransaction<ConflictResolutionResult>(async tx => {
      const [s2, p2] = await Promise.all([tx.get(ref), tx.get(auditRef)])
      if (p2.exists) return duplicateOf(p2)
      const r2 = s2.data() as DonationRefundDocument | undefined
      if (!unchanged(r2)) return changed
      const state = input.outcome === 'failed' ? 'gateway_failed' : 'completed'
      tx.update(ref, {
        'accountingRecovery.state': state, 'accountingRecovery.conflict': FieldValue.delete(), 'accountingRecovery.lastSource': 'recovery',
        [`conflictResolutions.${input.requestId}`]: resolution(r2!.accountingRecovery?.state),
      })
      const outcome = input.outcome === 'failed' ? 'confirmed_failed' : 'confirmed_processed'
      stage(tx, 'donation.refund_conflict_resolved', outcome, { conflict, accountingState: 'needs_review' }, { conflict: null, accountingState: state })
      return { ok: true, outcome, duplicate: false }
    })
  }

  // ── agreed: failed, success evidence never accounted → recorded failed; an owned reservation is released ──
  if (input.outcome === 'failed' && conflict === 'FAILED_EVENT_AFTER_SUCCESS_EVIDENCE') {
    if (!olderThanPd2(rec.createdAt)) return { ok: false, status: 409, code: 'TOO_RECENT', error: 'The refund is younger than 15 minutes; its outcome cannot be concluded yet.' }
    const donationRef = adminDb.collection('donations').doc(rec.donationId)
    return adminDb.runTransaction<ConflictResolutionResult>(async tx => {
      const [s2, p2, d2] = await Promise.all([tx.get(ref), tx.get(auditRef), tx.get(donationRef)])
      if (p2.exists) return duplicateOf(p2)
      const r2 = s2.data() as DonationRefundDocument | undefined
      if (!unchanged(r2)) return changed
      const d = d2.exists ? d2.data() as DonationDocument : null
      const freed = r2!.initiatedBy !== 'webhook' && !r2!.reservationReleased && d ? Math.min(r2!.amountPaise, d.pendingRefundPaise ?? 0) : 0
      tx.update(ref, {
        status: 'failed', failedAt: now(), failureReason: `confirmed failed by Razorpay and ${ev.source} (Super Admin conflict resolution)`,
        reservationReleased: true,
        'accountingRecovery.state': 'gateway_failed', 'accountingRecovery.conflict': FieldValue.delete(), 'accountingRecovery.lastSource': 'recovery',
        'accountingRecovery.nextAttemptAt': FieldValue.delete(),
        [`conflictResolutions.${input.requestId}`]: resolution(r2!.accountingRecovery?.state),
      })
      if (freed > 0) tx.update(donationRef, { pendingRefundPaise: FieldValue.increment(-freed), updatedAt: now() })
      stage(tx, 'donation.refund_conflict_resolved', 'confirmed_failed', { status: 'pending', conflict, pendingRefundPaise: d?.pendingRefundPaise ?? 0 },
        { status: 'failed', accountingState: 'gateway_failed', pendingRefundPaise: (d?.pendingRefundPaise ?? 0) - freed }, { reservationFreedPaise: freed, minAgeMs: REFUND_HOLD_MIN_RELEASE_AGE_MS })
      return { ok: true, outcome: 'confirmed_failed', duplicate: false, detail: { reservationFreedPaise: freed } }
    })
  }

  // ── agreed: failed AFTER it was accounted → the compensating ledger entry, when provably exact ──
  const donationRef = adminDb.collection('donations').doc(rec.donationId)
  const walletRef = adminDb.collection('organizerRevenueWallets').doc(rec.organizerUid)
  const parentRef = adminDb.collection('platformTransactions').doc(`ptx_${rec.donationId}`)
  const reversalRef = adminDb.collection('platformTransactions').doc(`ptx_refund_${input.refundId}`)
  const compRef = adminDb.collection('platformTransactions').doc(`ptx_refundcomp_${input.refundId}`)
  const clawRef = adminDb.collection('walletClawbacks').doc(`clawback_ptx_refund_${input.refundId}`)
  return adminDb.runTransaction<ConflictResolutionResult>(async tx => {
    const [s2, p2, d2, w2, par, rev, comp, cb] = await Promise.all([
      tx.get(ref), tx.get(auditRef), tx.get(donationRef), tx.get(walletRef), tx.get(parentRef), tx.get(reversalRef), tx.get(compRef), tx.get(clawRef),
    ])
    if (p2.exists) return duplicateOf(p2)
    const r2 = s2.data() as DonationRefundDocument | undefined
    if (!unchanged(r2)) return changed
    if (comp.exists) return { ok: false, status: 409, code: 'ALREADY_COMPENSATED', error: 'A compensating entry already exists for this refund. Nothing was changed.' }
    const unsupported = (why: keyof typeof conflictMsg): ConflictResolutionResult => ({
      ok: false, status: 409, code: 'COMPENSATION_UNSUPPORTED', error: `${conflictMsg[why]} Nothing was changed; the refund stays under review.`,
      investigation: conflictMsg[why], detail: { why },
    })
    const d = d2.exists ? d2.data() as DonationDocument : null
    if (r2!.insolvent || cb.exists) return unsupported('insolvent_reversal')
    if (!d || r2!.isFullRefund || d.status === 'refunded' || (d.refundedAmountPaise ?? 0) < r2!.amountPaise) return unsupported('full_refund')
    const reversal = rev.exists ? rev.data() as PlatformTransactionDocument & { createdAt?: unknown } : null
    const credit = r2!.ledgerReversedPaise ?? 0
    if (!reversal || reversal.parentTransactionId !== parentRef.id || reversal.netSettlementPaise !== -credit || !Number.isSafeInteger(credit) || credit < 0) return unsupported('reversal_record_inconsistent')
    const parent = par.exists ? par.data() as PlatformTransactionDocument : null
    const ms = (v: unknown) => (v as { toMillis?: () => number } | null | undefined)?.toMillis?.()
    let bucket: 'pending' | 'available' | null = null
    if (parent?.status === 'completed' && (parent.releaseStatus === 'pending' || parent.releaseStatus === 'held')) bucket = 'pending'
    else if (parent?.status === 'completed' && parent.releaseStatus === 'released') {
      const releasedAt = ms(parent.releasedAt), reversedAt = ms(reversal.createdAt)
      if (typeof releasedAt === 'number' && typeof reversedAt === 'number' && releasedAt < reversedAt) bucket = 'available'
    }
    if (!bucket) return unsupported('parent_state')
    if (credit > 0 && !w2.exists) return unsupported('no_wallet')
    const wallet = w2.exists ? w2.data() as OrganizerRevenueWallet : null
    const t = now()
    // the SAME bucket the reversal debited, by exactly what it debited
    if (credit > 0) tx.update(walletRef, { [bucket === 'pending' ? 'pendingPaise' : 'availablePaise']: FieldValue.increment(credit), updatedAt: t })
    tx.create(compRef, {
      ...reversal,
      id: compRef.id,
      grossAmountPaise: r2!.amountPaise,
      netSettlementPaise: credit,
      compensatesTransactionId: reversalRef.id,
      entryType: 'refund_reversal_compensation',
      refundId: input.refundId,
      paidAt: t, createdAt: t, updatedAt: t,
    })
    tx.update(donationRef, { refundedAmountPaise: FieldValue.increment(-r2!.amountPaise), updatedAt: t })
    tx.set(adminDb.collection('donationCounters').doc(r2!.campaignSlug), { campaignSlug: r2!.campaignSlug, totalRaisedPaise: FieldValue.increment(r2!.amountPaise), updatedAt: t }, { merge: true })
    if (d.donationPaymentId) tx.update(adminDb.collection('donationPayments').doc(d.donationPaymentId), { refundAmountPaise: FieldValue.increment(-r2!.amountPaise), updatedAt: t })
    const compensation = { ledgerId: compRef.id, compensatesTransactionId: reversalRef.id, creditedPaise: credit, bucket, requestId: input.requestId, by: input.adminUid, at: t }
    tx.update(ref, {
      status: 'failed', failedAt: t, failureReason: `confirmed failed by Razorpay and ${ev.source} after it was accounted (Super Admin conflict resolution)`,
      'accountingRecovery.state': 'gateway_failed', 'accountingRecovery.conflict': FieldValue.delete(), 'accountingRecovery.lastSource': 'recovery',
      compensation,
      [`conflictResolutions.${input.requestId}`]: resolution(r2!.accountingRecovery?.state),
    })
    stage(tx, 'donation.refund_reversal_compensated', 'compensated',
      { status: 'processed', conflict, [`${bucket}Paise`]: bucket === 'pending' ? wallet?.pendingPaise ?? 0 : wallet?.availablePaise ?? 0, refundedAmountPaise: d.refundedAmountPaise ?? 0 },
      { status: 'failed', accountingState: 'gateway_failed', [`${bucket}Paise`]: (bucket === 'pending' ? wallet?.pendingPaise ?? 0 : wallet?.availablePaise ?? 0) + credit, refundedAmountPaise: (d.refundedAmountPaise ?? 0) - r2!.amountPaise },
      { compensation: { ledgerId: compRef.id, creditedPaise: credit, bucket } })
    return { ok: true, outcome: 'compensated', duplicate: false, detail: { ledgerId: compRef.id, creditedPaise: credit, bucket } }
  })
}
