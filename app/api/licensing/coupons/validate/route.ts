// POST /api/licensing/coupons/validate — LICENSE coupon preview (EA-4 S2).
//
// Non-authoritative preview: validates a code against the license purchase and
// returns the discount + final price so the organizer sees the effect before
// paying. The AUTHORITATIVE discount is recomputed server-side at purchase/confirm
// (never trusted from here). This ONLY affects event-license purchases — it is
// entirely separate from registration/ticket/donation/marketplace coupons.

import { NextRequest, NextResponse } from 'next/server'
import { verifyCaller }        from '@/lib/team/access'
import { resolveWorkspaceUid } from '@/lib/team/workspace'
import { getEventBySlug }      from '@/lib/firebase/firestore/events'
import { adminDb }             from '@/lib/firebase/admin'
import { isEventLicenseTier }  from '@/lib/licensing/eventLicense'
import { getEffectiveLicenseDefinition } from '@/lib/licensing/resolveCatalog'
import {
  getLicenseCoupon, getLicenseCouponsConfig, countOrganizerCouponRedemptions,
  validateLicenseCoupon, normalizeCouponCode,
} from '@/lib/licensing/coupons'

export async function POST(req: NextRequest): Promise<NextResponse> {
  const caller = await verifyCaller(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: { eventId?: unknown; tier?: unknown; couponCode?: unknown }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }

  const eventId = typeof body.eventId === 'string' ? body.eventId.trim() : ''
  const code    = typeof body.couponCode === 'string' ? normalizeCouponCode(body.couponCode) : ''
  if (!eventId || !isEventLicenseTier(body.tier) || !code) {
    return NextResponse.json({ valid: false, message: 'eventId, tier and couponCode are required.' }, { status: 400 })
  }
  const tier = body.tier
  const ctx  = await resolveWorkspaceUid(caller.uid)

  // Effective (config-aware) base price + the event type (identity restriction).
  const def = await getEffectiveLicenseDefinition(tier)
  const pricePaise = def.licensePricePaise
  if (pricePaise <= 0) {
    return NextResponse.json({ valid: false, message: 'This license is already free.' }, { status: 200 })
  }

  let eventType: string | null = null
  const ev = await getEventBySlug(eventId)
  if (ev) {
    if (ev.uid !== ctx.workspaceUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    eventType = typeof (ev as { eventType?: unknown }).eventType === 'string' ? (ev as { eventType?: string }).eventType ?? null : null
  } else {
    const draftSnap = await adminDb.doc(`users/${ctx.workspaceUid}/eventDrafts/${eventId}`).get()
    const d = draftSnap.exists ? draftSnap.data() as Record<string, unknown> : null
    eventType = typeof d?.eventType === 'string' ? d.eventType : null
  }

  const [coupon, cfg, organizerRedemptions] = await Promise.all([
    getLicenseCoupon(code),
    getLicenseCouponsConfig(),
    countOrganizerCouponRedemptions(code, ctx.workspaceUid),
  ])

  const result = validateLicenseCoupon(coupon, {
    tier, eventType, pricePaise, organizerRedemptions,
    couponsEnabled: cfg.enabled, maxPercentageDiscount: cfg.maxPercentageDiscount,
    maxFixedDiscountPaise: cfg.maxFixedDiscountPaise, allowFreeLicense: cfg.allowFreeLicense,
  }, Date.now())

  if (!result.ok) {
    return NextResponse.json({ valid: false, failure: result.failure, message: result.message }, { status: 200, headers: { 'Cache-Control': 'no-store' } })
  }
  return NextResponse.json({
    valid: true, couponCode: code, originalPricePaise: pricePaise,
    discountPaise: result.discountPaise, finalPricePaise: result.finalPricePaise,
    campaign: result.snapshot.campaign,
  }, { status: 200, headers: { 'Cache-Control': 'no-store' } })
}
