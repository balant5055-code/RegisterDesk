// POST /api/organizer/media-credits/refunds/{refundId}/cancel
//
// RD-MC-REFUND-V2-P3. The organizer withdraws their own pending refund request. The held
// credits return to `available` immediately and become spendable again.
//
// ═══ WHY THIS IS A POST AND NOT A DELETE ═════════════════════════════════════
// Nothing is deleted. The request survives as `cancelled` — a financial record an organizer
// asked for is part of the audit trail whether or not it was carried through, and a DELETE
// would suggest otherwise to anyone reading the route table.
//
// ═══ WHAT THIS CANNOT DO ═════════════════════════════════════════════════════
// Cancel an approved refund. By then the credits have left the wallet, a ledger entry names
// the movement, and a Razorpay payout may be in flight; `cancelRefund` refuses anything that
// is not `requested`. There is still no organizer path to an approval — that stays an admin
// decision, which is why this sits beside the GET rather than becoming a PATCH on it.
//
// Tenant scoping is enforced in the SERVICE as well as here. A route guard alone would leave
// the service safe to call wrongly from somewhere else later.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeWorkspace } from '@/lib/team/workspace'
import { refundService } from '@/features/media-credits/services/refundService'
import {
  InvalidCreditOperationError, RefundNotAllowedError,
} from '@/features/media-credits/errors'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ refundId: string }> }

export async function POST(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const authz = await authorizeWorkspace(req, 'wallet')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })

  const { refundId } = await params

  try {
    await refundService.cancelRefund({
      organizerUid: authz.workspaceUid,
      refundId,
      // The person who clicked, which on a team account is NOT the workspace owner. The
      // audit trail must name them, not the account they act inside.
      actorUid:     authz.callerUid,
    })
  } catch (err) {
    // Unknown id and another workspace's id are the same answer, so this cannot be used to
    // discover real refund ids.
    if (err instanceof InvalidCreditOperationError) {
      return NextResponse.json({ error: 'Refund not found' }, { status: 404 })
    }
    // Already decided, or already settling. 409 rather than 400: the request was well formed,
    // the refund has simply moved on.
    if (err instanceof RefundNotAllowedError) {
      return NextResponse.json({ error: err.message }, { status: 409 })
    }
    throw err
  }

  // The refund as it now stands, so the client re-renders from the server's answer rather
  // than assuming what the cancellation did.
  const refund = await refundService.getRefundRequest(authz.workspaceUid, refundId)
  return NextResponse.json({ refund }, { headers: { 'Cache-Control': 'no-store' } })
}
