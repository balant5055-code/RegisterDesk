// GET  /api/admin/license-coupons/[code] — coupon detail + usage (admin-only).
// POST /api/admin/license-coupons/[code] — action: update | clone | pause | resume
//      | archive. Every action requires a reason and is audited. Never deleted.

import { NextRequest, NextResponse } from 'next/server'
import { resolveAdminUid, resolveSuperAdminUid } from '@/lib/admin/auth'
import { parseFinancialReason, reasonErrorResponse, requireSuperAdmin } from '@/lib/admin/financialGuard'
import {
  getCouponUsage, updateCoupon, cloneCoupon, setCouponState,
  CouponAdminError, type CouponInput, type CouponStateAction,
} from '@/lib/admin/licenseCouponService'
import { getLicenseCoupon, deriveCouponLifecycle } from '@/lib/licensing/coupons'

type Ctx = { params: Promise<{ code: string }> }

export async function GET(req: NextRequest, { params }: Ctx): Promise<NextResponse> {
  // RD-CLOSE — a financial read: Super Admin only (ADMIN_UIDS). A legacy `admin: true` claim
  // alone gets 403 SUPER_ADMIN_REQUIRED (lib/admin/financialGuard.ts).
  const superGate = await requireSuperAdmin(req)
  if (superGate.response) return superGate.response
  const { code } = await params
  try {
    const coupon = await getLicenseCoupon(code)
    if (!coupon) return NextResponse.json({ error: 'Coupon not found' }, { status: 404 })
    const usage = await getCouponUsage(code)
    const canEditPricing = (await resolveSuperAdminUid(req.headers.get('authorization'))) !== null
    return NextResponse.json(
      { coupon: { ...coupon, lifecycle: deriveCouponLifecycle(coupon, Date.now()) }, usage, permissions: { canEditPricing } },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (e) {
    console.error('[admin/license-coupons] detail failed', e)
    return NextResponse.json({ error: 'Failed to load coupon' }, { status: 500 })
  }
}

const STATE_ACTIONS: CouponStateAction[] = ['pause', 'resume', 'archive']

export async function POST(req: NextRequest, { params }: Ctx): Promise<NextResponse> {
  // RD-PHASE4-S2 — licence coupon ISSUANCE and every other coupon mutation (edit, clone, pause, resume,
  // archive) is a pricing decision: Super Admin only (ADMIN_UIDS), decided from the verified token.
  if (!(await resolveAdminUid(req.headers.get('authorization')))) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const adminUid = await resolveSuperAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Only a Super Admin can issue or change licence coupons.', code: 'SUPER_ADMIN_REQUIRED' }, { status: 403 })
  const { code } = await params

  let body: { action?: unknown; reason?: unknown; coupon?: CouponInput; newCode?: unknown }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }
  const action = typeof body.action === 'string' ? body.action : ''
  // RD-PHASE4-S4 · D3 — a reason of 3–500 characters.
  const reasonCheck = parseFinancialReason(body.reason)
  if (!reasonCheck.ok) return reasonErrorResponse(reasonCheck)
  const reason = reasonCheck.reason

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
