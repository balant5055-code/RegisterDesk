// /api/admin/registrations/[registrationId]/manual-refunds — Super Admin only.
//
//   GET  → the manual refunds recorded for this registration (any status)
//   POST → REQUEST a manual refund (maker): money to be returned to the attendee OUTSIDE the gateway.
//          Body: { requestKey, amountPaise, method, recipientName, recipientDetail?, reason, confirmNoGatewayRefund? }
//          A different Super Admin completes it with the transfer reference (/api/admin/manual-refunds/[id]).
//
// Nothing here sends money. See lib/refunds/manualRefunds.ts for the claim, exclusivity and accounting rules.

import { NextRequest, NextResponse } from 'next/server'
import { requireSuperAdmin, parseFinancialReason, reasonErrorResponse } from '@/lib/admin/financialGuard'
import { requestManualRefund, listManualRefunds } from '@/lib/refunds/manualRefunds'

type Ctx = { params: Promise<{ registrationId: string }> }
const NO_STORE = { 'Cache-Control': 'no-store' }

export async function GET(req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const guard = await requireSuperAdmin(req)
  if (guard.response) return guard.response
  const { registrationId } = await ctx.params
  return NextResponse.json({ items: await listManualRefunds(registrationId) }, { headers: NO_STORE })
}

export async function POST(req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const guard = await requireSuperAdmin(req)
  if (guard.response) return guard.response
  const { registrationId } = await ctx.params

  let body: Record<string, unknown> = {}
  try { body = await req.json() as Record<string, unknown> } catch { body = {} }
  const reason = parseFinancialReason(body.reason)
  if (!reason.ok) return reasonErrorResponse(reason)

  const r = await requestManualRefund({
    registrationId, requestKey: body.requestKey, amountPaise: body.amountPaise, method: body.method,
    recipientName: body.recipientName, recipientDetail: body.recipientDetail, reason: reason.reason,
    adminUid: guard.uid, confirmNoGatewayRefund: body.confirmNoGatewayRefund,
  })
  if (!r.ok) return NextResponse.json({ error: r.error, code: r.code }, { status: r.status, headers: NO_STORE })
  return NextResponse.json({ refund: r.record, duplicate: r.duplicate }, { status: r.duplicate ? 200 : 201, headers: NO_STORE })
}
