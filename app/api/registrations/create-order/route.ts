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
import { checkRegistrationGate }     from '@/lib/registrations/gate'
import { getEventBySlug }            from '@/lib/firebase/firestore/events'
import { createPaymentIntent }       from '@/lib/firebase/firestore/paymentIntents'
import { razorpay, RAZORPAY_KEY_ID } from '@/lib/razorpay/client'   // C1: throws if keys absent
import { checkRateLimit, getClientIp } from '@/lib/rateLimit'
import type {
  RegistrationFormDraft,
  FormField,
  RegistrationRules,
} from '@/components/wizard/registrationFormConfig'

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
}

export interface CreateOrderResponse {
  orderId:  string
  amount:   number    // paise
  currency: string
  keyId:    string    // Razorpay key_id for client-side checkout
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
}

function getVisibleRequiredFields(form: RegistrationFormDraft, passId: string): FormField[] {
  return form.sections
    .flatMap(s => s.fields)
    .filter(field => {
      if (!field.visible || !field.required) return false
      if (field.passVisibility === 'all') return true
      return Array.isArray(field.passVisibility) && field.passVisibility.includes(passId)
    })
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function POST(
  req: NextRequest,
): Promise<NextResponse<CreateOrderResponse | { error: string; reason?: string }>> {
  // ── 0. Rate limit: 10 order attempts per 10 minutes per IP ────────────────
  const ip = getClientIp(req)
  const rl = checkRateLimit(ip, 'create-order', 10, 10 * 60 * 1000)
  if (rl.limited) {
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

  const { slug, passId, attendee, formResponses } = body

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

  const priceRupees = typeof pass.price === 'number' ? pass.price : 0
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

  // ── 6. Form validation ─────────────────────────────────────────────────────
  if (registrationForm?.sections?.length) {
    const requiredFields = getVisibleRequiredFields(registrationForm, passId)
    const missing: string[] = []
    for (const field of requiredFields) {
      const val = (formResponses?.[field.id] ?? '').toString().trim()
      if (!val) missing.push(field.label)
    }
    if (missing.length > 0) {
      return NextResponse.json(
        { error: `Required fields missing: ${missing.slice(0, 5).join(', ')}` },
        { status: 400 },
      )
    }
  }

  // ── 7. Resolve event name ──────────────────────────────────────────────────
  const rawDetails = event.eventDetails as Record<string, unknown>
  const rawInfo    = rawDetails?.info as Record<string, unknown> | null
  const eventName  = typeof rawInfo?.name === 'string' ? rawInfo.name : 'Event'

  // ── 8. Create Razorpay order (never trust client amount) ───────────────────
  const amountPaise = Math.round(priceRupees * 100)
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
    console.error('[create-order] Razorpay API error:', err)
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
    })
  } catch (err) {
    console.error('[create-order] Payment intent write failed — orphaned Razorpay order:', {
      orderId,
      eventSlug: slug,
      passId,
      amount:    amountPaise,
      err,
    })
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
