// POST /api/admin/media-credits/refunds/{refundId}/decide
//
// The ONLY endpoint in the platform that can move money out of a credit purchase.
// Body: { approve: boolean, note?: string }
//
// ═══ ONE ENDPOINT, NOT TWO ═══════════════════════════════════════════════════
// Approve and reject share every guard — admin identity, the disabled check, the audit
// write, the status-transition rules — and differ only in which service call runs. Two
// routes would mean two copies of that preamble and two places for it to drift.
//
// ═══ 202 IS NOT AN ERROR ═════════════════════════════════════════════════════
// If the credits were debited but the gateway payout has not completed, the answer is 202.
// The refund is `approved`, the money is owed, and the reconciler will finish it. Returning
// a 5xx would invite the admin to approve again, and a second approval attempt is the one
// thing that must not read as "try harder".

import { NextRequest, NextResponse } from 'next/server'
import { resolveAdminUid } from '@/lib/admin/auth'
import { logAdminAction } from '@/lib/admin/audit'
import { getCreditPolicy } from '@/features/media-credits/services'
import { validateDecisionNote } from '@/features/media-credits/utils/refundEligibility'
import { refundService } from '@/features/media-credits/services/refundService'
import {
  CreditsDisabledError, InsufficientCreditsError, InvalidCreditOperationError,
  RefundNotAllowedError, RefundSettlementDeferredError,
} from '@/features/media-credits/errors'

type Params = { params: Promise<{ refundId: string }> }

export async function POST(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { refundId } = await params

  let approve: boolean, note: string | null
  try {
    const body = await req.json() as Record<string, unknown>
    if (typeof body.approve !== 'boolean') {
      return NextResponse.json({ error: 'approve must be a boolean' }, { status: 400 })
    }
    approve = body.approve

    // MC-12.1 · `refundNoteRequired` is now enforced. Shared validator — the admin dialogs
    // gate their submit button on the SAME function, so a note the dialog accepts is never
    // one this route refuses.
    const policy = await getCreditPolicy()
    const checked = validateDecisionNote(body.note, policy.refundNoteRequired)
    if (!checked.ok) {
      return NextResponse.json({ error: checked.message }, { status: 400 })
    }
    note = checked.note
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  try {
    if (!approve) {
      await refundService.rejectRefund({ refundId, adminUid, note })
      // Audited AFTER the decision commits — logging an action that then failed to happen
      // would make the audit trail a record of intentions rather than of events.
      await logAdminAction({
        adminUid, action: 'media_credit_refund.rejected',
        entityType: 'media_credit_refund', entityId: refundId, metadata: { note },
      })
      return NextResponse.json({ refundId, status: 'rejected' })
    }

    const result = await refundService.approveRefund({ refundId, adminUid, note })
    await logAdminAction({
      adminUid, action: 'media_credit_refund.approved',
      entityType: 'media_credit_refund', entityId: refundId,
      metadata: {
        note,
        refundAmountPaise: result.refundAmountPaise,
        gatewayRefundId:   result.gatewayRefundId,
      },
    })
    return NextResponse.json({ status: 'settled', ...result })
  } catch (err) {
    if (err instanceof RefundSettlementDeferredError) {
      // The debit COMMITTED. Audit it — the credits really did leave the wallet — and report
      // the payout as pending rather than as a failure.
      await logAdminAction({
        adminUid, action: 'media_credit_refund.approved_payout_pending',
        entityType: 'media_credit_refund', entityId: refundId,
        metadata: { note, cause: err.cause },
      }).catch(() => { /* the refund record is the source of truth, not the audit log */ })
      return NextResponse.json(
        { refundId, status: 'approved', pending: true, error: err.message, code: err.code },
        { status: 202 },
      )
    }
    if (err instanceof CreditsDisabledError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 403 })
    }
    if (err instanceof InsufficientCreditsError) {
      // The organizer spent the credits while the request sat in the queue. Nothing was
      // debited and nothing was paid — the approval rolled back whole.
      return NextResponse.json(
        { error: err.message, code: err.code, required: err.required, available: err.available },
        { status: 409 },
      )
    }
    if (err instanceof RefundNotAllowedError) {
      return NextResponse.json(
        { error: err.message, code: err.code, reason: err.reason }, { status: 409 },
      )
    }
    if (err instanceof InvalidCreditOperationError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 404 })
    }
    console.error('[admin/media-credits/decide] failed:', err)
    return NextResponse.json({ error: 'Could not record this decision.' }, { status: 503 })
  }
}
