// POST /api/registrations/submit
//
// Security model:
//   1. Auth token is optional — guest registration is supported.
//   2. Gate check is re-run server-side (never trust client state).
//   3. Pass details and event data are loaded from Firestore, not from the body.
//   4. Registration + counter increment happen inside a Firestore transaction.
//   5. Capacity double-checked inside the transaction (closes TOCTOU race).

import { NextRequest, NextResponse } from 'next/server'
import { adminAuth, adminDb }       from '@/lib/firebase/admin'
import { checkRegistrationGate }    from '@/lib/registrations/gate'
import { getEventBySlug }           from '@/lib/firebase/firestore/events'
import {
  createRegistration,
  CapacityExceededError,
  DuplicateRegistrationError,
  CouponExhaustedError,
  IdempotencyHitError,
} from '@/lib/firebase/firestore/registrations'
import { setRegistrationSessions } from '@/lib/sessions/service'
import { SessionError }            from '@/lib/sessions/types'
import { checkRateLimit, getClientIp } from '@/lib/rateLimit'
import { validateInviteCode }       from '@/app/api/registrations/validate-invite-code/route'
import { sendConfirmationEmail }    from '@/lib/registrations/sendConfirmationEmail'
import { validateCoupon }           from '@/lib/coupons/validate'
import { resolveEffectivePriceRupees } from '@/lib/pricing/earlyBird'
import { validateFormResponses }     from '@/lib/registrations/validateFormResponses'
import type { RegistrationRules } from '@/components/wizard/registrationFormConfig'

// ─── Request / response shapes ────────────────────────────────────────────────

interface SubmitBody {
  slug:    string
  passId:  string
  attendee: {
    name:   string
    email:  string
    phone?: string
  }
  formResponses:   Record<string, string>
  idempotencyKey?: string
  inviteCode?:     string
  couponCode?:     string
  selectedSessions?: string[]   // optional conference session picks (G.3)
}

