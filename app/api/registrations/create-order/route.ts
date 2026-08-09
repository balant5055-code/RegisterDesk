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
import { adminAuth }                 from '@/lib/firebase/admin'
import { checkDuplicateRegistration } from '@/lib/registrations/duplicateCheck'
import { captureFinancialError }     from '@/lib/monitoring/sentry'
import { checkRegistrationGate }     from '@/lib/registrations/gate'
import { getEventBySlug }            from '@/lib/firebase/firestore/events'
import { createPaymentIntent }       from '@/lib/firebase/firestore/paymentIntents'
import { razorpay, RAZORPAY_KEY_ID } from '@/lib/razorpay/client'   // C1: throws if keys absent
import { getClientIp } from '@/lib/rateLimit'
import { checkDistributedRateLimit } from '@/lib/rateLimit/redis'
import { validateCoupon }            from '@/lib/coupons/validate'
import { resolveEffectivePassPricePaise } from '@/lib/pricing/earlyBird'
import { resolveAttendeeIdentity }   from '@/lib/registrations/attendeeIdentity'
import type { IdentityField }        from '@/lib/registrations/attendeeIdentity'
import { validateInviteCode }        from '@/app/api/registrations/validate-invite-code/route'
import { validateFormResponses, sanitizeFormResponses } from '@/lib/registrations/validateFormResponses'
import { resolveServerEligibility }  from '@/lib/registrations/ageEligibility'
import type { RegistrationRules } from '@/components/wizard/registrationFormConfig'
// RD-PAYMENT-02 Phase 4 — feature-gated canonical charge amount.
import { resolvePlatformPricing }    from '@/lib/platform/pricing/resolver'
import { resolveCheckoutCharge }     from '@/lib/fees/checkoutCharge'
import { resolveFeeConfig }          from '@/lib/fees/resolveFeeConfig'
import { getFeePlanForOrganizer }    from '@/lib/billing/feeEngine'
import { builderFeeModelToEngine, normalizeFeeModel } from '@/lib/events/builder/types'
import type { FeeConfig, FeeBreakdownRecord } from '@/lib/fees/types'

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

  const { slug, passId, formResponses, couponCode, inviteCode } = body

  if (!slug || !passId || !body.attendee?.name?.trim() || !body.attendee?.email?.trim()) {
    return NextResponse.json(
      { error: 'slug, passId, attendee.name and attendee.email are required' },
      { status: 400 },
    )
  }
  if (!isValidEmail(body.attendee.email)) {
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

  // Server-authoritative base amount (integer paise): the early-bird price while active
  // (before its cutoff), otherwise the regular price. Resolved from the stored pass only
  // via the ONE canonical resolver — the client amount is never trusted. Backward-
  // compatible: passes without early bird resolve to Math.round(price*100) unchanged.
  const originalAmountPaise = resolveEffectivePassPricePaise(pass, Date.now())
  if (originalAmountPaise === 0) {
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

  // Canonical attendee identity (RD-ATTENDEE-03A C1): derive the authoritative stored
  // identity from the submitted responses via the ONE shared resolver (the same the
  // client used), falling back to the client-sent values. Dedup + payment-intent +
  // ticket all read this single model.
  // RD-RT4.0 — strip anything that is not a configured field before it is validated,
  // used for identity, or stored on the payment intent.
  const safeResponses  = sanitizeFormResponses(registrationForm?.sections ?? [], formResponses)
  const identityFields = ((registrationForm?.sections ?? []) as { fields: IdentityField[] }[]).flatMap(s => s.fields)
  const identity = resolveAttendeeIdentity(identityFields, safeResponses)
  const attendee = {
    name:  (identity.name  || body.attendee.name).trim(),
    email: (identity.email || body.attendee.email).trim().toLowerCase(),
    phone: (identity.phone || body.attendee.phone || '').trim() || undefined,
  }

  const normEmail = attendee.email.trim().toLowerCase()

  // P0-4: Phone required when limitPerMobile is active. Without this guard an
  // attendee who omits their phone bypasses the uniqueness rule entirely. Mirrors
  // the enforcement already present in submit/route.ts.
  if (regRules?.limitPerMobile && !attendee.phone?.trim()) {
    return NextResponse.json(
      { error: 'A phone number is required to register for this event.', reason: 'PHONE_REQUIRED' },
      { status: 400 },
    )
  }

  // H2: authoritative duplicate check via the ONE shared helper (also used by the
  // pre-payment pre-check and submit) — never charge a user for a duplicate.
  const dup = await checkDuplicateRegistration({
    slug,
    email:          attendee.email,
    phone:          attendee.phone,
    limitPerEmail:  regRules?.limitPerEmail  ?? false,
    limitPerMobile: regRules?.limitPerMobile ?? false,
  })
  if (dup.duplicate) {
    return dup.field === 'mobile'
      ? NextResponse.json({ error: 'A registration with this mobile number already exists.', reason: 'DUPLICATE_MOBILE' }, { status: 409 })
      : NextResponse.json({ error: 'A registration with this email address already exists.', reason: 'DUPLICATE_EMAIL' }, { status: 409 })
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
    // RD-RT4.0 — age eligibility enforced before any charge is created, from the
    // server-loaded pass + event date, through the same shared rule the client uses.
    const eligibility = resolveServerEligibility(event.eventDetails as Record<string, unknown>, pass)
    const validationError = validateFormResponses(registrationForm, passId, safeResponses, eligibility)
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
  // originalAmountPaise resolved above (canonical early-bird base).
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

  // ── 7.6. RD-PAYMENT-02 Phase 4: canonical charge amount (feature-gated) ─────
  // pricingEngineEnabled is the ONLY activation switch. resolvePlatformPricing never
  // throws (falls back to defaults, flag = false), so reading it can't break checkout.
  // When OFF: no fee-config I/O runs and resolveCheckoutCharge returns finalAmountPaise
  //   unchanged, with no breakdown — byte-identical to production.
  // When ON: organizer_pays charges the ticket (chargeAmountPaise === finalAmountPaise);
  //   customer_pays charges ticket + fees. Every current event maps to organizer_pays
  //   (normalizeFeeModel keeps attendee_pays "Coming Soon"), so activating the flag does
  //   NOT change any charge today — it only starts persisting the additive breakdown.
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
  const amountPaise: number = charge.amountPaise
  const financials: FeeBreakdownRecord | undefined = charge.financials

  // ── 8. Create Razorpay order (never trust client amount) ───────────────────
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
        // RD-RT4.0: sanitised — unknown keys never reach the payment intent either.
        formResponses: safeResponses as Record<string, unknown>,
      },
      uid,
      ...(inviteCode?.trim() ? { inviteCode: inviteCode.trim() } : {}),
      ...(appliedCouponCode ? {
        couponCode:     appliedCouponCode,
        couponDocId,
        discountAmount,
        originalAmount: originalAmountPaise,
      } : {}),
      // RD-PAYMENT-02 Phase 4 — canonical fee breakdown (present only when the pricing
      // engine is enabled). Additive; `amount` above is unchanged and remains the charge.
      ...(financials ? { financials } : {}),
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
    // RD-PAYMENT-05 B1: return the canonical fee breakdown so the checkout can show the
    // attendee EXACTLY what they will pay before Razorpay opens. Present only when the
    // pricing engine ran (attendee_pays); absent under organizer_pays → response unchanged.
    // financials.chargeAmountPaise === amount above (same object) → display == order == ledger.
    ...(financials ? { financials } : {}),
  })
}
