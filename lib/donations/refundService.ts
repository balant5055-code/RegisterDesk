// Donation refund engine — server-only (Admin SDK).
//
// Supports full + partial refunds with PROPORTIONAL settlement reversal,
// idempotent exactly-once accounting (shared by the organizer API and the
// refund.processed webhook via the Razorpay refund id), and exact counter
// reconciliation. Distinct from the registration full-reversal path
// (reversePlatformTransactionAndDebit) which it deliberately does not reuse.

import { FieldValue }       from 'firebase-admin/firestore'
import { adminDb }          from '@/lib/firebase/admin'
import { computeWalletDebit } from '@/lib/firebase/firestore/revenueWallets'
import { writeClawbackOnShortfall, logClawbackEvent } from '@/lib/clawbacks/clawbackService'
import { enqueueWebhook }        from '@/lib/integrations/webhooks'
import { crmRecordRefund }       from '@/lib/crm/service'
import { captureFinancialError } from '@/lib/monitoring/sentry'
import type { OrganizerRevenueWallet }      from '@/lib/fees/types'
import type { PlatformTransactionDocument } from '@/lib/fees/types'
import type {
  DonationDocument,
  DonationRefundDocument,
  DonationRefundStatus,
} from '@/lib/donations/types'

const refundsCol = () => adminDb.collection('donationRefunds')

/**
 * Net settlement to reverse for a gross refund, proportional to the original
 * settlement ratio: round(net × refund / gross). Clamped to [0, net].
 */
export function proportionalReversal(grossPaise: number, netPaise: number, refundPaise: number): number {
  if (grossPaise <= 0 || netPaise <= 0 || refundPaise <= 0) return 0
  const raw = Math.round((netPaise * refundPaise) / grossPaise)
  return Math.min(Math.max(raw, 0), netPaise)
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
 *   - proportional revenue-wallet debit (pending→available, clamped; inTransit
 *     invariant preserved; no over/double-debit)
 *   - reversal ledger entry linked to the original transaction
 *   - counter reconciliation (totalRaisedPaise always; donationCount/donorCount
 *     only on full refund, donorCount only if the donor has no other successful
 *     donation to the campaign)
 *   - donation refundedAmountPaise / pendingRefundPaise; status→refunded on full
 *   - receipt status→refunded on full refund
 * Safe under organizer + webhook + retry concurrency.
 */
export async function applyDonationRefundAccounting(refundId: string): Promise<ApplyResult> {
  const refundRef = refundsCol().doc(refundId)
  // Clawback recorded atomically inside the txn (insolvent reversal); audited after.
  let clawbackInfo: { clawbackId: string; outstandingPaise: number } | null = null
  let refundOrganizerUid = ''   // captured from the committed refund for the post-commit webhook
  let refundDonationId = ''     // captured for the CRM refund activity
  let refundAmountPaise = 0

  const result = await adminDb.runTransaction(async tx => {
    clawbackInfo = null
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
    const reversalNet  = proportionalReversal(gross, origNet, refundAmount)
    // F.5: the reversal carries the ORIGINAL transaction's plan tier — the refund
    // reverses HISTORICAL stored fee values, never the organizer's current plan.
    const origPlanTier    = origPtx?.planTier    ?? 'starter'
    const origFeeConfigId = origPtx?.feeConfigId ?? 'fallback'

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
    if (walletSnap.exists && reversalNet > 0) {
      const wallet = walletSnap.data() as OrganizerRevenueWallet
      const plan   = computeWalletDebit(wallet, reversalNet)
      reversedPaise = plan.totalDebited
      insolvent     = plan.totalDebited < reversalNet
      const newAvailable = wallet.availablePaise - plan.fromAvailable
      const newInTransit = Math.min(wallet.inTransitPaise ?? 0, newAvailable)  // invariant
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
      feeModel:            'organizer_pays',
      planTier:            origPlanTier,
      feeConfigId:         origFeeConfigId,
      currency:            'INR',
      gateway:             'razorpay',
      gatewayPaymentId:    refund.razorpayPaymentId,
      gatewayOrderId:      donation.razorpayOrderId ?? '',
      status:              'refunded',
      parentTransactionId: `ptx_${refund.donationId}`,
      refundId,
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
    const donationUpdate: Record<string, unknown> = {
      refundedAmountPaise: FieldValue.increment(refundAmount),
      pendingRefundPaise:  FieldValue.increment(-Math.min(refundAmount, donation.pendingRefundPaise ?? 0)),
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

    // ── flip the original ledger to refunded on full refund (audit clarity) ──
    if (fullRefund && origPtxSnap.exists) {
      tx.update(origPtxRef, { status: 'refunded', updatedAt: FieldValue.serverTimestamp() })
    }

    // ── refund record: processed (exactly-once gate) ──
    tx.update(refundRef, {
      status:              'processed' satisfies DonationRefundStatus,
      isFullRefund:        fullRefund,
      ledgerReversedPaise: reversedPaise,
      insolvent,
      processedAt:         FieldValue.serverTimestamp(),
    })

    return { applied: true, fullRefund, reversedPaise, insolvent }
  })

  // Audit the clawback once the reversal has committed (system actor).
  if (result.applied && clawbackInfo) {
    const info = clawbackInfo as { clawbackId: string; outstandingPaise: number }
    void logClawbackEvent('system', 'clawback.created', info.clawbackId, {
      refundId, outstandingPaise: info.outstandingPaise,
    }).catch(() => {})
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
