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

import { NextRequest, NextResponse }    from 'next/server'
import { captureFinancialError }         from '@/lib/monitoring/sentry'
import { releaseRegistrationSessions }   from '@/lib/sessions/allocation'
import { FieldValue }                   from 'firebase-admin/firestore'
import { adminDb }                      from '@/lib/firebase/admin'
import { resolveAdminUid }              from '@/lib/admin/auth'
import { logAdminAction }               from '@/lib/admin/audit'
import { razorpay }                     from '@/lib/razorpay/client'
import { updatePaymentIntentRefund }    from '@/lib/firebase/firestore/paymentIntents'
import { reversePlatformTransactionAndDebit } from '@/lib/firebase/firestore/platformTransactions'

// ─── Response type ────────────────────────────────────────────────────────────

export interface RetryRefundResponse {
  id:       string
  refundId: string
  status:   'retried'
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
}

// ─── POST ─────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { id } = await ctx.params

  const docRef = adminDb.collection('failedRefunds').doc(id)

  // Atomically CLAIM the retry (open → retrying) BEFORE calling Razorpay, so a
  // concurrent retry (double-click / two admins) cannot BOTH read 'open' and both
  // fire a gateway refund (H-2 double-refund). A non-'open' record aborts here;
  // the gateway is reverted to 'open' below if the Razorpay call itself fails.
  const claim = await adminDb.runTransaction<
    { ok: true; data: FailedRefundDoc } | { ok: false; status: number; error: string }
  >(async txn => {
    const fresh = await txn.get(docRef)
    if (!fresh.exists) return { ok: false, status: 404, error: 'Failed refund not found' }
    const d = fresh.data() as FailedRefundDoc
    if (d.status !== 'open') return { ok: false, status: 409, error: `Cannot retry a refund in status '${d.status}'` }
    txn.update(docRef, { status: 'retrying', updatedAt: FieldValue.serverTimestamp() })
    return { ok: true, data: d }
  })
  if (!claim.ok) return NextResponse.json({ error: claim.error }, { status: claim.status })

  const { paymentId, amountPaise, orderId, registrationId } = claim.data

  // ── Call Razorpay ──────────────────────────────────────────────────────────

  let refundId: string
  try {
    const refund = await razorpay.payments.refund(paymentId, {
      amount:  amountPaise,
      speed:   'optimum',
      notes:   { reason: 'admin_retry', failedRefundId: id },
      receipt: `retry_${id}`.slice(0, 40),
    })
    refundId = refund.id
  } catch (err) {
    captureFinancialError(err, { scope: 'failed-refunds.retry_razorpay_failed', id, paymentId })
    // Release the claim so the record can be retried again.
    await docRef.update({ status: 'open', updatedAt: FieldValue.serverTimestamp() }).catch(() => {})
    return NextResponse.json(
      { error: 'Razorpay refund failed. Verify the payment ID is in a refundable state.' },
      { status: 502 },
    )
  }

  // ── Update failedRefunds record ────────────────────────────────────────────

  await docRef.update({
    status:        'retried',
    retryRefundId: refundId,
    retriedAt:     FieldValue.serverTimestamp(),
    retriedBy:     adminUid,
    updatedAt:     FieldValue.serverTimestamp(),
  })

  // ── Update paymentIntents (best-effort) ────────────────────────────────────

  void updatePaymentIntentRefund(orderId, refundId, 'pending', amountPaise)
    .catch(err => captureFinancialError(err, { scope: 'failed-refunds.retry_intent_update_failed', orderId }))

  // ── Update registration + reverse ledger + debit wallet (fire-and-forget) ─
  // Mark refunded immediately — the refund.processed webhook may not fire
  // if Razorpay isn't configured to send it to this endpoint.
  // reversePlatformTransaction returns the PRE-UPDATE snapshot — if its status
  // was already 'refunded' the wallet debit was already applied; skip to prevent
  // double-debit.

  if (registrationId) {
    void (async () => {
      try {
        const regRef  = adminDb.doc(`registrations/${registrationId}`)
        const regSnap = await regRef.get()

        if (!regSnap.exists) {
          console.warn('[admin/failed-refunds/retry] Registration not found for ledger reversal:', registrationId)
          return
        }

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
        await reversePlatformTransactionAndDebit(`ptx_${registrationId}`)
      } catch (err) {
        captureFinancialError(err, { scope: 'failed-refunds.retry_ledger_update_failed', registrationId })
      }
    })()
  }

  // ── Fire-and-forget audit log ──────────────────────────────────────────────

  void logAdminAction({
    adminUid,
    action:     'failed_refund.retry',
    entityType: 'failed_refund',
    entityId:   id,
    metadata:   { refundId, paymentId, amountPaise },
  }).catch((err: unknown) => captureFinancialError(err, { scope: 'failed-refunds.retry_audit_failed', id }))

  return NextResponse.json({ id, refundId, status: 'retried' } satisfies RetryRefundResponse)
}
