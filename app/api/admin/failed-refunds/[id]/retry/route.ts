// POST /api/admin/failed-refunds/[id]/retry
//
// Retries the Razorpay refund for an open failed refund record.
// Only 'open' records can be retried; 409 for any other status.
//
// On success:
//   - failedRefunds/{id} status → 'retried', stores retryRefundId/retriedAt/retriedBy
//   - paymentIntents/{orderId} updated (best-effort)
//   - registrations/{registrationId} paymentStatus → 'refunded' (best-effort, if set)
//   - Audit log: failed_refund.retry
//
// RD-PHASE4-S1 · C4 — NEVER A SECOND REFUND. Before calling the gateway, the payment's existing
// refunds are looked up (three states, fail CLOSED):
//   • a non-failed refund of exactly this amount exists → it IS this refund (a previous attempt that
//     timed out after Razorpay processed it): the record is reconciled to it; no gateway refund call;
//   • the lookup fails, is malformed, or finds any OTHER non-failed refund on the payment → uncertain:
//     no refund call, the record goes back to 'open' for a safe manual reconciliation (409);
//   • no refund exists → the retry proceeds (once — the transactional claim still guards concurrency).
//
// RD-PHASE4-S4 — a reason (3–500 chars, D3) is required; a captured-payment HOLD may be retried only
// once a Super Admin approved it for refund through the review workflow (`reviewApproval`, D4);
// and every side effect after the gateway refund is AWAITED (F9) — the registration update and the
// ledger reversal no longer run in a detached promise. Once the money has moved a failed follow-up
// is recorded for reconciliation and the response still reports the refund truthfully.

import { NextRequest, NextResponse }    from 'next/server'
import { captureFinancialError }         from '@/lib/monitoring/sentry'
import { releaseRegistrationSessions }   from '@/lib/sessions/allocation'
import { FieldValue }                   from 'firebase-admin/firestore'
import { adminDb }                      from '@/lib/firebase/admin'
import { logAdminActionOrRecord }       from '@/lib/admin/audit'
import { requireSuperAdmin, parseFinancialReason, reasonErrorResponse } from '@/lib/admin/financialGuard'
import { recordRefundLedgerReconciliation } from '@/lib/payments/registrationReconciliation'
import { razorpay }                     from '@/lib/razorpay/client'
import { updatePaymentIntentRefund }    from '@/lib/firebase/firestore/paymentIntents'
import { reversePlatformTransactionAndDebit } from '@/lib/firebase/firestore/platformTransactions'
import { ensureRegistrationRefundRecord } from '@/lib/refunds/registrationRefunds'
import { readProvider }                  from '@/lib/payments/providers/types'

// ─── Response type ────────────────────────────────────────────────────────────

export interface RetryRefundResponse {
  id:       string
  refundId: string
  status:   'retried'
  /** RD-PHASE4-S1 · C4 — true when an EXISTING gateway refund was adopted instead of creating one. */
  reconciled?: boolean
  /** RD-PHASE4-S4 — the refund went through but a follow-up step failed and was recorded. */
  reconciliation?: string[]
}

type ExistingRefundLookup =
  | { kind: 'found'; refundId: string }
  | { kind: 'none' }
  | { kind: 'uncertain'; why: string }

/**
 * RD-PHASE4-S1 · C4 — has the gateway ALREADY refunded this payment? Unlike the registration route's
 * lookup (which falls through to create on failure), this one fails CLOSED: anything but a clear
 * answer is 'uncertain', and an uncertain retry never calls the gateway.
 */
async function findExistingGatewayRefund(paymentId: string, amountPaise: number): Promise<ExistingRefundLookup> {
  let res: { items?: unknown } | null | undefined
  try {
    res = await razorpay.payments.fetchMultipleRefund(paymentId) as { items?: unknown } | null | undefined
  } catch {
    return { kind: 'uncertain', why: 'lookup_failed' }
  }
  if (!res || !Array.isArray(res.items)) return { kind: 'uncertain', why: 'lookup_malformed' }
  const live = (res.items as Array<{ id?: unknown; amount?: unknown; status?: unknown } | null>)
    .filter((r): r is { id?: unknown; amount?: unknown; status?: unknown } => !!r && r.status !== 'failed')
  if (live.length === 0) return { kind: 'none' }
  const exact = live.filter(r => r.amount === amountPaise && typeof r.id === 'string' && r.id)
  if (exact.length === 1 && live.length === 1) return { kind: 'found', refundId: exact[0].id as string }
  // More than one live refund, or one of a different amount: the payment has been (partly)
  // refunded some other way — never guess which one is ours, and never add another.
  return { kind: 'uncertain', why: exact.length > 1 ? 'multiple_matching_refunds' : 'other_refund_on_payment' }
}

