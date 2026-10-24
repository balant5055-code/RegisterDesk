// POST /api/admin/manual-refunds/[id] — Super Admin only.
//
//   { action: 'complete', reference, transferredOn: 'YYYY-MM-DD', reason }
//       CHECKER: records that the money WAS returned (the transfer reference / UTR / receipt). Must be a
//       different Super Admin from the one who requested it — no bypass. Applies the refund's accounting.
//   { action: 'cancel', reason }
//       withdraws a pending request (lifts its claim and settlement hold). A completed refund cannot be cancelled.
//
// Idempotent: repeating a completion with the same reference, or a cancellation, returns the recorded outcome.

import { NextRequest, NextResponse } from 'next/server'
import { requireSuperAdmin, parseFinancialReason, reasonErrorResponse, configuredSuperAdminCount } from '@/lib/admin/financialGuard'
import { completeManualRefund, cancelManualRefund } from '@/lib/refunds/manualRefunds'
import { isIsoDate } from '@/lib/refunds/manualRefundRules'

type Ctx = { params: Promise<{ id: string }> }
const NO_STORE = { 'Cache-Control': 'no-store' }
const ID_RE = /^mrr_[A-Za-z0-9_-]{9,200}$/

export async function POST(req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const guard = await requireSuperAdmin(req)
  if (guard.response) return guard.response
  const { id } = await ctx.params
  if (!ID_RE.test(id)) return NextResponse.json({ error: 'Invalid manual refund id.', code: 'INVALID_ID' }, { status: 400, headers: NO_STORE })

  let body: Record<string, unknown> = {}
  try { body = await req.json() as Record<string, unknown> } catch { body = {} }
  const reason = parseFinancialReason(body.reason)
  if (!reason.ok) return reasonErrorResponse(reason)

  let r
  if (body.action === 'complete') {
    // The transfer date as stated by the checker: a real calendar date, not in the future.
    if (!isIsoDate(body.transferredOn) || body.transferredOn > new Date().toISOString().slice(0, 10)) {
      return NextResponse.json({ error: 'transferredOn must be the date the money was returned (YYYY-MM-DD, not in the future).', code: 'INVALID_DATE' }, { status: 422, headers: NO_STORE })
    }
    r = await completeManualRefund({ id, adminUid: guard.uid, reference: body.reference, transferredOn: body.transferredOn, note: reason.reason })
    if (!r.ok && r.code === 'MAKER_CHECKER_REQUIRED' && configuredSuperAdminCount() < 2) {
      r = { ...r, error: `${r.error} Only one Super Admin is configured: add a second Super Admin to ADMIN_UIDS before this refund can be recorded.` }
    }
  } else if (body.action === 'cancel') {
    r = await cancelManualRefund({ id, adminUid: guard.uid, reason: reason.reason })
  } else {
    return NextResponse.json({ error: "action must be 'complete' or 'cancel'.", code: 'INVALID_ACTION' }, { status: 400, headers: NO_STORE })
  }
  if (!r.ok) return NextResponse.json({ error: r.error, code: r.code }, { status: r.status, headers: NO_STORE })
  return NextResponse.json({ refund: r.record, duplicate: r.duplicate }, { headers: NO_STORE })
}
