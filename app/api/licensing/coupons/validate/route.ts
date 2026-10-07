// POST /api/licensing/coupons/validate — LICENSE coupon preview (EA-4 S2).
//
// Non-authoritative preview: validates a code against the license purchase and
// returns the discount + final price so the organizer sees the effect before
// paying. The AUTHORITATIVE discount is recomputed server-side at purchase/confirm
// (never trusted from here). This ONLY affects event-license purchases — it is
// entirely separate from registration/ticket/donation/marketplace coupons.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeWorkspace } from '@/lib/team/workspace'
import { getEventBySlug }      from '@/lib/firebase/firestore/events'
import { adminDb }             from '@/lib/firebase/admin'
import { CURRENT_LICENSE_VERSION, isValidTierForVersion, defaultLicenseTierForVersion } from '@/lib/licensing/eventLicense'
import { getEffectiveDefinitionForVersion } from '@/lib/licensing/resolveCatalog'
import { calculateActivationQuote } from '@/lib/licensing/capacityPricing'
import { getEventCommercialTerms }  from '@/lib/licensing/resolveCommercialTerms'
import {
  getLicenseCoupon, getLicenseCouponsConfig, countOrganizerCouponRedemptions,
  validateLicenseCoupon, normalizeCouponCode, COUPON_USAGE_UNVERIFIED_MESSAGE,
} from '@/lib/licensing/coupons'

export async function POST(req: NextRequest): Promise<NextResponse> {
  // RD-CE-FIX M5 · the same gate as the rest of licensing (capacity/*, checkout/confirm): verified
  // token, the workspace it acts for, suspension of caller OR owner, and the `events` permission —
  // a check-in-only or finance member, or a suspended workspace, cannot buy or read licences here.
  const authz = await authorizeWorkspace(req, 'events')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })

  let body: { eventId?: unknown; tier?: unknown; couponCode?: unknown; capacity?: unknown }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }

  const eventId = typeof body.eventId === 'string' ? body.eventId.trim() : ''
  const code    = typeof body.couponCode === 'string' ? normalizeCouponCode(body.couponCode) : ''
  // RD-LICENSE-E2E-01 · a request carrying `capacity` previews the CAPACITY activation, priced
  // exactly as /api/licensing/purchase prices it (same engine, same event-resolved terms, same
  // compatibility tier stamp) — otherwise the preview would discount a tier price the purchase
  // never charges. A request without `capacity` keeps the legacy tier path unchanged.
  const isCapacity = 'capacity' in body && body.capacity !== undefined && body.capacity !== null
  const tierInput  = isCapacity && body.tier === undefined ? defaultLicenseTierForVersion(CURRENT_LICENSE_VERSION) : body.tier
  // The tier being previewed is a NEW purchase → validate + price against the current version.
  if (!eventId || !isValidTierForVersion(tierInput, CURRENT_LICENSE_VERSION) || !code) {
    return NextResponse.json({ valid: false, message: 'eventId, tier and couponCode are required.' }, { status: 400 })
  }
  const tier = tierInput
  const ctx  = authz

  // Effective (config-aware) base price + the event type (identity restriction).
  let pricePaise: number
  if (isCapacity) {
    const quoted = calculateActivationQuote({ capacity: body.capacity, terms: await getEventCommercialTerms(eventId) })
    if (!quoted.ok) return NextResponse.json({ valid: false, message: quoted.message }, { status: 422 })
    pricePaise = quoted.quote.totalPaise
  } else {
    const def = await getEffectiveDefinitionForVersion(tier, CURRENT_LICENSE_VERSION)
    if (!def) return NextResponse.json({ valid: false, message: 'Invalid tier.' }, { status: 400 })
    pricePaise = def.licensePricePaise
  }
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

  const [coupon, cfg, usage] = await Promise.all([
    getLicenseCoupon(code),
    getLicenseCouponsConfig(),
    countOrganizerCouponRedemptions(code, ctx.workspaceUid),
  ])
  // RD-M5 D2 — usage that cannot be verified is never treated as zero: retryable refusal, no writes.
  if (!usage.ok) {
    return NextResponse.json({ valid: false, failure: 'usage_unverified', message: COUPON_USAGE_UNVERIFIED_MESSAGE }, { status: 503, headers: { 'Cache-Control': 'no-store' } })
  }

  const result = validateLicenseCoupon(coupon, {
    tier, eventType, pricePaise, organizerRedemptions: usage.count,
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
