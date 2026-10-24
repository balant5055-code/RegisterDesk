// RD-REFUND-MANUAL-01 · Super Admin MANUAL attendee refunds — Firestore I/O. Rules: manualRefundRules.ts.
//
// Three operations, each ONE transaction that re-reads everything it decides on and stages its audit row
// IN the transaction (an audit failure means nothing happened):
//
//   request  (maker)   paid → refund_pending claim on the registration (the SAME claim the gateway refund
//                      route takes, so the two can never both run), the amount recorded on the payment intent
//                      (so a gateway refund that arrives anyway is held for review — accumulatePaymentRefund),
//                      and an unreleased settlement HELD (so the release job cannot pay the organizer money
//                      that is about to be returned). Refused unless the gateway shows NO refund of the payment.
//   complete (checker) a DIFFERENT Super Admin records the transfer reference (canonical, one reference ⇒ one
//                      refund, and never a reference already used for a payout). The accounting is applied in
//                      the same transaction: proportional reversal of the organizer's net (the donation
//                      model), debited from the bucket that holds it, the shortfall a durable clawback (money
//                      already paid out), payout requests left unbacked sent to review, a negative reversal
//                      ledger row, and the registration refunded (full) or back to paid (partial).
//   cancel             a pending request is withdrawn: its claim and its own hold are lifted (a refund-review hold
//                      placed by a conflicting gateway refund stays — that review decides the settlement).
//
// Nothing here sends money, calls a bank, or initiates a gateway refund.

import { FieldValue } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import { razorpay } from '@/lib/razorpay/client'
import { readProvider } from '@/lib/payments/providers/types'
import { computeReversalDebit, walletBucketForRelease } from '@/lib/firebase/firestore/revenueWallets'
import { writeClawbackOnShortfall, logClawbackEvent } from '@/lib/clawbacks/clawbackService'
import { readOpenPayoutRequests, planPayoutRefit, stagePayoutReviews } from '@/lib/settlements/payoutReview'
import { TRANSFER_REFERENCES_COLLECTION } from '@/lib/settlements/confirmedTransfer'
import { REGISTRATION_REFUNDS_COLLECTION } from '@/lib/refunds/registrationRefunds'
import { stageAdminAudit } from '@/lib/admin/audit'
import { writeAuditEntry } from '@/lib/firebase/firestore/registrations'
import { releaseRegistrationSessions } from '@/lib/sessions/allocation'
import { releaseIdentifier } from '@/lib/identifiers/engine'
import { detachTimingTagByRegistration } from '@/lib/identifiers/timingTagEngine'
import { captureFinancialError } from '@/lib/monitoring/sentry'
import type { OrganizerRevenueWallet } from '@/lib/fees/types'
import {
  MANUAL_REFUNDS_COLLECTION, MANUAL_REFUND_REFERENCES_COLLECTION,
  manualRefundId, isManualRefundMethod, buildRecipient, canonicalReference, checkRefundAmount,
  sumManualRefunds, hasCountedGatewayRefunds, planManualReversal,
  type ManualRefundDocument, type ManualRefundMethod, type RequestRefusal,
} from './manualRefundRules'

export type ManualRefundResult =
  | { ok: true; record: ManualRefundDocument; duplicate: boolean }
  | { ok: false; status: number; code: string; error: string }

const fail = (status: number, code: string, error: string): ManualRefundResult => ({ ok: false, status, code, error })

const REFUSAL_MESSAGES: Record<RequestRefusal, string> = {
  NOT_PAID:              'Only a paid registration with no refund in progress can be refunded manually.',
  NO_PAYMENT_RECORD:     'This registration has no payment record — there is no charge to refund.',
  NO_LEDGER_ENTRY:       'This registration has no settlement transaction, so its refund cannot be accounted. Nothing was recorded.',
  LEDGER_REVERSED:       'This registration\'s settlement was already reversed (a gateway refund or dispute). Nothing was recorded.',
  GATEWAY_REFUND_EXISTS: 'A gateway refund of this payment already exists. A manual refund would pay the attendee twice. Nothing was recorded.',
  INVALID_AMOUNT:        'The amount must be a whole number of paise greater than zero.',
  EXCEEDS_REFUNDABLE:    'The amount is more than what is still refundable on this payment.',
}
const refuse = (code: RequestRefusal, status = 409) => fail(status, code, REFUSAL_MESSAGES[code])

