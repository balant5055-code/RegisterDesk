// POST /api/registrations/fee-preview
//
// RD-RT6.0 — READ ONLY. Returns the itemised charge an attendee is about to authorise,
// WITHOUT creating anything.
//
// ═══ WHY THIS EXISTS ══════════════════════════════════════════════════════════
// The canonical fee breakdown (ticket base · platform fee · GST · gateway fee) is produced
// by `resolveCheckoutCharge`, and until now the ONLY way to see it was the response of
// `create-order` — which mints a real Razorpay order as a side effect. So the itemised
// summary could not be shown to the attendee until an order already existed, which is why
// the old flow silently swapped an inline panel AFTER the first Pay click and then asked
// for a second one.
//
// The confirmation modal has to show real numbers BEFORE any order exists, so this route
// runs the SAME resolution chain create-order runs — same event read, same
// `resolveEffectivePassPricePaise`, same `validateCoupon`, same `resolvePlatformPricing` →
// `getFeePlanForOrganizer` → `resolveFeeConfig` → `resolveCheckoutCharge` — and stops
// there. It never touches Razorpay, never writes a payment intent, never writes anything.
//
// AUTHORITY IS UNCHANGED. This is a PREVIEW. `create-order` remains the only authority on
// what is charged, and the client re-checks the previewed total against the amount
// create-order returns; a mismatch re-opens the confirmation rather than proceeding. So a
// drift between this route and create-order can never charge an unconfirmed amount.

import { NextRequest, NextResponse } from 'next/server'
import { getEventBySlug }            from '@/lib/firebase/firestore/events'
import { resolveEffectivePassPricePaise } from '@/lib/pricing/earlyBird'
import { validateCoupon }            from '@/lib/coupons/validate'
import { resolvePlatformPricing }    from '@/lib/platform/pricing/resolver'
import { resolveCheckoutCharge }     from '@/lib/fees/checkoutCharge'
import { resolveFeeConfig }          from '@/lib/fees/resolveFeeConfig'
import { getFeePlanForOrganizer }    from '@/lib/billing/feeEngine'
import { builderFeeModelToEngine, normalizeFeeModel } from '@/lib/events/builder/types'
import type { FeeConfig, FeeBreakdownRecord } from '@/lib/fees/types'
import { getClientIp }               from '@/lib/rateLimit'
import { checkDistributedRateLimit } from '@/lib/rateLimit/redis'

export interface FeePreviewResponse {
  /** The amount create-order is expected to charge (paise). */
  amountPaise: number
  /** The ticket price before any coupon (paise). */
  originalAmountPaise: number
  /** Present only when a valid coupon was supplied. */
  discountPaise?: number
  couponCode?:    string
  /** Canonical breakdown — present only when the attendee bears fees. */
  financials?:    FeeBreakdownRecord
  error?:         string
}

export async function POST(req: NextRequest): Promise<NextResponse<FeePreviewResponse>> {
  // Generous but bounded — this is a read the checkout may repeat as the attendee edits.
  const rl = await checkDistributedRateLimit({
    key: `fee-preview:${getClientIp(req)}`, limit: 60, windowSeconds: 10 * 60, failOpen: true,
  })
  if (!rl.allowed) {
    return NextResponse.json({ amountPaise: 0, originalAmountPaise: 0, error: 'Too many requests.' }, { status: 429 })
  }

  let body: { slug?: string; passId?: string; couponCode?: string }
  try {
    body = (await req.json()) as typeof body
  } catch {
    return NextResponse.json({ amountPaise: 0, originalAmountPaise: 0, error: 'Invalid request body' }, { status: 400 })
  }

  const slug   = (body.slug ?? '').trim()
  const passId = (body.passId ?? '').trim()
  if (!slug || !passId) {
    return NextResponse.json({ amountPaise: 0, originalAmountPaise: 0, error: 'slug and passId are required' }, { status: 400 })
  }

  const event = await getEventBySlug(slug)
  if (!event) return NextResponse.json({ amountPaise: 0, originalAmountPaise: 0, error: 'Event not found' }, { status: 404 })

  const rawPricing = event.pricing as Record<string, unknown> | null
  const passes = Array.isArray(rawPricing?.passes) ? (rawPricing.passes as Record<string, unknown>[]) : []
  const pass   = passes.find(p => p.id === passId)
  if (!pass) return NextResponse.json({ amountPaise: 0, originalAmountPaise: 0, error: 'Pass not found' }, { status: 404 })

  // Same canonical base amount create-order charges (early bird while active, else regular).
  const originalAmountPaise = resolveEffectivePassPricePaise(pass, Date.now())

  let finalAmountPaise = originalAmountPaise
  let discountPaise: number | undefined
  let appliedCode:   string | undefined

  if (body.couponCode?.trim()) {
    const c = await validateCoupon(slug, body.couponCode, passId, originalAmountPaise)
    // An invalid coupon is NOT an error here: the preview simply shows the undiscounted
    // price. create-order remains the gate that rejects a bad code at charge time.
    if (c.valid) {
      finalAmountPaise = c.finalPaise ?? originalAmountPaise
      discountPaise    = c.discountPaise
      appliedCode      = c.coupon?.code
    }
  }

  // Free (or fully discounted) → nothing to itemise, and no fee resolution is needed.
  if (finalAmountPaise <= 0) {
    return NextResponse.json({
      amountPaise: 0, originalAmountPaise,
      ...(discountPaise !== undefined ? { discountPaise } : {}),
      ...(appliedCode ? { couponCode: appliedCode } : {}),
    })
  }

  const platformSettings = await resolvePlatformPricing()
  let feeConfig: FeeConfig | undefined
  if (platformSettings.features.pricingEngineEnabled) {
    const feePlan = await getFeePlanForOrganizer(event.uid)
    feeConfig = await resolveFeeConfig('event_registration', feePlan.planTier)
  }

  const charge = resolveCheckoutCharge({
    pricingEngineEnabled: platformSettings.features.pricingEngineEnabled,
    finalAmountPaise,
    eventFeeModel: builderFeeModelToEngine(
      normalizeFeeModel(rawPricing?.feeModel, platformSettings.features.pricingEngineEnabled),
    ),
    feeConfig,
    context: { organizerUid: event.uid, eventId: slug },
  })

  return NextResponse.json({
    amountPaise:         charge.amountPaise,
    originalAmountPaise,
    ...(discountPaise !== undefined ? { discountPaise } : {}),
    ...(appliedCode ? { couponCode: appliedCode } : {}),
    ...(charge.financials ? { financials: charge.financials } : {}),
  })
}
