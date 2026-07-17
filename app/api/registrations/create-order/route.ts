// POST /api/registrations/create-order
//
// Security model:
//   1. Firebase ID token in Authorization header (optional — guest checkout supported).
//   2. Event and pass loaded from Firestore — never trust client-supplied price.
//   3. All registration-rule checks (requireLogin, limitPerEmail, limitPerMobile)
//      run server-side before creating the order, so the user never pays and gets blocked.
//   4. Gate check runs server-side.
//   5. Payment intent written to Firestore (with authoritative amount) before returning.

import { NextRequest, NextResponse } from 'next/server'
import { adminAuth, adminDb }        from '@/lib/firebase/admin'
import { captureFinancialError }     from '@/lib/monitoring/sentry'
import { checkRegistrationGate }     from '@/lib/registrations/gate'
import { getEventBySlug }            from '@/lib/firebase/firestore/events'
import { createPaymentIntent }       from '@/lib/firebase/firestore/paymentIntents'
import { razorpay, RAZORPAY_KEY_ID } from '@/lib/razorpay/client'   // C1: throws if keys absent
import { getClientIp } from '@/lib/rateLimit'
import { checkDistributedRateLimit } from '@/lib/rateLimit/redis'
import { validateCoupon }            from '@/lib/coupons/validate'
import { resolveEffectivePriceRupees } from '@/lib/pricing/earlyBird'
import { validateInviteCode }        from '@/app/api/registrations/validate-invite-code/route'
import { validateFormResponses }     from '@/lib/registrations/validateFormResponses'
import type { RegistrationRules } from '@/components/wizard/registrationFormConfig'

// ─── Request / response shapes ────────────────────────────────────────────────

interface CreateOrderBody {
  slug:    string
  passId:  string
  attendee: {
    name:   string
    email:  string
    phone?: string
  }
  formResponses: Record<string, string>
  couponCode?:   string
  inviteCode?:   string
}

