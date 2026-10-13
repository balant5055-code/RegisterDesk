// GET  /api/admin/badge-coupons/[code] — badge coupon detail + measured usage (Super Admin only).
// POST /api/admin/badge-coupons/[code] — action: update | clone | pause | resume | archive | preview.
//
// RD-PRINT-BILL-P3. Every CHANGE needs a reason (3–500) and is audited in the same transaction.
// `preview` is read-only: it shows what the coupon would do for an organizer, event and purchase
// amount, computed exactly as a purchase will — it never reserves or consumes usage. Coupons are
// never deleted. A legacy `admin: true` claim alone is refused (403 SUPER_ADMIN_REQUIRED).

import { NextRequest, NextResponse } from 'next/server'
import { parseFinancialReason, reasonErrorResponse, requireSuperAdmin } from '@/lib/admin/financialGuard'
import {
  getBadgeCouponDetail, updateBadgeCoupon, cloneBadgeCoupon, setBadgeCouponState, previewBadgeCoupon,
  BadgeCouponAdminError, type BadgeCouponStateAction,
} from '@/lib/admin/badgeCouponService'
import { normalizeBadgeCouponCode, BADGE_COUPON_CODE_RE } from '@/lib/licensing/badgeCoupons/validate'

type Ctx = { params: Promise<{ code: string }> }
const NO_STORE = { 'Cache-Control': 'no-store' }
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/
const MAX_PREVIEW_PAISE = 100_000_000   // ₹10,00,000 — far above any badge purchase
const STATE_ACTIONS: BadgeCouponStateAction[] = ['pause', 'resume', 'archive']

/**
 * RD-PRINT-BILL-P3.2 — the route's [code] under the SAME rule as creation (normalized; 3–40 of
 * A–Z 0–9 _ -). Anything else cannot name a coupon, so it is "not found" — answered before any
 * database path is built (a '/' would otherwise form an invalid path and fail as a 500).
 */
const NOT_FOUND = () => NextResponse.json({ error: 'Coupon not found' }, { status: 404, headers: NO_STORE })
const routeCode = (raw: string): string | null => {
  const c = normalizeBadgeCouponCode(raw)
  return BADGE_COUPON_CODE_RE.test(c) ? c : null
}

export async function GET(req: NextRequest, { params }: Ctx): Promise<NextResponse> {
  const gate = await requireSuperAdmin(req)
  if (gate.response) return gate.response
  const code = routeCode((await params).code)
  if (!code) return NOT_FOUND()
  try {
    const detail = await getBadgeCouponDetail(code)
    if (!detail) return NextResponse.json({ error: 'Coupon not found' }, { status: 404, headers: NO_STORE })
    return NextResponse.json(detail, { headers: NO_STORE })
  } catch (e) {
    console.error('[admin/badge-coupons] detail failed', { type: e instanceof Error ? e.name : typeof e })
    return NextResponse.json({ error: 'Failed to load coupon' }, { status: 500, headers: NO_STORE })
  }
}

export async function POST(req: NextRequest, { params }: Ctx): Promise<NextResponse> {
  const gate = await requireSuperAdmin(req)
  if (gate.response) return gate.response
  const code = routeCode((await params).code)
  if (!code) return NOT_FOUND()
  let body: { action?: unknown; reason?: unknown; coupon?: unknown; newCode?: unknown; organizerUid?: unknown; eventId?: unknown; purchasePaise?: unknown }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400, headers: NO_STORE }) }
  const action = typeof body.action === 'string' ? body.action : ''

  try {
    // Read-only — no reason, nothing written.
    if (action === 'preview') {
      const organizerUid = typeof body.organizerUid === 'string' ? body.organizerUid : ''
      const eventId = typeof body.eventId === 'string' ? body.eventId : ''
      const purchasePaise = body.purchasePaise
      if (!SAFE_ID.test(organizerUid) || !SAFE_ID.test(eventId)) return NextResponse.json({ error: 'A valid organizer id and event id are required.' }, { status: 400, headers: NO_STORE })
      if (!(typeof purchasePaise === 'number' && Number.isInteger(purchasePaise) && purchasePaise >= 1 && purchasePaise <= MAX_PREVIEW_PAISE)) {
        return NextResponse.json({ error: 'The purchase amount must be a whole number of paise from 1.' }, { status: 400, headers: NO_STORE })
      }
      const result = await previewBadgeCoupon(code, { organizerUid, eventId, purchasePaise })
      return NextResponse.json({ preview: result }, { headers: NO_STORE })
    }

    const reason = parseFinancialReason(body.reason)
    if (!reason.ok) return reasonErrorResponse(reason)
    if (action === 'update') {
      const coupon = await updateBadgeCoupon(code, body.coupon ?? {}, gate.uid, reason.reason)
      return NextResponse.json({ ok: true, coupon }, { headers: NO_STORE })
    }
    if (action === 'clone') {
      const coupon = await cloneBadgeCoupon(code, typeof body.newCode === 'string' ? body.newCode : '', gate.uid, reason.reason)
      return NextResponse.json({ ok: true, coupon }, { status: 201, headers: NO_STORE })
    }
    if (STATE_ACTIONS.includes(action as BadgeCouponStateAction)) {
      const coupon = await setBadgeCouponState(code, action as BadgeCouponStateAction, gate.uid, reason.reason)
      return NextResponse.json({ ok: true, coupon }, { headers: NO_STORE })
    }
    return NextResponse.json({ error: 'Invalid or missing action' }, { status: 400, headers: NO_STORE })
  } catch (e) {
    if (e instanceof BadgeCouponAdminError) return NextResponse.json({ error: e.message, code: e.code, details: e.details }, { status: e.status, headers: NO_STORE })
    console.error('[admin/badge-coupons] action failed', { action, type: e instanceof Error ? e.name : typeof e })
    return NextResponse.json({ error: 'Action failed' }, { status: 500, headers: NO_STORE })
  }
}
