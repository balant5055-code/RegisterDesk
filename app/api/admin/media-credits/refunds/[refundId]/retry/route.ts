// POST /api/admin/media-credits/refunds/{refundId}/retry
//
// MC-08. Retries the gateway payout for a refund parked at `approved`.
//
// ═══ WHY THIS IS SAFE TO EXPOSE, WHEN GRANT IS NOT ═══════════════════════════
// This makes no financial DECISION. The credits were already debited when an admin approved
// the refund; the money is already owed. All this does is ask the existing, idempotent
// `settleApprovedRefund` to try the payout again, which the reconciliation cron does on a
// schedule anyway — an operator should not have to wait ten minutes to retry a known failure.
//
// Manual granting was deferred for the opposite reason: it creates credits from nothing, and
// that is a new financial decision, not a retry of one already made.
//
// ═══ DOUBLE-PAYOUT IS PREVENTED BY THE CLAIM, NOT BY THIS ROUTE ══════════════
// MC-05.6A's `approved → settling` claim admits exactly one caller, and beneath it
// `refundPayment` asks Razorpay whether a refund tagged with this refundId already exists.
// An admin hammering this button races the cron harmlessly.

import { NextRequest, NextResponse } from 'next/server'
import { resolveAdminUid } from '@/lib/admin/auth'
import { logAdminAction } from '@/lib/admin/audit'
import { settleApprovedRefund } from '@/features/media-credits/services/refundService'
import {
  InvalidCreditOperationError, RefundNotAllowedError, RefundSettlementDeferredError,
} from '@/features/media-credits/errors'

type Params = { params: Promise<{ refundId: string }> }

export async function POST(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { refundId } = await params

  try {
    const result = await settleApprovedRefund(refundId)
    await logAdminAction({
      adminUid,
      action:     'media_credit_refund.approved',
      entityType: 'media_credit_refund',
      entityId:   refundId,
      metadata:   { manualRetry: true, gatewayRefundId: result.gatewayRefundId },
    })
    return NextResponse.json({ status: 'settled', ...result })
  } catch (err) {
    if (err instanceof RefundSettlementDeferredError) {
      // Either the gateway failed again, or another caller holds the claim. Both are 202:
      // the money is still owed and still queued, and a 5xx would invite a pointless retry.
      return NextResponse.json(
        { refundId, status: 'approved', pending: true, error: err.message, code: err.code },
        { status: 202 },
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
    console.error('[admin/media-credits/retry] failed:', err)
    return NextResponse.json({ error: 'Could not retry this refund.' }, { status: 503 })
  }
}
