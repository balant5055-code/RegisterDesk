// /api/admin/events/[slug]/coupons — SUPER ADMIN ONLY. The event's coupon switch.
//
//   GET  → { slug, couponsDisabled, updatedBy, updatedAt, reason, platformCouponsEnabled }
//   POST → { enabled: boolean, reason }   switches EVENT coupons off (false) or back on (true)
//
// RD-COUPON-SWITCH-01 (owner decision 2026-10-24: Super Admin per event). While off, every path that
// applies a code refuses it (lib/coupons/validate.ts → couponsAllowedForEvent); the organizer's coupon
// configuration is kept untouched and works again when switched back on. Orders already created keep
// the price they were created with. The platform-wide switch (Business Configuration) still applies on
// top: off globally is off everywhere.
//
// The switch and its audit row are ONE transaction (an audit failure means nothing changed). Its own
// document (`eventAdminControls/{slug}`), never events/{slug}: a publish / republish rewriting the
// event cannot drop it, and no organizer write path can reach it.

import { NextRequest, NextResponse } from 'next/server'
import { FieldValue } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import { requireSuperAdmin, parseFinancialReason, reasonErrorResponse } from '@/lib/admin/financialGuard'
import { stageAdminAudit } from '@/lib/admin/audit'
import { getFeatureFlags } from '@/lib/config/resolveFeatureFlags'
import { EVENT_ADMIN_CONTROLS, getEventCouponSwitch } from '@/lib/coupons/eventCouponSwitch'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ slug: string }> }
const NO_STORE = { 'Cache-Control': 'no-store' }
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,199}$/

export interface AdminEventCouponSwitchResponse {
  slug:                   string
  couponsDisabled:        boolean
  updatedBy:              string | null
  updatedAt:              string | null
  reason:                 string | null
  platformCouponsEnabled: boolean | null
}

async function view(slug: string): Promise<AdminEventCouponSwitchResponse> {
  const [sw, platform] = await Promise.all([
    getEventCouponSwitch(slug),
    getFeatureFlags().then(f => f.coupons !== false, () => null),
  ])
  return { slug, couponsDisabled: sw.disabled, updatedBy: sw.updatedBy, updatedAt: sw.updatedAt, reason: sw.reason, platformCouponsEnabled: platform }
}

export async function GET(req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const guard = await requireSuperAdmin(req)
  if (guard.response) return guard.response
  const { slug } = await ctx.params
  if (!SLUG_RE.test(slug)) return NextResponse.json({ error: 'Invalid event.' }, { status: 400, headers: NO_STORE })
  if (!(await adminDb.collection('events').doc(slug).get()).exists) return NextResponse.json({ error: 'Event not found' }, { status: 404, headers: NO_STORE })
  return NextResponse.json(await view(slug), { headers: NO_STORE })
}

export async function POST(req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const guard = await requireSuperAdmin(req)
  if (guard.response) return guard.response
  const { slug } = await ctx.params
  if (!SLUG_RE.test(slug)) return NextResponse.json({ error: 'Invalid event.' }, { status: 400, headers: NO_STORE })

  let body: { enabled?: unknown; reason?: unknown }
  try { body = await req.json() as typeof body } catch { body = {} }
  if (typeof body.enabled !== 'boolean') {
    return NextResponse.json({ error: 'enabled must be true or false.', code: 'INVALID_ENABLED' }, { status: 400, headers: NO_STORE })
  }
  const reason = parseFinancialReason(body.reason)
  if (!reason.ok) return reasonErrorResponse(reason)
  const disable = !body.enabled

  const eventRef   = adminDb.collection('events').doc(slug)
  const controlRef = adminDb.collection(EVENT_ADMIN_CONTROLS).doc(slug)
  const outcome = await adminDb.runTransaction(async tx => {
    const [eventSnap, controlSnap] = await Promise.all([tx.get(eventRef), tx.get(controlRef)])
    if (!eventSnap.exists) return 'not_found' as const
    const wasDisabled = controlSnap.exists && controlSnap.get('couponsDisabled') === true
    if (wasDisabled === disable) return 'unchanged' as const   // idempotent: no write, no second audit row
    tx.set(controlRef, {
      eventSlug: slug, couponsDisabled: disable, couponsUpdatedBy: guard.uid,
      couponsUpdatedAt: FieldValue.serverTimestamp(), couponsReason: reason.reason,
    }, { merge: true })
    stageAdminAudit(tx, {
      adminUid: guard.uid, actorRole: 'super_admin',
      action: disable ? 'event.coupons_disabled' : 'event.coupons_enabled',
      entityType: 'event', entityId: slug, reason: reason.reason,
      before: { couponsDisabled: wasDisabled }, after: { couponsDisabled: disable },
    })
    return 'changed' as const
  })
  if (outcome === 'not_found') return NextResponse.json({ error: 'Event not found' }, { status: 404, headers: NO_STORE })
  return NextResponse.json({ ...(await view(slug)), changed: outcome === 'changed' }, { headers: NO_STORE })
}
