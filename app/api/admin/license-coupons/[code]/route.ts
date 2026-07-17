// GET  /api/admin/license-coupons/[code] — coupon detail + usage (admin-only).
// POST /api/admin/license-coupons/[code] — action: update | clone | pause | resume
//      | archive. Every action requires a reason and is audited. Never deleted.

import { NextRequest, NextResponse } from 'next/server'
import { resolveAdminUid } from '@/lib/admin/auth'
import {
  getCouponUsage, updateCoupon, cloneCoupon, setCouponState,
  CouponAdminError, type CouponInput, type CouponStateAction,
} from '@/lib/admin/licenseCouponService'
import { getLicenseCoupon, deriveCouponLifecycle } from '@/lib/licensing/coupons'

type Ctx = { params: Promise<{ code: string }> }

export async function GET(req: NextRequest, { params }: Ctx): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const { code } = await params
  try {
    const coupon = await getLicenseCoupon(code)
    if (!coupon) return NextResponse.json({ error: 'Coupon not found' }, { status: 404 })
    const usage = await getCouponUsage(code)
    return NextResponse.json(
      { coupon: { ...coupon, lifecycle: deriveCouponLifecycle(coupon, Date.now()) }, usage },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (e) {
    console.error('[admin/license-coupons] detail failed', e)
    return NextResponse.json({ error: 'Failed to load coupon' }, { status: 500 })
  }
}

const STATE_ACTIONS: CouponStateAction[] = ['pause', 'resume', 'archive']

export async function POST(req: NextRequest, { params }: Ctx): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const { code } = await params

  let body: { action?: unknown; reason?: unknown; coupon?: CouponInput; newCode?: unknown }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }
  const action = typeof body.action === 'string' ? body.action : ''
  const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
  if (!reason) return NextResponse.json({ error: 'A reason is required' }, { status: 400 })

  try {
    if (action === 'update') {
      await updateCoupon(code, body.coupon ?? {}, adminUid, reason)
    } else if (action === 'clone') {
      const newCode = typeof body.newCode === 'string' ? body.newCode : ''
      const cloned = await cloneCoupon(code, newCode, adminUid, reason)
      return NextResponse.json({ ok: true, coupon: cloned }, { status: 201 })
    } else if (STATE_ACTIONS.includes(action as CouponStateAction)) {
      await setCouponState(code, action as CouponStateAction, adminUid, reason)
    } else {
      return NextResponse.json({ error: 'Invalid or missing action' }, { status: 400 })
    }
    return NextResponse.json({ ok: true, action, code })
  } catch (e) {
    if (e instanceof CouponAdminError) return NextResponse.json({ error: e.message }, { status: e.status })
    console.error('[admin/license-coupons] action failed', e)
    return NextResponse.json({ error: 'Action failed' }, { status: 500 })
  }
}
