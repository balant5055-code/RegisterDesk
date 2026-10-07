// POST /api/admin/failed-refunds/[id]/review
//
// RD-PHASE4-S4 · D4 — the resolution workflow for captured-payment HOLDS (`status: 'review'`,
// kind 'duplicate_hold' | 'settlement_hold', written by lib/payments/settleCapturedRegistration).
// A hold is money RegisterDesk captured and deliberately did NOT refund or register. Super Admin
// only; a 3–500 character reason; ONE transaction per decision with the audit row staged in it.
//
// Body: { action: 'approve_refund' | 'resolve', reason: string }
//
//   approve_refund → the hold becomes an ordinary OPEN refund record carrying `reviewApproval`
//                    {by, at, reason}. Nothing is refunded here: the money only moves through the
//                    existing retry route (Super Admin, reason, fail-closed existing-refund lookup),
//                    which accepts a hold ONLY when it carries this approval.
//   resolve        → closes the hold ('resolved') ONLY when the outcome is already a verified fact:
//                    a registration was settled for this order (explicit recovery), or the payment
//                    is fully refunded at the gateway. The evidence is recorded on the record and in
//                    the audit row. Without evidence → 409 HOLD_OUTCOME_UNVERIFIED (nothing changes).
//
// Deliberately NOT offered: closing a hold while keeping the captured money ("ignore"). That is a
// policy decision this workflow does not invent. Every transition is idempotent (re-applying a
// decision to a record that is no longer in 'review' is a 409, never a second change), and the
// gateway identifiers on the record (orderId, paymentId) are never modified.

import { NextRequest, NextResponse } from 'next/server'
import { FieldValue }                from 'firebase-admin/firestore'
import { adminDb }                   from '@/lib/firebase/admin'
import { stageAdminAudit }           from '@/lib/admin/audit'
import { requireSuperAdmin, parseFinancialReason, reasonErrorResponse } from '@/lib/admin/financialGuard'
import { readProvider }              from '@/lib/payments/providers/types'

export interface ReviewHoldResponse {
  id:       string
  status:   'open' | 'resolved'
  evidence?: 'registration_settled' | 'refunded_at_gateway'
}

interface HoldDoc {
  orderId:     string
  paymentId:   string
  amountPaise: number
  status:      string
  kind?:       string
}

type Evidence =
  | { kind: 'registration_settled'; registrationId: string }
  | { kind: 'refunded_at_gateway'; refundedPaise: number; refundIds: string[] }
  | { kind: 'none' }
  | { kind: 'uncertain'; why: string }