export interface SubmitResponse {
  success:         boolean
  registrationId?: string
  ticketCode?:     string
  eventName?:      string
  passName?:       string
  error?:          string
  reason?:         string
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function POST(
  req: NextRequest,
): Promise<NextResponse<SubmitResponse>> {
  // ── 0. Rate limit: 20 registrations per 10 minutes per IP ─────────────────
  const ip = getClientIp(req)
  const rl = checkRateLimit(ip, 'submit', 20, 10 * 60 * 1000)
  if (rl.limited) {
    return NextResponse.json(
      { success: false, error: 'Too many requests. Please try again later.' },
      {
        status: 429,
        headers: {
          'Retry-After':       String(Math.ceil((rl.resetAt - Date.now()) / 1000)),
          'X-RateLimit-Limit': '20',
          'X-RateLimit-Reset': String(rl.resetAt),
        },
      },
    )
  }

  // ── 1. Optional auth — guest registration is allowed ──────────────────────
  let uid: string | undefined
  const authHeader = req.headers.get('authorization') ?? ''
  const token      = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  if (token) {
    try {
      const decoded = await adminAuth.verifyIdToken(token)
      uid = decoded.uid
    } catch {
      // Invalid token — fall through as guest; don't block
    }
  }

  // ── 2. Parse body ──────────────────────────────────────────────────────────
  let body: SubmitBody
  try {
    body = (await req.json()) as SubmitBody
  } catch {
    return NextResponse.json(
      { success: false, error: 'Invalid request body' },
      { status: 400 },
    )
  }

  const { slug, passId, attendee, formResponses, idempotencyKey, inviteCode, couponCode } = body

  if (!slug || !passId || !attendee?.name?.trim() || !attendee?.email?.trim()) {
    return NextResponse.json(
      { success: false, error: 'slug, passId, attendee.name and attendee.email are required' },
      { status: 400 },
    )
  }

  if (!isValidEmail(attendee.email)) {
    return NextResponse.json(
      { success: false, error: 'Invalid email address' },
      { status: 400 },
    )
  }

  // ── 3. Re-run gate check (server-side — never trust client) ───────────────
  const gate = await checkRegistrationGate(slug, passId)
  if (!gate.allowed) {
    return NextResponse.json(
      { success: false, reason: gate.reason, error: 'Registration is not available' },
      { status: 403 },
    )
  }

  // ── 4. Load event (server is source of truth for all event data) ──────────
  const event = await getEventBySlug(slug)
  if (!event) {
    return NextResponse.json({ success: false, error: 'Event not found' }, { status: 404 })
  }

  // ── 5. Resolve pass from server-side pricing (never trust client price) ───
  const rawPricing = event.pricing as Record<string, unknown> | null
  const passes     = Array.isArray(rawPricing?.passes)
    ? (rawPricing!.passes as Record<string, unknown>[])
    : []
  const pass = passes.find(p => p.id === passId)
  if (!pass) {
    return NextResponse.json({ success: false, error: 'Pass not found' }, { status: 404 })
  }

  const passName     = typeof pass.name     === 'string'  ? pass.name     : 'Pass'
  const passUnlimited = pass.unlimited === true
  const passCapacity = passUnlimited
    ? null
    : typeof pass.quantity === 'number' ? pass.quantity : null

  // ── 5b. Server-side invite code enforcement ───────────────────────────────
  // This check runs on every submission regardless of client-side pre-validation.
  const acCheck = validateInviteCode(event.accessControl, inviteCode?.trim() ?? '')
  if (!acCheck.valid) {
    return NextResponse.json(
      { success: false, reason: 'INVITE_CODE_INVALID', error: acCheck.error ?? 'Invalid invite code.' },
      { status: 403 },
    )
  }

  // ── 6. Server-side form validation ────────────────────────────────────────
  // Full validation: conditional visibility/requirement, required fields, and
  // per-type formats (email/phone/url/number), option membership, and any
  // configured rules — the same rules the builder/client enforce.
  const registrationForm = event.registrationForm
  if (registrationForm?.sections?.length) {
    const validationError = validateFormResponses(registrationForm, passId, formResponses)
    if (validationError) {
      return NextResponse.json(
        { success: false, error: validationError.message },
        { status: 400 },
      )
    }
  }

  // ── 7. Resolve event name for denormalization ──────────────────────────────
  const rawDetails = event.eventDetails as Record<string, unknown>
  const rawInfo    = rawDetails?.info as Record<string, unknown> | null
  const eventName  = typeof rawInfo?.name === 'string' ? rawInfo.name : 'Event'

  // ── 7z. Extract exhibition-specific fields ────────────────────────────────
  const eventType = (event as unknown as { eventType?: string | null }).eventType ?? null

  let extraFields: Record<string, string | null> | undefined
  if (eventType === 'exhibition') {
    // Build field-id → label map from the stored registration form
    const regFormSections = (event.registrationForm as {
      sections?: Array<{ fields: Array<{ id: string; label: string }> }>
    } | null)?.sections ?? []
    const fieldLabelMap: Record<string, string> = {}
    for (const sec of regFormSections) {
      for (const fld of sec.fields ?? []) {
        if (fld.id && fld.label) fieldLabelMap[fld.id] = fld.label
      }
    }
    const fr = (formResponses ?? {}) as Record<string, string>
    function pickByLabel(pattern: RegExp): string | null {
      for (const [id, lbl] of Object.entries(fieldLabelMap)) {
        if (pattern.test(lbl)) return fr[id]?.trim() || null
      }
      return null
    }
    const companyName = pickByLabel(/company name/i)
    const passNameLower = passName.toLowerCase()
    if (
      (passNameLower.includes('exhibitor') || passNameLower.includes('sponsor'))
      && !companyName
    ) {
      return NextResponse.json(
        { success: false, error: 'Company Name is required for Exhibitor and Sponsor passes.' },
        { status: 400 },
      )
    }
    extraFields = {
      companyName,
      designation: pickByLabel(/^designation$/i),
      website:     pickByLabel(/company website|^website$/i),
      industry:    pickByLabel(/^industry$/i),
      passType:    passName,
    }
  }

  // ── 7a. Enforce requireLogin ───────────────────────────────────────────────
  const regRules = registrationForm?.registrationRules as RegistrationRules | undefined
  if (regRules?.requireLogin && !uid) {
    return NextResponse.json(
      { success: false, reason: 'LOGIN_REQUIRED', error: 'You must be signed in to register for this event.' },
      { status: 401 },
    )
  }

  // ── 7b. Enforce limitPerEmail ──────────────────────────────────────────────
  if (regRules?.limitPerEmail) {
    const normEmail = attendee.email.trim().toLowerCase()
    try {
      const dupSnap = await adminDb
        .collection('registrations')
        .where('eventSlug',      '==', slug)
        .where('attendee.email', '==', normEmail)
        .limit(1)
        .get()
      if (dupSnap.docs.some(d => d.data().status !== 'cancelled')) {
        return NextResponse.json(
          { success: false, reason: 'DUPLICATE_EMAIL', error: 'A registration with this email address already exists.' },
          { status: 409 },
        )
      }
    } catch (err) {
      console.warn('[submit] limitPerEmail query failed (missing index?):', err)
      // Degrade gracefully — allow registration rather than block on index error
    }
  }

  // ── 7c. Enforce limitPerMobile ─────────────────────────────────────────────
  // When the organizer enables phone-uniqueness, phone becomes required.
  // Allowing a blank phone would let attendees bypass the constraint entirely.
  if (regRules?.limitPerMobile) {
    if (!attendee.phone?.trim()) {
      return NextResponse.json(
        { success: false, reason: 'PHONE_REQUIRED', error: 'A phone number is required to register for this event.' },
        { status: 400 },
      )
    }
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
          { success: false, reason: 'DUPLICATE_MOBILE', error: 'A registration with this mobile number already exists.' },
          { status: 409 },
        )
      }
    } catch (err) {
      console.warn('[submit] limitPerMobile query failed (missing index?):', err)
    }
  }

  // Canonical source: accessControl.confirmationMode (set in Step 3, always written).
  // registrationRules.approvalMode can be stale when the organizer changes Step 3
  // after Step 5 was already saved — the wizard sync is UI-only and not guaranteed.
  const acConfirmationMode = (event.accessControl as { confirmationMode?: string } | null)
    ?.confirmationMode
  const approvalMode = (acConfirmationMode === 'manual' || acConfirmationMode === 'auto'
    ? acConfirmationMode
    : regRules?.approvalMode ?? 'auto') as 'auto' | 'manual'

  // ── 7.5. Validate coupon (server-side re-validation) ─────────────────────────
  // Coupon may be present when a paid pass has been discounted to zero (free-via-coupon).
  // In that case create-order returned isCouponFree:true and the client calls submit.
  // Effective price mirrors create-order: early-bird price while active, else
  // regular. A paid pass stays paid whether or not early bird is active, so the
  // "paid passes must use the payment flow" guard below is unaffected.
  const priceRupees   = resolveEffectivePriceRupees(
    {
      price:            typeof pass.price === 'number' ? pass.price : 0,
      earlyBirdEnabled: pass.earlyBirdEnabled === true,
      earlyBirdPrice:   typeof pass.earlyBirdPrice === 'number' ? pass.earlyBirdPrice : null,
      earlyBirdEndDate: typeof pass.earlyBirdEndDate === 'string' ? pass.earlyBirdEndDate : undefined,
    },
    Date.now(),
  )
  const originalPaise = Math.round(priceRupees * 100)

  let couponInfo: {
    couponDocId:    string
    code:           string
    discountAmount: number
    originalAmount: number
  } | undefined

  if (couponCode?.trim()) {
    const couponResult = await validateCoupon(slug, couponCode, passId, originalPaise)
    if (!couponResult.valid) {
      return NextResponse.json(
        { success: false, error: couponResult.error ?? 'Invalid coupon code.' },
        { status: 400 },
      )
    }
    // Ensure the coupon actually makes this pass free (otherwise use the paid flow)
    if (couponResult.finalPaise !== 0) {
      return NextResponse.json(
        { success: false, error: 'This coupon does not make the pass free. Use the payment flow.' },
        { status: 400 },
      )
    }
    couponInfo = {
      couponDocId:    couponResult.couponDocId!,
      code:           couponResult.coupon!.code,
      discountAmount: couponResult.discountPaise!,
      originalAmount: originalPaise,
    }
  } else if (priceRupees > 0) {
    // Paid pass without a coupon should not come through the submit (free) flow
    return NextResponse.json(
      { success: false, error: 'Paid passes must use the payment flow.' },
      { status: 400 },
    )
  }

  // ── 8. Create registration (transaction + atomic capacity + H2 claim guard) ──
  try {
    const result = await createRegistration({
      eventSlug:    slug,
      passId,
      passName,
      passCapacity,
      eventName,
      organizerUid: event.uid,
      attendee: {
        name:          attendee.name.trim(),
        email:         attendee.email.trim().toLowerCase(),
        phone:         attendee.phone?.trim() || undefined,
        formResponses: formResponses as Record<string, unknown>,
      },
      uid,
      // H2: pass rule flags so claim docs are written inside the transaction,
      //     closing the race condition between concurrent free-registration submits.
      limitPerEmail:  regRules?.limitPerEmail  ?? false,
      limitPerMobile: regRules?.limitPerMobile ?? false,
      // Idempotency: client UUID so same-key retries return the existing registration
      idempotencyKey: typeof idempotencyKey === 'string' && idempotencyKey.trim()
        ? idempotencyKey.trim()
        : undefined,
      approvalMode,
      couponInfo,
      extraFields,
    })

    // ── 8b. Optional conference session selection (G.3) ───────────────────────
    // Sessions are optional; reservation is transactional + independent of the
    // registration. A failure (full / time-clash) does NOT void the registration —
    // it is reported back so the UI can prompt a re-pick.
    let sessionsError: string | null = null
    let selectedSessions: string[] = []
    if (Array.isArray(body.selectedSessions) && body.selectedSessions.length > 0) {
      try {
        const r = await setRegistrationSessions(result.registrationId, body.selectedSessions, {
          expectedOrganizerUid: event.uid, expectedEventSlug: slug,
        })
        selectedSessions = r.selected
      } catch (e) {
        sessionsError = e instanceof SessionError ? e.code : 'SESSION_SELECTION_FAILED'
      }
    }

    // ── 9. Send confirmation email only for auto-confirmed registrations ──────
    // Manual approval registrations stay pending; email is sent from the
    // approve endpoint once the organizer reviews and approves the registration.
    if (approvalMode !== 'manual') {
      await sendConfirmationEmail({
        registrationId: result.registrationId,
        ticketCode:     result.ticketCode,
        attendeeName:   attendee.name.trim(),
        attendeeEmail:  attendee.email.trim().toLowerCase(),
        eventName,
        passName,
        rawDetails:     rawDetails as Record<string, unknown>,
        organizerUid:   event.uid,
        eventSlug:      slug,
      })
    }

    return NextResponse.json({
      success:        true,
      registrationId: result.registrationId,
      ticketCode:     result.ticketCode,
      eventName,
      passName,
      selectedSessions,
      sessionsError,
    })
  } catch (err) {
    if (err instanceof IdempotencyHitError) {
      return NextResponse.json({
        success:        true,
        registrationId: err.registrationId,
        ticketCode:     err.ticketCode,
        eventName,
        passName,
      })
    }
    if (err instanceof DuplicateRegistrationError) {
      return NextResponse.json(
        {
          success: false,
          reason:  err.reason,
          error:   err.reason === 'DUPLICATE_EMAIL'
            ? 'A registration with this email address already exists.'
            : 'A registration with this mobile number already exists.',
        },
        { status: 409 },
      )
    }
    if (err instanceof CapacityExceededError) {
      return NextResponse.json(
        {
          success: false,
          reason:  err.reason,
          error:   err.reason === 'EVENT_CAPACITY_FULL'
            ? 'This event is now full.'
            : err.reason === 'PASS_NOT_AVAILABLE'
            ? 'This pass is no longer available.'
            : 'This pass is now sold out.',
        },
        { status: 409 },
      )
    }
    if (err instanceof CouponExhaustedError) {
      return NextResponse.json(
        { success: false, reason: 'COUPON_EXHAUSTED', error: 'This coupon has reached its usage limit.' },
        { status: 409 },
      )
    }
    console.error('[submit] Unexpected error:', err)
    return NextResponse.json(
      { success: false, error: 'Registration failed. Please try again.' },
      { status: 500 },
    )
  }
}