const regsCol    = () => adminDb.collection('registrations')
const recordsCol = () => adminDb.collection(MANUAL_REFUNDS_COLLECTION)

/** The registration's payment intent (doc id = the provider order id). */
async function findIntent(registrationId: string) {
  const snap = await adminDb.collection('paymentIntents').where('registrationId', '==', registrationId).limit(2).get()
  return snap.size === 1 ? snap.docs[0] : null
}

// ─── request (maker) ─────────────────────────────────────────────────────────────────────────

export async function requestManualRefund(input: {
  registrationId: string; requestKey: unknown; amountPaise: unknown; method: unknown
  recipientName: unknown; recipientDetail: unknown; reason: string; adminUid: string
  /** Required for a non-Razorpay payment: RegisterDesk cannot query that gateway for existing refunds. */
  confirmNoGatewayRefund?: unknown
}): Promise<ManualRefundResult> {
  const id = manualRefundId(input.registrationId, input.requestKey)
  if (!id) return fail(400, 'INVALID_REQUEST_KEY', 'A request key (8–64 letters, digits, - or _) is required so a resubmission cannot create a second refund.')
  if (!isManualRefundMethod(input.method)) return fail(400, 'INVALID_METHOD', 'Choose how the money is returned: bank_transfer, upi, cash, cheque or other.')
  const method: ManualRefundMethod = input.method
  const recipient = buildRecipient(method, input.recipientName, input.recipientDetail)
  if (!recipient) return fail(400, 'INVALID_RECIPIENT', method === 'bank_transfer'
    ? 'Enter the recipient name and their account number (only its last four digits are stored).'
    : method === 'upi' ? 'Enter the recipient name and their UPI id (stored masked).' : 'Enter the recipient name.')

  // A resubmission of the SAME request is answered from the record (no second refund, no new checks).
  const existing = await recordsCol().doc(id).get()
  if (existing.exists) {
    const r = existing.data() as ManualRefundDocument
    return r.amountPaise === input.amountPaise && r.method === method
      ? { ok: true, record: r, duplicate: true }
      : fail(409, 'IDEMPOTENCY_CONFLICT', 'This request key was already used for a different refund. Nothing was recorded.')
  }

  const regSnap = await regsCol().doc(input.registrationId).get()
  if (!regSnap.exists) return fail(404, 'NOT_FOUND', 'Registration not found.')
  const intentDoc = await findIntent(input.registrationId)
  if (!intentDoc) return refuse('NO_PAYMENT_RECORD', 422)
  const intent0 = intentDoc.data() as { provider?: unknown; paymentId?: unknown }
  const provider = readProvider(intent0.provider as never)
  const paymentId = typeof intent0.paymentId === 'string' && intent0.paymentId ? intent0.paymentId : null

  // Exclusivity with the gateway, established BEFORE anything is written (a gateway call can never run inside a
  // transaction). A refund created at the gateway after this check is caught by the webhook: the intent records
  // this request in the transaction below, so that refund is held for review, never applied.
  let gatewayCheck: ManualRefundDocument['gatewayCheck']
  if (provider === 'razorpay') {
    if (!paymentId) return refuse('NO_PAYMENT_RECORD', 422)
    try {
      const res = await razorpay.payments.fetchMultipleRefund(paymentId)
      const items = Array.isArray(res?.items) ? res.items : []
      if (items.some(r => r.status !== 'failed')) return refuse('GATEWAY_REFUND_EXISTS')
    } catch {
      return fail(503, 'GATEWAY_CHECK_FAILED', 'Razorpay could not be asked whether this payment was already refunded. Nothing was recorded — try again shortly.')
    }
    gatewayCheck = 'razorpay_no_refunds'
  } else {
    if (input.confirmNoGatewayRefund !== true) {
      return fail(409, 'CONFIRM_NO_GATEWAY_REFUND', `RegisterDesk cannot query ${provider} for existing refunds. Confirm you checked its dashboard and no refund of this payment exists.`)
    }
    gatewayCheck = 'provider_unsupported_confirmed'
  }

  return adminDb.runTransaction<ManualRefundResult>(async tx => {
      const recRef = recordsCol().doc(id)
      const regRef = regsCol().doc(input.registrationId)
      const ptxRef = adminDb.collection('platformTransactions').doc(`ptx_${input.registrationId}`)
      const [recSnap, regS, intentS, ptxS] = await Promise.all([tx.get(recRef), tx.get(regRef), tx.get(intentDoc.ref), tx.get(ptxRef)])
      if (recSnap.exists) {
        const r = recSnap.data() as ManualRefundDocument
        if (r.amountPaise === input.amountPaise && r.method === method) return { ok: true, record: r, duplicate: true }
        return fail(409, 'IDEMPOTENCY_CONFLICT', 'This request key was already used for a different refund. Nothing was recorded.')
      }
      const recordedRefunds = paymentId
        ? await tx.get(adminDb.collection(REGISTRATION_REFUNDS_COLLECTION).where('gatewayPaymentId', '==', paymentId).limit(20))
        : null
      const reg = regS.data() as { paymentStatus?: unknown; organizerUid?: unknown; eventSlug?: unknown } | undefined
      if (!reg) return fail(404, 'NOT_FOUND', 'Registration not found.')
      if (reg.paymentStatus !== 'paid') return refuse('NOT_PAID')
      const organizerUid = typeof reg.organizerUid === 'string' ? reg.organizerUid : ''
      if (!organizerUid) return fail(409, 'NO_ORGANIZER', 'This registration has no organizer to account the refund against.')
      const intent = intentS.data() as { amount?: unknown; registrationId?: unknown; gatewayRefundsPaise?: unknown; manualRefundsPaise?: unknown } | undefined
      if (!intent || intent.registrationId !== input.registrationId) return refuse('NO_PAYMENT_RECORD', 422)
      if (hasCountedGatewayRefunds(intent.gatewayRefundsPaise)) return refuse('GATEWAY_REFUND_EXISTS')
      if (recordedRefunds?.docs.some(d => d.get('status') !== 'failed')) return refuse('GATEWAY_REFUND_EXISTS')
      if (!ptxS.exists) return refuse('NO_LEDGER_ENTRY', 422)
      const ptx = ptxS.data() as { status?: unknown; releaseStatus?: unknown; releaseHold?: unknown }
      if (ptx.status !== 'completed') return refuse('LEDGER_REVERSED')
      const charged = typeof intent.amount === 'number' ? intent.amount : 0
      const amount = checkRefundAmount(input.amountPaise, charged, sumManualRefunds(intent.manualRefundsPaise))
      if (!amount.ok) return refuse(amount.code, 400)

      const holdSettlement = ptx.releaseStatus === 'pending'
      const now = FieldValue.serverTimestamp()
      const record: ManualRefundDocument = {
        id, registrationId: input.registrationId,
        eventSlug: typeof reg.eventSlug === 'string' ? reg.eventSlug : null, organizerUid,
        orderId: intentDoc.id, paymentId, provider,
        amountPaise: amount.amountPaise, chargedPaise: charged, currency: 'INR',
        method, recipient, reason: input.reason, status: 'pending',
        requestedBy: input.adminUid, requestedAt: now, gatewayCheck, heldSettlement: holdSettlement,
      }
      tx.set(recRef, record)
      // The SAME claim the gateway refund route takes: it refuses anything not 'paid', and the webhook never
      // applies a refund's side effects to a refund_pending registration that is not its own claim.
      tx.update(regRef, {
        paymentStatus: 'refund_pending',
        refundClaim:   { kind: 'manual', manualRefundId: id, paymentId, amountPaise: amount.amountPaise, by: input.adminUid, at: now },
        updatedAt:     now,
      })
      tx.set(intentDoc.ref, { manualRefundsPaise: { [id]: amount.amountPaise }, updatedAt: now }, { merge: true })
      if (holdSettlement) {
        tx.update(ptxRef, { releaseStatus: 'held', manualRefundHold: { refundId: id, heldAt: now }, updatedAt: now })
      }
      stageAdminAudit(tx, {
        adminUid: input.adminUid, actorRole: 'super_admin', action: 'registration.manual_refund_requested',
        entityType: 'registration', entityId: input.registrationId, reason: input.reason,
        metadata: { manualRefundId: id, amountPaise: amount.amountPaise, chargedPaise: charged, method, recipientName: recipient.name, gatewayCheck, heldSettlement: holdSettlement },
        correlation: { registrationId: input.registrationId, orderId: intentDoc.id, paymentId, organizerUid, eventId: record.eventSlug },
      }, `manual_refund_requested_${id}`)
      return { ok: true, record, duplicate: false }
    })
}