/** Is this hold's outcome already a verified fact? Read-only; never moves money. */
async function findHoldEvidence(hold: HoldDoc): Promise<Evidence> {
  // 1. A registration settled for THIS order (e.g. an explicit orphaned-capture recovery).
  //    RD-FIN-02 · a duplicate_payment_hold's ORDER already has a registration — the FIRST payment's.
  //    That is not evidence about THIS payment, so it is looked up by the held payment id instead.
  const regs = hold.kind === 'duplicate_payment_hold'
    ? await adminDb.collection('registrations').where('paymentId', '==', hold.paymentId).limit(1).get()
    : await adminDb.collection('registrations').where('paymentOrderId', '==', hold.orderId).limit(1).get()
  if (!regs.empty) return { kind: 'registration_settled', registrationId: regs.docs[0].id }

  // 2. The payment fully refunded at the gateway. Only Razorpay exposes the refund list used here;
  //    for another provider there is no verified answer, so the hold stays in review.
  const intent = await adminDb.doc(`paymentIntents/${hold.orderId}`).get()
  if (intent.exists && readProvider((intent.data() as { provider?: unknown }).provider) !== 'razorpay') {
    return { kind: 'uncertain', why: 'provider_has_no_refund_lookup' }
  }
  let res: { items?: unknown } | null | undefined
  try {
    const { razorpay } = await import('@/lib/razorpay/client')
    res = await razorpay.payments.fetchMultipleRefund(hold.paymentId) as { items?: unknown } | null | undefined
  } catch {
    return { kind: 'uncertain', why: 'lookup_failed' }
  }
  if (!res || !Array.isArray(res.items)) return { kind: 'uncertain', why: 'lookup_malformed' }
  const live = (res.items as Array<{ id?: unknown; amount?: unknown; status?: unknown } | null>)
    .filter((r): r is { id: string; amount: number; status?: unknown } =>
      !!r && r.status !== 'failed' && typeof r.id === 'string' && typeof r.amount === 'number')
  const refundedPaise = live.reduce((s, r) => s + r.amount, 0)
  if (refundedPaise >= hold.amountPaise && refundedPaise > 0) {
    return { kind: 'refunded_at_gateway', refundedPaise, refundIds: live.map(r => r.id) }
  }
  return { kind: 'none' }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const guard = await requireSuperAdmin(req)
  if (guard.response) return guard.response
  const adminUid = guard.uid

  const { id } = await ctx.params
  let body: { action?: unknown; reason?: unknown }
  try { body = await req.json() as { action?: unknown; reason?: unknown } }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  const action = body.action
  if (action !== 'approve_refund' && action !== 'resolve') {
    return NextResponse.json({ error: "action must be 'approve_refund' or 'resolve'", code: 'INVALID_ACTION' }, { status: 400 })
  }
  const r = parseFinancialReason(body.reason)
  if (!r.ok) return reasonErrorResponse(r)
  const reason = r.reason

  const ref = adminDb.collection('failedRefunds').doc(id)

  // Evidence is gathered BEFORE the transaction (it may call the gateway, which must never run
  // inside a retried transaction); the transaction then re-checks the record is still in review.
  let evidence: Evidence = { kind: 'none' }
  if (action === 'resolve') {
    const pre = await ref.get()
    if (!pre.exists) return NextResponse.json({ error: 'Record not found' }, { status: 404 })
    const hold = pre.data() as HoldDoc
    if (hold.status !== 'review') {
      return NextResponse.json({ error: `Only a record in review can be resolved here (current: '${hold.status}').`, code: 'NOT_IN_REVIEW' }, { status: 409 })
    }
    evidence = await findHoldEvidence(hold)
    if (evidence.kind === 'none' || evidence.kind === 'uncertain') {
      return NextResponse.json({
        error: 'This hold cannot be closed yet: no registration was settled for this order and the payment is not fully refunded at the gateway. Approve it for refund, or recover the registration first.',
        code:  'HOLD_OUTCOME_UNVERIFIED',
        ...(evidence.kind === 'uncertain' ? { why: evidence.why } : {}),
      }, { status: 409 })
    }
  }

  const outcome = await adminDb.runTransaction<
    { ok: true; body: ReviewHoldResponse } | { ok: false; status: number; error: string; code: string }
  >(async tx => {
    const snap = await tx.get(ref)
    if (!snap.exists) return { ok: false, status: 404, error: 'Record not found', code: 'NOT_FOUND' }
    const hold = snap.data() as HoldDoc
    // Idempotent + race-safe: only a record STILL in review is decided; anything else is a 409.
    if (hold.status !== 'review') {
      return { ok: false, status: 409, error: `Only a record in review can be decided here (current: '${hold.status}').`, code: 'NOT_IN_REVIEW' }
    }
    const now = FieldValue.serverTimestamp()
    const correlation = { failedRefundId: id, orderId: hold.orderId, paymentId: hold.paymentId }

    if (action === 'approve_refund') {
      // RD-FIN-02 · R1 — never approve a refund of a payment that now BACKS a confirmed registration
      // (a recovery settled it before this fix, or in the hold-write window). Read in THIS transaction
      // so approval serializes against settlement, which writes the intent. Keyed on the payment id,
      // so a duplicate_payment_hold (the intent's paymentId is the FIRST payment) stays approvable.
      const pi = (await tx.get(adminDb.doc(`paymentIntents/${hold.orderId}`))).data() as
        { status?: string; paymentId?: string; registrationId?: string } | undefined
      if (pi?.status === 'paid' && pi.registrationId && (!pi.paymentId || pi.paymentId === hold.paymentId)) {
        return { ok: false, status: 409, error: 'This payment now backs a confirmed registration. Resolve the hold instead — refunding it would refund a live registration.', code: 'HOLD_PAYMENT_SETTLED' }
      }
      tx.update(ref, {
        status:         'open',
        reviewApproval: { by: adminUid, at: now, reason },
        updatedAt:      now,
      })
      stageAdminAudit(tx, {
        adminUid, actorRole: 'super_admin', action: 'failed_refund.review_refund_approved',
        entityType: 'failed_refund', entityId: id, reason,
        changedFields: ['status', 'reviewApproval'],
        before: { status: 'review' }, after: { status: 'open' },
        metadata: { kind: hold.kind ?? null, amountPaise: hold.amountPaise },
        correlation,
      })
      return { ok: true, body: { id, status: 'open' } }
    }

    const ev = evidence as Exclude<Evidence, { kind: 'none' } | { kind: 'uncertain' }>
    const evidenceRecord = ev.kind === 'registration_settled'
      ? { kind: ev.kind, registrationId: ev.registrationId }
      : { kind: ev.kind, refundedPaise: ev.refundedPaise, refundIds: ev.refundIds }
    tx.update(ref, {
      status:         'resolved',
      resolvedAt:     now,
      resolvedBy:     adminUid,
      resolvedReason: reason,
      reviewEvidence: evidenceRecord,
      updatedAt:      now,
    })
    stageAdminAudit(tx, {
      adminUid, actorRole: 'super_admin', action: 'failed_refund.review_resolved',
      entityType: 'failed_refund', entityId: id, reason,
      changedFields: ['status', 'resolvedAt', 'resolvedBy', 'resolvedReason', 'reviewEvidence'],
      before: { status: 'review' }, after: { status: 'resolved' },
      metadata: { kind: hold.kind ?? null, amountPaise: hold.amountPaise, evidence: evidenceRecord },
      correlation,
    })
    return { ok: true, body: { id, status: 'resolved', evidence: ev.kind } }
  })

  if (!outcome.ok) return NextResponse.json({ error: outcome.error, code: outcome.code }, { status: outcome.status })
  return NextResponse.json(outcome.body satisfies ReviewHoldResponse)
}