export interface CreateOrderResponse {
  orderId:       string
  amount:        number    // paise (already reflects any coupon discount)
  currency:      string
  keyId:         string    // Razorpay key_id for client-side checkout
  // When a coupon reduces the total to zero, no Razorpay order is created.
  // The client should call /api/registrations/submit with this couponCode instead.
  isCouponFree?: boolean
  couponCode?:   string
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function POST(
  req: NextRequest,
): Promise<NextResponse<CreateOrderResponse | { error: string; reason?: string }>> {
  // ── 0. Rate limit: 10 order attempts per 10 minutes per IP (distributed) ──
  const ip = getClientIp(req)
  const rl = await checkDistributedRateLimit({ key: `create-order:${ip}`, limit: 10, windowSeconds: 10 * 60, failOpen: true })
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'Too many requests. Please try again later.' },
      {
        status: 429,
        headers: {
          'Retry-After':       String(Math.ceil((rl.resetAt - Date.now()) / 1000)),
          'X-RateLimit-Limit': '10',
          'X-RateLimit-Reset': String(rl.resetAt),
        },
      },
    )
  }

  // ── 1. Optional auth ───────────────────────────────────────────────────────
  let uid: string | undefined
  const authHeader = req.headers.get('authorization') ?? ''
  const token      = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  if (token) {
    try {
      const decoded = await adminAuth.verifyIdToken(token)
      uid = decoded.uid
    } catch { /* fall through as guest */ }
  }

  // ── 2. Parse body ──────────────────────────────────────────────────────────
  let body: CreateOrderBody
  try {
    body = (await req.json()) as CreateOrderBody
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const { slug, passId, attendee, formResponses, couponCode, inviteCode } = body

  if (!slug || !passId || !attendee?.name?.trim() || !attendee?.email?.trim()) {
    return NextResponse.json(
      { error: 'slug, passId, attendee.name and attendee.email are required' },
      { status: 400 },
    )
  }
  if (!isValidEmail(attendee.email)) {
    return NextResponse.json({ error: 'Invalid email address' }, { status: 400 })
  }

  // ── 3. Gate check (server-side) ────────────────────────────────────────────
  const gate = await checkRegistrationGate(slug, passId)
  if (!gate.allowed) {
    return NextResponse.json(
      { error: 'Registration is not available', reason: gate.reason },
      { status: 403 },
    )
  }

  // ── 4. Load event and pass (Firestore is source of truth) ─────────────────
  const event = await getEventBySlug(slug)
  if (!event) return NextResponse.json({ error: 'Event not found' }, { status: 404 })

  const rawPricing = event.pricing as Record<string, unknown> | null
  const passes     = Array.isArray(rawPricing?.passes)
    ? (rawPricing!.passes as Record<string, unknown>[])
    : []
  const pass = passes.find(p => p.id === passId)
  if (!pass) return NextResponse.json({ error: 'Pass not found' }, { status: 404 })

  // Server-authoritative price: the early-bird price while active (before its
  // cutoff), otherwise the regular price. Resolved from the stored pass only —
  // the client amount is never trusted. Backward-compatible: passes without
  // early bird resolve to their regular price unchanged.
  const priceRupees = resolveEffectivePriceRupees(
    {
      price:            typeof pass.price === 'number' ? pass.price : 0,
      earlyBirdEnabled: pass.earlyBirdEnabled === true,
      earlyBirdPrice:   typeof pass.earlyBirdPrice === 'number' ? pass.earlyBirdPrice : null,
      earlyBirdEndDate: typeof pass.earlyBirdEndDate === 'string' ? pass.earlyBirdEndDate : undefined,
    },
    Date.now(),
  )
  if (priceRupees === 0) {
    return NextResponse.json(
      { error: 'This pass is free. Use /api/registrations/submit instead.' },
      { status: 400 },
    )
  }

  const passName     = typeof pass.name     === 'string' ? pass.name     : 'Pass'
  const passCapacity = pass.unlimited === true
    ? null
    : typeof pass.quantity === 'number' ? pass.quantity : null

  // ── 5. Enforce registration rules before charging the user ─────────────────
  const registrationForm = event.registrationForm
  const regRules         = registrationForm?.registrationRules as RegistrationRules | undefined

  if (regRules?.requireLogin && !uid) {
    return NextResponse.json(
      { error: 'You must be signed in to register for this event.', reason: 'LOGIN_REQUIRED' },
      { status: 401 },
    )
  }

  const normEmail = attendee.email.trim().toLowerCase()

  if (regRules?.limitPerEmail) {
    try {
      const dupSnap = await adminDb
        .collection('registrations')
        .where('eventSlug',      '==', slug)
        .where('attendee.email', '==', normEmail)
        .limit(1)
        .get()
      if (dupSnap.docs.some(d => d.data().status !== 'cancelled')) {
        return NextResponse.json(
          { error: 'A registration with this email address already exists.', reason: 'DUPLICATE_EMAIL' },
          { status: 409 },
        )
      }
    } catch (err) {
      console.warn('[create-order] limitPerEmail query failed (missing index?):', err)
    }
  }

  // P0-4: Phone required when limitPerMobile is active. Without this guard an
  // attendee who omits their phone bypasses the uniqueness rule entirely. Mirrors
  // the enforcement already present in submit/route.ts:272-277.
  if (regRules?.limitPerMobile && !attendee.phone?.trim()) {
    return NextResponse.json(
      { error: 'A phone number is required to register for this event.', reason: 'PHONE_REQUIRED' },
      { status: 400 },
    )
  }

  if (regRules?.limitPerMobile && attendee.phone?.trim()) {
    const normPhone = attendee.phone.trim()
    try {
      const dupSnap = await adminDb
        .collection('registrations')
        .where('eventSlug',      '==', slug)
        .where('attendee.phone', '==', normPhone)
        .limit(1)
        .get()
      if (dupSnap.docs.some(d => d.data().status !== 'cancelled')) {
        return NextResponse.json(
          { error: 'A registration with this mobile number already exists.', reason: 'DUPLICATE_MOBILE' },
          { status: 409 },
        )
      }
    } catch (err) {
      console.warn('[create-order] limitPerMobile query failed (missing index?):', err)
    }
  }

  // ── 5c. Invite code validation (P0-1) ─────────────────────────────────────
  // submit/route.ts validates invite codes for free registrations; this mirrors
  // that check for paid registrations so the paid flow cannot bypass invite-only
  // access control by calling the API directly.
  const inviteCheck = validateInviteCode(event.accessControl, inviteCode?.trim() ?? '')
  if (!inviteCheck.valid) {
    return NextResponse.json(
      { error: inviteCheck.error ?? 'Invalid invite code.', reason: 'INVITE_CODE_INVALID' },
      { status: 403 },
    )
  }

  // ── 6. Form validation ─────────────────────────────────────────────────────
  // Full validation (conditional + required + per-type formats + configured
  // rules) — the same rules the builder/client enforce — before charging.
  if (registrationForm?.sections?.length) {
    const validationError = validateFormResponses(registrationForm, passId, formResponses)
    if (validationError) {
      return NextResponse.json(
        { error: validationError.message },
        { status: 400 },
      )
    }
  }

  // ── 7. Resolve event name ──────────────────────────────────────────────────
  const rawDetails = event.eventDetails as Record<string, unknown>
  const rawInfo    = rawDetails?.info as Record<string, unknown> | null
  const eventName  = typeof rawInfo?.name === 'string' ? rawInfo.name : 'Event'

  // ── 7.5. Validate and apply coupon (server-side — never trust client price) ─
  const originalAmountPaise = Math.round(priceRupees * 100)
  let   finalAmountPaise    = originalAmountPaise
  let   couponDocId: string | undefined
  let   discountAmount: number | undefined
  let   appliedCouponCode: string | undefined

  if (couponCode?.trim()) {
    const couponResult = await validateCoupon(slug, couponCode, passId, originalAmountPaise)
    if (!couponResult.valid) {
      return NextResponse.json(
        { error: couponResult.error ?? 'Invalid coupon code.' },
        { status: 400 },
      )
    }
    finalAmountPaise  = couponResult.finalPaise!
    discountAmount    = couponResult.discountPaise!
    couponDocId       = couponResult.couponDocId
    appliedCouponCode = couponResult.coupon!.code

    // Coupon makes the pass free — tell the client to use the submit (free) flow
    if (finalAmountPaise === 0) {
      return NextResponse.json({
        orderId:      '',
        amount:       0,
        currency:     'INR',
        keyId:        '',
        isCouponFree: true,
        couponCode:   appliedCouponCode,
      })
    }
  }

  // ── 8. Create Razorpay order (never trust client amount) ───────────────────
  const amountPaise = finalAmountPaise
  const receipt     = `rd_${Date.now()}`   // max 40 chars

  let orderId: string
  try {
    const order = await razorpay.orders.create({
      amount:   amountPaise,
      currency: 'INR',
      receipt,
    })
    orderId = order.id
  } catch (err) {
    captureFinancialError(err, { scope: 'create-order.razorpay_failed', eventSlug: slug, passId })
    return NextResponse.json(
      { error: 'Failed to create payment order. Please try again.' },
      { status: 502 },
    )
  }

  // ── 9. Persist payment intent (authoritative data for verify-payment) ──────
  // M3: If this write fails, the Razorpay order is orphaned. Log all identifiers
  //     so the order can be voided manually. Razorpay orders expire after 15 min
  //     if no payment is captured, limiting the blast radius.
  try {
    await createPaymentIntent({
      orderId,
      eventSlug:    slug,
      passId,
      passName,
      passCapacity,
      eventName,
      organizerUid: event.uid,
      amount:       amountPaise,
      currency:     'INR',
      attendee: {
        name:          attendee.name.trim(),
        email:         normEmail,
        phone:         attendee.phone?.trim() || undefined,
        formResponses: formResponses as Record<string, unknown>,
      },
      uid,
      ...(inviteCode?.trim() ? { inviteCode: inviteCode.trim() } : {}),
      ...(appliedCouponCode ? {
        couponCode:     appliedCouponCode,
        couponDocId,
        discountAmount,
        originalAmount: originalAmountPaise,
      } : {}),
    })
  } catch (err) {
    captureFinancialError(err, { scope: 'create-order.intent_write_failed', detail: 'orphaned Razorpay order', orderId, eventSlug: slug, passId, amount: amountPaise })
    return NextResponse.json(
      { error: 'Failed to persist payment record. Please try again.' },
      { status: 500 },
    )
  }

  return NextResponse.json({
    orderId,
    amount:   amountPaise,
    currency: 'INR',
    keyId:    RAZORPAY_KEY_ID,
  })
}