// ─── complete (checker) ──────────────────────────────────────────────────────────────────────

export async function completeManualRefund(input: {
  id: string; adminUid: string; reference: unknown; transferredOn: string; note: string
}): Promise<ManualRefundResult> {
  const reference = canonicalReference(input.reference)
  if (!reference) return fail(422, 'INVALID_REFERENCE', 'The transfer reference (UTR / receipt number) must be letters and digits only (spaces, hyphens and underscores are ignored), up to 64 characters.')

  let clawback: { clawbackId: string; outstandingPaise: number } | null = null
  let reviewed: string[] = []
  const out = await adminDb.runTransaction<ManualRefundResult & { full?: boolean }>(async tx => {
    clawback = null; reviewed = []
    const recRef = recordsCol().doc(input.id)
    const recSnap = await tx.get(recRef)
    if (!recSnap.exists) return fail(404, 'NOT_FOUND', 'Manual refund not found.')
    const rec = recSnap.data() as ManualRefundDocument
    if (rec.status === 'completed') {
      return rec.reference === reference ? { ok: true, record: rec, duplicate: true }
        : fail(409, 'ALREADY_COMPLETED', 'This refund was already completed with a different reference.')
    }
    if (rec.status === 'cancelled') return fail(409, 'CANCELLED', 'This refund request was cancelled.')
    // Maker-checker — no bypass: the Super Admin who requested the refund cannot complete it.
    if (rec.requestedBy === input.adminUid) return fail(409, 'MAKER_CHECKER_REQUIRED', 'You requested this refund, so a different Super Admin must record its completion. This control cannot be bypassed.')

    const regRef    = regsCol().doc(rec.registrationId)
    const intentRef = adminDb.collection('paymentIntents').doc(rec.orderId)
    const ptxRef    = adminDb.collection('platformTransactions').doc(`ptx_${rec.registrationId}`)
    const walletRef = adminDb.collection('organizerRevenueWallets').doc(rec.organizerUid)
    const refRef    = adminDb.collection(MANUAL_REFUND_REFERENCES_COLLECTION).doc(reference)
    const payoutRef = adminDb.collection(TRANSFER_REFERENCES_COLLECTION).doc(reference)
    const [regS, intentS, ptxS, walletS, refS, payoutRefS] = await Promise.all([
      tx.get(regRef), tx.get(intentRef), tx.get(ptxRef), tx.get(walletRef), tx.get(refRef), tx.get(payoutRef),
    ])
    if (refS.exists || payoutRefS.exists) return fail(409, 'REFERENCE_IN_USE', 'This transfer reference is already recorded against another refund or payout. Nothing was recorded — investigate before retrying.')

    const reg = regS.data() as { paymentStatus?: unknown; refundClaim?: { kind?: unknown; manualRefundId?: unknown }; manualRefunds?: { refundedPaise?: unknown; count?: unknown } } | undefined
    if (!reg || reg.paymentStatus !== 'refund_pending' || reg.refundClaim?.kind !== 'manual' || reg.refundClaim?.manualRefundId !== rec.id) {
      return fail(409, 'CLAIM_MISMATCH', 'The registration no longer carries this refund\'s claim. Nothing was recorded — reconcile it manually.')
    }
    const intent = intentS.data() as { gatewayRefundsPaise?: unknown; manualRefundsPaise?: Record<string, unknown> } | undefined
    if (!intent || intent.manualRefundsPaise?.[rec.id] !== rec.amountPaise) {
      return fail(409, 'CLAIM_MISMATCH', 'The payment record no longer carries this refund. Nothing was recorded — reconcile it manually.')
    }
    // A gateway refund of this payment was counted after the request (it was held for review by the webhook):
    // completing would record the attendee repaid twice. A human decides.
    if (hasCountedGatewayRefunds(intent.gatewayRefundsPaise)) {
      return fail(409, 'GATEWAY_REFUND_CONFLICT', 'A gateway refund of this payment was recorded after this request. Nothing was recorded — the settlement is held for review.')
    }
    if (!ptxS.exists) return refuse('NO_LEDGER_ENTRY', 422)
    const ptx = ptxS.data() as Record<string, unknown> & {
      status?: unknown; releaseStatus?: unknown; releaseHold?: unknown; netSettlementPaise?: unknown
      manualRefund?: { reversedNetPaise?: unknown; refundedGrossPaise?: unknown }; manualRefundHold?: { refundId?: unknown }
    }
    if (ptx.status !== 'completed') return refuse('LEDGER_REVERSED')

    const net = typeof ptx.netSettlementPaise === 'number' ? ptx.netSettlementPaise : 0
    const priorGross = typeof ptx.manualRefund?.refundedGrossPaise === 'number' ? ptx.manualRefund.refundedGrossPaise : 0
    const priorNet   = typeof ptx.manualRefund?.reversedNetPaise === 'number' ? ptx.manualRefund.reversedNetPaise : 0
    const plan = planManualReversal({ chargedPaise: rec.chargedPaise, netPaise: net, alreadyRefundedGrossPaise: priorGross, refundGrossPaise: rec.amountPaise, alreadyReversedNetPaise: priorNet })

    // The bucket holding THIS settlement's net, from its releaseStatus read in this transaction ('held' ⇒ it was
    // never released ⇒ pending; 'released' ⇒ available). Unknown ⇒ fail closed before any write.
    const bucket = walletBucketForRelease(ptx.releaseStatus)
    if (plan.reversalNetPaise > 0 && !bucket) {
      return fail(409, 'LEDGER_STATE_UNKNOWN', 'The settlement\'s release state is unknown, so its refund cannot be accounted. Nothing was recorded.')
    }

    let debited = 0
    let walletUpdate: Record<string, unknown> | null = null
    if (plan.reversalNetPaise > 0 && walletS.exists && bucket) {
      const wallet = walletS.data() as OrganizerRevenueWallet
      const d = computeReversalDebit(wallet, plan.reversalNetPaise, bucket)
      debited = d.totalDebited
      const newAvailable = wallet.availablePaise - d.fromAvailable
      let newInTransit = Math.min(wallet.inTransitPaise ?? 0, newAvailable)   // invariant
      // The same payout review a gateway refund triggers, in THIS transaction (reads before writes): payout
      // requests the refund leaves unbacked are held for review; inTransit becomes the reservations kept.
      if (d.fromAvailable > 0) {
        const requests = await readOpenPayoutRequests(tx, rec.organizerUid)
        const refit = planPayoutRefit(requests, newAvailable)
        if (refit.toReview.length > 0) {
          stagePayoutReviews(tx, { organizerUid: rec.organizerUid, availablePaise: newAvailable, trigger: { kind: 'registration_refund', ref: rec.id }, plan: refit })
          newInTransit = refit.keptPaise
          reviewed = refit.toReview.map(r => r.id)
        }
      }
      walletUpdate = { pendingPaise: wallet.pendingPaise - d.fromPending, availablePaise: newAvailable, inTransitPaise: newInTransit, updatedAt: FieldValue.serverTimestamp() }
    }

    // ── writes ──
    const now = FieldValue.serverTimestamp()
    const reversalRowId = `ptx_mrefund_${rec.id}`
    if (walletUpdate) tx.update(walletRef, walletUpdate)
    // The shortfall (the net was already paid out / the wallet cannot cover it) is a durable debt, atomic with
    // the debit — keyed on THIS refund's reversal row, so partial refunds never collide.
    if (plan.reversalNetPaise > debited) {
      clawback = writeClawbackOnShortfall(tx, {
        transactionId: reversalRowId, organizerUid: rec.organizerUid, sourceType: 'registration', sourceId: rec.registrationId,
        reversalAmountPaise: plan.reversalNetPaise, debitedPaise: debited, reason: 'refund',
      })
    }
    // The reversal ledger row — the donation-refund shape: negative, linked to the original, never released.
    tx.set(adminDb.collection('platformTransactions').doc(reversalRowId), {
      id: reversalRowId,
      type: ptx.type ?? 'registration', category: ptx.category ?? 'registration',
      organizerUid: rec.organizerUid, entityId: ptx.entityId ?? rec.eventSlug ?? '', entityType: 'event',
      sourceId: rec.registrationId, sourceType: 'registration',
      payerName: ptx.payerName ?? '', payerEmail: ptx.payerEmail ?? '',
      grossAmountPaise: -rec.amountPaise,
      platformFeeBasePaise: 0, platformFeeGstPaise: 0, platformFeeTotalPaise: 0, gatewayFeeEstimatePaise: 0,
      netSettlementPaise: -plan.reversalNetPaise,
      feeModel: ptx.feeModel ?? 'organizer_pays', planTier: ptx.planTier ?? 'starter', feeConfigId: ptx.feeConfigId ?? 'fallback',
      currency: 'INR', gateway: ptx.gateway ?? rec.provider, ...(ptx.provider ? { provider: ptx.provider } : {}),
      gatewayPaymentId: rec.paymentId ?? '', gatewayOrderId: rec.orderId,
      status: 'refunded', parentTransactionId: `ptx_${rec.registrationId}`, refundId: rec.id,
      refundMethod: 'manual', manualRefundReference: reference,
      paidAt: now, createdAt: now, updatedAt: now,
    })
    // The original stays 'completed' (its net is reduced by the reversal rows, not flipped in place). The
    // cumulative manual reversal is recorded on it, so the release job moves only what is left of the net.
    const ourHold = rec.heldSettlement && ptx.manualRefundHold?.refundId === rec.id
    tx.update(ptxRef, {
      'manualRefund.reversedNetPaise':   priorNet + plan.reversalNetPaise,
      'manualRefund.refundedGrossPaise': priorGross + rec.amountPaise,
      'manualRefund.refundIds':          FieldValue.arrayUnion(rec.id),
      'manualRefund.fullyRefunded':      plan.fullyRefunded,
      ...(ourHold
        ? plan.fullyRefunded
          // Nothing is left to settle: it stays held (never released — there is nothing to release).
          ? { manualRefundHold: { refundId: rec.id, heldAt: (ptx.manualRefundHold as { heldAt?: unknown }).heldAt ?? now, fullyRefunded: true } }
          // A partial refund: the remainder settles normally — unless another hold (a refund review) remains.
          : { manualRefundHold: FieldValue.delete(), ...(ptx.releaseHold ? {} : { releaseStatus: 'pending' }) }
        : {}),
      updatedAt: now,
    })
    const totalRefunded = priorGross + rec.amountPaise
    tx.update(regRef, {
      refundClaim: FieldValue.delete(),
      manualRefunds: {
        refundedPaise: totalRefunded,
        count: (typeof reg.manualRefunds?.count === 'number' ? reg.manualRefunds.count : 0) + 1,
        lastRefundId: rec.id,
      },
      ...(plan.fullyRefunded
        ? { paymentStatus: 'refunded', refundId: rec.id, refundAmount: totalRefunded, refundMethod: 'manual', refundedAt: now }
        : { paymentStatus: 'paid' }),
      updatedAt: now,
    })
    tx.create(refRef, {
      reference, manualRefundId: rec.id, registrationId: rec.registrationId, organizerUid: rec.organizerUid,
      amountPaise: rec.amountPaise, method: rec.method, recordedBy: input.adminUid, createdAt: now,
    })
    const accounting = {
      reversalNetPaise: plan.reversalNetPaise, debitedPaise: debited, clawbackId: (clawback as { clawbackId: string } | null)?.clawbackId ?? null,
      fullyRefunded: plan.fullyRefunded, bucket: (bucket ?? 'pending') as 'pending' | 'available',
    }
    tx.update(recRef, {
      status: 'completed', completedBy: input.adminUid, completedAt: now,
      reference, transferredOn: input.transferredOn, completionNote: input.note, accounting,
    })
    stageAdminAudit(tx, {
      adminUid: input.adminUid, actorRole: 'super_admin', action: 'registration.manual_refund_completed',
      entityType: 'registration', entityId: rec.registrationId, reason: input.note,
      changedFields: ['paymentStatus', 'manualRefunds'],
      before: { paymentStatus: 'refund_pending' }, after: { paymentStatus: plan.fullyRefunded ? 'refunded' : 'paid' },
      metadata: { manualRefundId: rec.id, amountPaise: rec.amountPaise, reference, transferredOn: input.transferredOn, method: rec.method, requestedBy: rec.requestedBy, makerChecker: 'distinct_approver', ...accounting },
      correlation: { registrationId: rec.registrationId, orderId: rec.orderId, paymentId: rec.paymentId, organizerUid: rec.organizerUid, eventId: rec.eventSlug, refundId: rec.id },
    }, `manual_refund_completed_${rec.id}`)
    const record: ManualRefundDocument = { ...rec, status: 'completed', completedBy: input.adminUid, reference, transferredOn: input.transferredOn, completionNote: input.note, accounting }
    return { ok: true, record, duplicate: false, full: plan.fullyRefunded }
  })

  if (out.ok && !out.duplicate) {
    const c = clawback as { clawbackId: string; outstandingPaise: number } | null
    if (c) await logClawbackEvent('system', 'clawback.created', c.clawbackId, { manualRefundId: input.id, outstandingPaise: c.outstandingPaise })
    if (reviewed.length) {
      captureFinancialError(new Error(`payout request(s) held for review after manual refund ${input.id}`), {
        scope: 'manual_refund.payout_review_opened', manualRefundId: input.id, settlementIds: reviewed.join(','),
      })
    }
    // A fully refunded attendee no longer holds seats or credentials — the same follow-ups as a gateway refund
    // (best-effort, idempotent; the money and ledger are already committed above).
    if ((out as { full?: boolean }).full) {
      const r = out.record
      await writeAuditEntry(r.registrationId, 'refunded', input.adminUid, 'super_admin', r.organizerUid).catch(() => {})
      void releaseRegistrationSessions(r.registrationId).catch(err => captureFinancialError(err, { scope: 'manual_refund.session_release_failed', registrationId: r.registrationId }))
      void detachTimingTagByRegistration(r.registrationId, input.adminUid, 'refunded').catch(() => {})
        .then(() => releaseIdentifier(r.registrationId, input.adminUid, 'refunded', { allowWhileTagged: true })).catch(() => {})
    }
  }
  if (out.ok) {
    const { full: _full, ...rest } = out as ManualRefundResult & { full?: boolean }
    void _full
    return rest as ManualRefundResult
  }
  return out
}

