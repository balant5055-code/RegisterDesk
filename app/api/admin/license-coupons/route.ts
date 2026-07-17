// GET  /api/admin/license-coupons — list license coupons (admin-only).
// POST /api/admin/license-coupons — create a coupon (reason required, audited).
// Extends the admin license surface; separate from registration coupons.

import { NextRequest, NextResponse } from 'next/server'
import { resolveAdminUid } from '@/lib/admin/auth'
import { listCoupons, createCoupon, CouponAdminError, type CouponInput } from '@/lib/admin/licenseCouponService'

export async function GET(req: NextRequest): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const includeArchived = req.nextUrl.searchParams.get('includeArchived') === 'true'
  try {
    return NextResponse.json({ coupons: await listCoupons({ includeArchived }) }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    console.error('[admin/license-coupons] list failed', e)
    return NextResponse.json({ error: 'Failed to load coupons' }, { status: 500 })
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  let body: { reason?: unknown; coupon?: CouponInput }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }
  const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
  if (!reason) return NextResponse.json({ error: 'A reason is required' }, { status: 400 })

  try {
    const coupon = await createCoupon(body.coupon ?? {}, adminUid, reason)
    return NextResponse.json({ coupon }, { status: 201 })
  } catch (e) {
    if (e instanceof CouponAdminError) return NextResponse.json({ error: e.message }, { status: e.status })
    console.error('[admin/license-coupons] create failed', e)
    return NextResponse.json({ error: 'Create failed' }, { status: 500 })
  }
}
