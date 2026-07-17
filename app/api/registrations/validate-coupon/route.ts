// POST /api/registrations/validate-coupon
//
// Public endpoint — returns a discount preview without incrementing currentUses.
// Rate limited to prevent brute-force code enumeration.
// Never trust the client price: priceRupees is loaded from Firestore.

import { NextRequest, NextResponse } from 'next/server'
import { getEventBySlug }            from '@/lib/firebase/firestore/events'
import { validateCoupon }            from '@/lib/coupons/validate'
import { checkRateLimit, getClientIp } from '@/lib/rateLimit'
import { getFeatureFlags }           from '@/lib/config/resolveFeatureFlags'

interface ValidateCouponBody {
  slug:       string
  passId:     string
  couponCode: string
}

export interface ValidateCouponResponse {
  valid:          boolean
  discountPaise?: number
  finalPaise?:    number
  type?:          string
  description?:   string
  error?:         string
}

export async function POST(
  req: NextRequest,
): Promise<NextResponse<ValidateCouponResponse>> {
  // Rate limit: 15 attempts per minute per IP — prevents enumeration
  const ip = getClientIp(req)
  const rl = checkRateLimit(ip, 'validate-coupon', 15, 60 * 1000)
  if (rl.limited) {
    return NextResponse.json(
      { valid: false, error: 'Too many requests. Please try again later.' },
      {
        status: 429,
        headers: {
          'Retry-After':       String(Math.ceil((rl.resetAt - Date.now()) / 1000)),
          'X-RateLimit-Limit': '15',
          'X-RateLimit-Reset': String(rl.resetAt),
        },
      },
    )
  }

  let body: ValidateCouponBody
  try {
    body = (await req.json()) as ValidateCouponBody
  } catch {
    return NextResponse.json({ valid: false, error: 'Invalid request body' }, { status: 400 })
  }

  const { slug, passId, couponCode } = body
  if (!slug || !passId || !couponCode?.trim()) {
    return NextResponse.json(
      { valid: false, error: 'slug, passId, and couponCode are required' },
      { status: 400 },
    )
  }

  // Feature flag (Business Configuration) — global coupons master switch.
  if (!(await getFeatureFlags()).coupons) {
    return NextResponse.json({ valid: false, error: 'Coupons are currently disabled.' }, { status: 403 })
  }

  // Load event from Firestore — never trust client-supplied price
  const event = await getEventBySlug(slug)
  if (!event) {
    return NextResponse.json({ valid: false, error: 'Event not found' }, { status: 404 })
  }

  const rawPricing = event.pricing as Record<string, unknown> | null
  const passes     = Array.isArray(rawPricing?.passes)
    ? (rawPricing!.passes as Record<string, unknown>[])
    : []
  const pass = passes.find(p => p.id === passId)
  if (!pass) {
    return NextResponse.json({ valid: false, error: 'Pass not found' }, { status: 404 })
  }

  const priceRupees  = typeof pass.price === 'number' ? pass.price : 0
  const originalPaise = Math.round(priceRupees * 100)

  const result = await validateCoupon(slug, couponCode, passId, originalPaise)

  if (!result.valid) {
    return NextResponse.json({ valid: false, error: result.error })
  }

  return NextResponse.json({
    valid:          true,
    discountPaise:  result.discountPaise,
    finalPaise:     result.finalPaise,
    type:           result.coupon!.type,
    description:    result.coupon!.description,
  })
}