// ─── cancel ──────────────────────────────────────────────────────────────────────────────────

export async function cancelManualRefund(input: { id: string; adminUid: string; reason: string }): Promise<ManualRefundResult> {
  return adminDb.runTransaction<ManualRefundResult>(async tx => {
    const recRef = recordsCol().doc(input.id)
    const recSnap = await tx.get(recRef)
    if (!recSnap.exists) return fail(404, 'NOT_FOUND', 'Manual refund not found.')
    const rec = recSnap.data() as ManualRefundDocument
    if (rec.status === 'cancelled') return { ok: true, record: rec, duplicate: true }
    if (rec.status === 'completed') return fail(409, 'ALREADY_COMPLETED', 'A completed refund cannot be cancelled — the money has been recorded as returned.')
    const regRef    = regsCol().doc(rec.registrationId)
    const intentRef = adminDb.collection('paymentIntents').doc(rec.orderId)
    const ptxRef    = adminDb.collection('platformTransactions').doc(`ptx_${rec.registrationId}`)
    const [regS, intentS, ptxS] = await Promise.all([tx.get(regRef), tx.get(intentRef), tx.get(ptxRef)])
    const intent = intentS.data() as { gatewayRefundsPaise?: unknown } | undefined
    // A gateway refund was counted meanwhile (the webhook held the settlement and opened a review). Completion is
    // refused in that state, so cancelling — "the manual transfer will not be made" — is the only way out of it.
    // The registration returns to the state the gateway review handles (as if no manual request existed); the
    // review's settlement hold (releaseHold) is left in place below. Flagged in the audit row.
    const gatewayConflict = hasCountedGatewayRefunds(intent?.gatewayRefundsPaise)
    const now = FieldValue.serverTimestamp()
    const reg = regS.data() as { paymentStatus?: unknown; refundClaim?: { kind?: unknown; manualRefundId?: unknown } } | undefined
    if (reg?.paymentStatus === 'refund_pending' && reg.refundClaim?.kind === 'manual' && reg.refundClaim.manualRefundId === rec.id) {
      tx.update(regRef, { paymentStatus: 'paid', refundClaim: FieldValue.delete(), updatedAt: now })
    }
    if (intentS.exists) tx.update(intentRef, { [`manualRefundsPaise.${rec.id}`]: FieldValue.delete(), updatedAt: now })
    const ptx = ptxS.data() as { releaseStatus?: unknown; releaseHold?: unknown; manualRefundHold?: { refundId?: unknown } } | undefined
    if (ptx && rec.heldSettlement && ptx.manualRefundHold?.refundId === rec.id) {
      tx.update(ptxRef, {
        manualRefundHold: FieldValue.delete(),
        ...(ptx.releaseStatus === 'held' && !ptx.releaseHold ? { releaseStatus: 'pending' } : {}),
        updatedAt: now,
      })
    }
    tx.update(recRef, { status: 'cancelled', cancelledBy: input.adminUid, cancelledAt: now, cancelReason: input.reason })
    stageAdminAudit(tx, {
      adminUid: input.adminUid, actorRole: 'super_admin', action: 'registration.manual_refund_cancelled',
      entityType: 'registration', entityId: rec.registrationId, reason: input.reason,
      metadata: { manualRefundId: rec.id, amountPaise: rec.amountPaise, requestedBy: rec.requestedBy, gatewayRefundConflict: gatewayConflict },
      correlation: { registrationId: rec.registrationId, orderId: rec.orderId, paymentId: rec.paymentId, organizerUid: rec.organizerUid, refundId: rec.id },
    }, `manual_refund_cancelled_${rec.id}`)
    return { ok: true, record: { ...rec, status: 'cancelled', cancelledBy: input.adminUid, cancelReason: input.reason }, duplicate: false }
  })
}

export async function listManualRefunds(registrationId: string): Promise<ManualRefundDocument[]> {
  const snap = await recordsCol().where('registrationId', '==', registrationId).limit(50).get()
  return snap.docs.map(d => d.data() as ManualRefundDocument)
}