// ─── Route context ────────────────────────────────────────────────────────────

interface RouteContext {
  params: Promise<{ id: string }>
}

// ─── Internal doc shape ───────────────────────────────────────────────────────

interface FailedRefundDoc {
  orderId:        string
  paymentId:      string
  amountPaise:    number
  reason:         string
  registrationId: string | null
  status:         string
  kind?:          string   // 'duplicate_hold' must never be refunded here
  /** RD-PHASE4-S4 · D4 — set by the review workflow when a Super Admin approved a hold for refund. */
  reviewApproval?: { by?: string; reason?: string }
}

/** Captured-payment holds (settleCapturedRegistration) — refundable only after review approval. */
const HOLD_KINDS = new Set(['duplicate_hold', 'settlement_hold', 'duplicate_payment_hold'])

// ─── POST ─────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  const guard = await requireSuperAdmin(req)
  if (guard.response) return guard.response
  const adminUid = guard.uid

  const { id } = await ctx.params

  // RD-PHASE4-S4 · D3 — a reason, before anything is claimed.
  let body: { reason?: unknown } = {}
  try { body = await req.json() as { reason?: unknown } } catch { body = {} }
  const reasonCheck = parseFinancialReason(body.reason)
  if (!reasonCheck.ok) return reasonErrorResponse(reasonCheck)
  const reason = reasonCheck.reason

  const docRef = adminDb.collection('failedRefunds').doc(id)

  // Atomically CLAIM the retry (open → retrying) BEFORE calling Razorpay, so a
  // concurrent retry (double-click / two admins) cannot BOTH read 'open' and both
  // fire a gateway refund (H-2 double-refund). A non-'open' record aborts here;
  // the gateway is reverted to 'open' below if the Razorpay call itself fails.
  const claim = await adminDb.runTransaction<
    { ok: true; data: FailedRefundDoc; intent?: { organizerUid?: string; eventSlug?: string } } | { ok: false; status: number; error: string }
  >(async txn => {
    const fresh = await txn.get(docRef)
    if (!fresh.exists) return { ok: false, status: 404, error: 'Failed refund not found' }
    const d = fresh.data() as FailedRefundDoc
    // RD-FIN-02 · read the payment intent in THIS transaction (reads before the claim write).
    const pi = d.orderId
      ? (await txn.get(adminDb.doc(`paymentIntents/${d.orderId}`))).data() as
          { status?: string; paymentId?: string; registrationId?: string; provider?: unknown; organizerUid?: string; eventSlug?: string } | undefined
      : undefined
    // A non-Razorpay payment must never be sent to Razorpay's refund API.
    if (pi && readProvider(pi.provider) !== 'razorpay') {
      return { ok: false as const, status: 409, error: 'This payment was not taken through Razorpay — refund it through its own provider.' }
    }
    // R1 — a held payment that now BACKS a confirmed registration must not be refunded from here.
    if (d.kind && HOLD_KINDS.has(d.kind) && pi?.status === 'paid' && pi.registrationId && (!pi.paymentId || pi.paymentId === d.paymentId)) {
      return { ok: false as const, status: 409, error: 'This payment now backs a confirmed registration — it must not be refunded from the hold queue. Resolve the hold.' }
    }
    // RD-PAY-DUP-HOLD — a duplicate hold is a captured payment we deliberately did NOT
    // refund. `status: 'review'` already fails the check below, so this is defence in depth:
    // it states the rule explicitly so a future change to the status vocabulary cannot turn
    // this endpoint into the automatic refund the hold exists to avoid.
    // RD-PHASE4-S4 · D4 — ...unless a Super Admin explicitly approved THIS hold for refund in the
    // review workflow, which is recorded on the record and audited.
    if (d.kind && HOLD_KINDS.has(d.kind) && !d.reviewApproval?.by) {
      return { ok: false as const, status: 409, error: 'This is a captured-payment hold, not a failed refund. Approve it for refund from the Review queue first — it must not be auto-refunded.' }
    }
    // 'pending' is the legacy licensing spelling of 'open' (see the list route).
    if (d.status !== 'open' && d.status !== 'pending') return { ok: false, status: 409, error: `Cannot retry a refund in status '${d.status}'` }
    txn.update(docRef, { status: 'retrying', updatedAt: FieldValue.serverTimestamp() })
    return { ok: true, data: d, intent: pi ? { organizerUid: pi.organizerUid, eventSlug: pi.eventSlug } : undefined }
  })
  if (!claim.ok) return NextResponse.json({ error: claim.error }, { status: claim.status })

  const { paymentId, amountPaise, orderId, registrationId } = claim.data

  // ── RD-PHASE4-S1 · C4 — was this payment already refunded at the gateway? ────────

  const existing = await findExistingGatewayRefund(paymentId, amountPaise)
  if (existing.kind === 'uncertain') {
    captureFinancialError(new Error(`existing-refund lookup ${existing.why}`), { scope: 'failed-refunds.retry_existing_refund_uncertain', id, paymentId })
    // Release the claim WITHOUT a gateway call: the record stays recoverable for a safe reconciliation.
    await docRef.update({ status: 'open', updatedAt: FieldValue.serverTimestamp() }).catch(() => {})
    return NextResponse.json(
      { error: 'Could not confirm whether this payment was already refunded, so no refund was issued. Check the payment in the Razorpay dashboard, then retry or resolve it.', code: 'REFUND_STATUS_UNCERTAIN' },
      { status: 409 },
    )
  }

  // ── Call Razorpay (only when no refund exists) ─────────────────────────────

  let refundId: string
  // RD-FIN-02 · the amount the GATEWAY refunded (exact for an adopted refund by construction).
  let refundedPaise = amountPaise
  const reconciled = existing.kind === 'found'
  if (existing.kind === 'found') {
    refundId = existing.refundId
  } else try {
    const refund = await razorpay.payments.refund(paymentId, {
      amount:  amountPaise,
      speed:   'optimum',
      notes:   { reason: 'admin_retry', failedRefundId: id },
      receipt: `retry_${id}`.slice(0, 40),
    })
    refundId = refund.id
    if (typeof (refund as { amount?: unknown }).amount === 'number') refundedPaise = (refund as { amount: number }).amount
  } catch (err) {
    captureFinancialError(err, { scope: 'failed-refunds.retry_razorpay_failed', id, paymentId })
    // Release the claim so the record can be retried again.
    await docRef.update({ status: 'open', updatedAt: FieldValue.serverTimestamp() }).catch(() => {})
    return NextResponse.json(
      { error: 'Razorpay refund failed. Verify the payment ID is in a refundable state.' },
      { status: 502 },
    )
  }

  // From here the money has MOVED (or an existing refund was adopted). Nothing below may turn that
  // into a failure response; each follow-up is awaited, and a failure is recorded for
  // reconciliation (RD-PHASE4-S4 · F9) instead of vanishing in a detached promise.
  const reconciliation: string[] = []

  // ── RD-FIN-02 · the gateway fact FIRST, in the refund ledger ───────────────
  // A refund issued here used to exist only on failedRefunds + the registration until (unless)
  // refund.processed arrived, so the Refunds figures and reports could miss it. Keyed by the gateway
  // refund id, so this path, the refund route and the webhook converge on ONE record (create-if-absent).
  try {
    await ensureRegistrationRefundRecord({
      razorpayRefundId: refundId, gatewayPaymentId: paymentId, gatewayOrderId: orderId,
      amountPaise: refundedPaise, origin: 'admin', initiatedBy: adminUid, reason: 'admin_retry',
      registrationId: registrationId ?? null,
      eventSlug: claim.intent?.eventSlug ?? null,
      organizerUid: claim.intent?.organizerUid ?? null,
      // A captured payment that never became a registration has nothing left to apply.
      ...(registrationId ? {} : { status: 'processed' as const }),
      metadata: { failedRefundId: id, ...(claim.data.kind ? { holdKind: claim.data.kind } : {}), ...(reconciled ? { reconciledExistingRefund: true } : {}) },
    })
  } catch (err) {
    captureFinancialError(err, { scope: 'failed-refunds.retry_refund_record_failed', id, refundId })
    reconciliation.push('refund_record_failed')
  }

  // ── Update failedRefunds record ────────────────────────────────────────────

  try {
    await docRef.update({
      status:        'retried',
      retryRefundId: refundId,
      retryRefundAmountPaise: refundedPaise,
      retriedAt:     FieldValue.serverTimestamp(),
      retriedBy:     adminUid,
      retryReason:   reason,
      ...(reconciled ? { reconciledExistingRefund: true } : {}),
      updatedAt:     FieldValue.serverTimestamp(),
    })
  } catch (err) {
    // The record stays 'retrying' — a further retry is refused, and the gateway id is in the audit.
    captureFinancialError(err, { scope: 'failed-refunds.retry_record_update_failed', id, refundId })
    reconciliation.push('record_update_failed')
  }

  // ── Update paymentIntents ──────────────────────────────────────────────────

  // RD-FIN-02 · B6 — a duplicate-payment hold's refund is of a DIFFERENT payment than the one that
  // settled this order: stamping it on the paid intent would make the settled attendee read "refunded".
  if (claim.data.kind !== 'duplicate_payment_hold') {
    await updatePaymentIntentRefund(orderId, refundId, 'pending', refundedPaise)
      .catch(err => {
        captureFinancialError(err, { scope: 'failed-refunds.retry_intent_update_failed', orderId })
        reconciliation.push('payment_intent_update_failed')
      })
  }

  // ── Update registration + reverse ledger + debit wallet (awaited) ─────────
  // Mark refunded immediately — the refund.processed webhook may not fire
  // if Razorpay isn't configured to send it to this endpoint.
  // reversePlatformTransaction returns the PRE-UPDATE snapshot — if its status
  // was already 'refunded' the wallet debit was already applied; skip to prevent
  // double-debit.

  if (registrationId) {
    try {
      const regRef  = adminDb.doc(`registrations/${registrationId}`)
      const regSnap = await regRef.get()

      if (!regSnap.exists) {
        console.warn('[admin/failed-refunds/retry] Registration not found for ledger reversal:', registrationId)
      } else {
        const regData = regSnap.data() as { paymentStatus?: string; organizerUid?: string }

        // Update registration paymentStatus (idempotent — may already be 'refunded'
        // if the refund.processed webhook fired first).
        if (regData.paymentStatus !== 'refunded') {
          await regRef.update({
            paymentStatus: 'refunded',
            refundId,
            refundAmount:  amountPaise,
            refundedAt:    FieldValue.serverTimestamp(),
            updatedAt:     FieldValue.serverTimestamp(),
          })
        }

        // P1-1: release held conference session seats (idempotent; reconciliation backstop).
        await releaseRegistrationSessions(registrationId)
          .catch(err => captureFinancialError(err, { scope: 'failed-refunds.retry_session_release_failed', registrationId }))

        // Reverse platform ledger + debit wallet — ATOMIC (status flip + debit in
        // one transaction; idempotent). The organizerUid + amount are read from
        // the ledger entry itself, so concurrent reversal from the refund.processed
        // webhook cannot double-debit.
        try {
          await reversePlatformTransactionAndDebit(`ptx_${registrationId}`)
        } catch (err) {
          captureFinancialError(err, { scope: 'failed-refunds.retry_ledger_update_failed', registrationId })
          // The same durable, idempotent backstop the registration refund route uses (cron drain).
          await recordRefundLedgerReconciliation({
            registrationId,
            ptxId:        `ptx_${registrationId}`,
            organizerUid: typeof regData.organizerUid === 'string' ? regData.organizerUid : '',
            error:        err instanceof Error ? err.message : 'ledger reversal failed',
          })
          reconciliation.push('ledger_reversal_deferred')
        }
      }
    } catch (err) {
      captureFinancialError(err, { scope: 'failed-refunds.retry_registration_update_failed', registrationId })
      reconciliation.push('registration_update_failed')
    }
  }

  // ── Audit (awaited; a failed write is recorded, never thrown) ────────────────

  await logAdminActionOrRecord({
    adminUid,
    actorRole:  'super_admin',
    action:     'failed_refund.retry',
    entityType: 'failed_refund',
    entityId:   id,
    reason,
    metadata:   {
      refundId, paymentId, amountPaise,
      ...(reconciled ? { reconciledExistingRefund: true } : {}),
      ...(claim.data.reviewApproval?.by ? { reviewApprovedBy: claim.data.reviewApproval.by, holdKind: claim.data.kind ?? null } : {}),
      ...(reconciliation.length ? { reconciliation } : {}),
    },
    correlation: { failedRefundId: id, refundId, paymentId, orderId, registrationId },
  })

  return NextResponse.json({
    id, refundId, status: 'retried',
    ...(reconciled ? { reconciled: true } : {}),
    ...(reconciliation.length ? { reconciliation } : {}),
  } satisfies RetryRefundResponse)
}
