// GET  /api/admin/badge-coupons — list ID-badge purchase coupons (Super Admin only).
// POST /api/admin/badge-coupons — create a badge coupon (Super Admin; reason 3–500; audited).
//
// RD-PRINT-BILL-P3. Separate from /api/admin/license-coupons: badge coupons discount prepaid ID-badge
// unit purchases only and are never accepted by licence checkout. A legacy `admin: true` claim
// alone is refused (403 SUPER_ADMIN_REQUIRED) — reads included, since coupons are pricing.

import { NextRequest, NextResponse } from 'next/server'
import { parseFinancialReason, reasonErrorResponse, requireSuperAdmin } from '@/lib/admin/financialGuard'
import { listBadgeCoupons, createBadgeCoupon, BadgeCouponAdminError } from '@/lib/admin/badgeCouponService'
import { getAllowFreeBadgeCoupons } from '@/lib/licensing/badgeCoupons/store'

const NO_STORE = { 'Cache-Control': 'no-store' }

export async function GET(req: NextRequest): Promise<NextResponse> {
  const gate = await requireSuperAdmin(req)
  if (gate.response) return gate.response
  const includeArchived = req.nextUrl.searchParams.get('includeArchived') === 'true'
  try {
    const [coupons, allowFreeCoupons] = await Promise.all([listBadgeCoupons({ includeArchived }), getAllowFreeBadgeCoupons()])
    return NextResponse.json({ coupons, policy: { allowFreeCoupons } }, { headers: NO_STORE })
  } catch (e) {
    console.error('[admin/badge-coupons] list failed', { type: e instanceof Error ? e.name : typeof e })
    return NextResponse.json({ error: 'Failed to load badge coupons' }, { status: 500, headers: NO_STORE })
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const gate = await requireSuperAdmin(req)
  if (gate.response) return gate.response
  let body: { reason?: unknown; coupon?: unknown }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400, headers: NO_STORE }) }
  const reason = parseFinancialReason(body.reason)
  if (!reason.ok) return reasonErrorResponse(reason)
  if (typeof body.coupon !== 'object' || body.coupon === null || Array.isArray(body.coupon)) {
    return NextResponse.json({ error: 'coupon must be an object' }, { status: 400, headers: NO_STORE })
  }
  try {
    const coupon = await createBadgeCoupon(body.coupon, gate.uid, reason.reason)
    return NextResponse.json({ coupon }, { status: 201, headers: NO_STORE })
  } catch (e) {
    if (e instanceof BadgeCouponAdminError) return NextResponse.json({ error: e.message, code: e.code, details: e.details }, { status: e.status, headers: NO_STORE })
    console.error('[admin/badge-coupons] create failed', { type: e instanceof Error ? e.name : typeof e })
    return NextResponse.json({ error: 'Create failed' }, { status: 500, headers: NO_STORE })
  }
}
