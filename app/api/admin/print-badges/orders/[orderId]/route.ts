// GET /api/admin/print-badges/orders/[orderId] — RD-PRINT-BILL-P7. Super Admin (ADMIN_UIDS) only;
// READ-ONLY apart from its audit row.
//
// One ID-badge order with every record that bears on it (refund tracker, coupon redemption/release,
// holds, suspicious payments, licence history, Wallet refund requests) — each section reported as
// unavailable rather than empty when it cannot be read. Full Razorpay ids are shown here.
//
// AUDITED (approved): after authorization and a successful read, one adminAuditLogs row
// ('print_badge_billing.order_viewed', entity 'billing', the order id). If that row cannot be
// written the data is NOT returned (503) — no unaudited view of billing evidence.

import { NextRequest, NextResponse } from 'next/server'
import { requireSuperAdmin } from '@/lib/admin/financialGuard'
import { logAdminAction } from '@/lib/admin/audit'
import { getBadgeOrderDetail } from '@/lib/admin/printBadgeAdmin/orders'

export const dynamic = 'force-dynamic'
const NO_STORE = { 'Cache-Control': 'no-store' }

export async function GET(req: NextRequest, context: { params: Promise<{ orderId: string }> }): Promise<NextResponse> {
  const gate = await requireSuperAdmin(req)
  if (gate.response) return gate.response
  const { orderId } = await context.params
  let detail
  try {
    detail = await getBadgeOrderDetail(orderId)
  } catch (e) {
    console.error('[admin/print-badges/orders/detail] failed', { type: e instanceof Error ? e.name : typeof e })
    return NextResponse.json({ error: 'Could not load this order' }, { status: 500, headers: NO_STORE })
  }
  if (!detail) return NextResponse.json({ error: 'Order not found' }, { status: 404, headers: NO_STORE })
  try {
    await logAdminAction({
      adminUid: gate.uid, actorRole: 'super_admin', action: 'print_badge_billing.order_viewed', entityType: 'billing', entityId: orderId,
      correlation: { orderId, eventId: detail.order.eventId ?? undefined },
    })
  } catch (e) {
    console.error('[admin/print-badges/orders/detail] audit failed', { type: e instanceof Error ? e.name : typeof e })
    return NextResponse.json({ error: 'This view could not be recorded in the audit log. Try again.' }, { status: 503, headers: NO_STORE })
  }
  return NextResponse.json(detail, { headers: NO_STORE })
}
