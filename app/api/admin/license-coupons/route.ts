// GET  /api/admin/license-coupons — list license coupons (admin-only).
// POST /api/admin/license-coupons — create a coupon (reason required, audited).
// Extends the admin license surface; separate from registration coupons.

import { NextRequest, NextResponse } from 'next/server'
import { resolveAdminUid, resolveSuperAdminUid } from '@/lib/admin/auth'
import { parseFinancialReason, reasonErrorResponse, requireSuperAdmin } from '@/lib/admin/financialGuard'
import { listCoupons, createCoupon, CouponAdminError, type CouponInput } from '@/lib/admin/licenseCouponService'

export async function GET(req: NextRequest): Promise<NextResponse> {
  // RD-CLOSE — a financial read: Super Admin only (ADMIN_UIDS). A legacy `admin: true` claim
  // alone gets 403 SUPER_ADMIN_REQUIRED (lib/admin/financialGuard.ts).
  const superGate = await requireSuperAdmin(req)
  if (superGate.response) return superGate.response
  const includeArchived = req.nextUrl.searchParams.get('includeArchived') === 'true'
  try {
    const canEditPricing = (await resolveSuperAdminUid(req.headers.get('authorization'))) !== null
    return NextResponse.json({ coupons: await listCoupons({ includeArchived }), permissions: { canEditPricing } }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    console.error('[admin/license-coupons] list failed', e)
    return NextResponse.json({ error: 'Failed to load coupons' }, { status: 500 })
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  // RD-PHASE4-S2 — licence coupon ISSUANCE and every other coupon mutation (edit, clone, pause, resume,
  // archive) is a pricing decision: Super Admin only (ADMIN_UIDS), decided from the verified token.
  if (!(await resolveAdminUid(req.headers.get('authorization')))) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const adminUid = await resolveSuperAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Only a Super Admin can issue or change licence coupons.', code: 'SUPER_ADMIN_REQUIRED' }, { status: 403 })

  let body: { reason?: unknown; coupon?: CouponInput }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }
  // RD-PHASE4-S4 · D3 — a reason of 3–500 characters.
  const reasonCheck = parseFinancialReason(body.reason)
  if (!reasonCheck.ok) return reasonErrorResponse(reasonCheck)
  const reason = reasonCheck.reason

  try {
    const coupon = await createCoupon(body.coupon ?? {}, adminUid, reason)
    return NextResponse.json({ coupon }, { status: 201 })
  } catch (e) {
    if (e instanceof CouponAdminError) return NextResponse.json({ error: e.message }, { status: e.status })
    console.error('[admin/license-coupons] create failed', e)
    return NextResponse.json({ error: 'Create failed' }, { status: 500 })
  }
}
