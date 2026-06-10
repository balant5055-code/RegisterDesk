// POST /api/registrations/submit
//
// Security model:
//   1. Auth token is optional — guest registration is supported.
//   2. Gate check is re-run server-side (never trust client state).
//   3. Pass details and event data are loaded from Firestore, not from the body.
//   4. Registration + counter increment happen inside a Firestore transaction.
//   5. Capacity double-checked inside the transaction (closes TOCTOU race).

import { NextRequest, NextResponse } from 'next/server'
import { FieldValue }               from 'firebase-admin/firestore'
import { adminAuth, adminDb }       from '@/lib/firebase/admin'
import { checkRegistrationGate }    from '@/lib/registrations/gate'
import { getEventBySlug }           from '@/lib/firebase/firestore/events'
import {
  createRegistration,
  CapacityExceededError,
  DuplicateRegistrationError,
  IdempotencyHitError,
} from '@/lib/firebase/firestore/registrations'
import { checkRateLimit, getClientIp } from '@/lib/rateLimit'
import { signTicketToken }          from '@/lib/tickets/generate'
import { getEmailProvider, fmtEmailDate } from '@/lib/email'
import type { RegistrationFormDraft, FormField, RegistrationRules } from '@/components/wizard/registrationFormConfig'

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

function getVisibleRequiredFields(
  form:   RegistrationFormDraft,
  passId: string,
): FormField[] {
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

  const { slug, passId, attendee, formResponses, idempotencyKey } = body

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

  // ── 6. Server-side form validation ────────────────────────────────────────
  const registrationForm = event.registrationForm
  if (registrationForm?.sections?.length) {
    const requiredFields = getVisibleRequiredFields(registrationForm, passId)
    const missing: string[] = []
    for (const field of requiredFields) {
      const val = (formResponses?.[field.id] ?? '').toString().trim()
      if (!val) missing.push(field.label)
    }
    if (missing.length > 0) {
      return NextResponse.json(
        { success: false, error: `Required fields missing: ${missing.slice(0, 5).join(', ')}` },
        { status: 400 },
      )
    }
  }

  // ── 7. Resolve event name for denormalization ──────────────────────────────
  const rawDetails = event.eventDetails as Record<string, unknown>
  const rawInfo    = rawDetails?.info as Record<string, unknown> | null
  const eventName  = typeof rawInfo?.name === 'string' ? rawInfo.name : 'Event'

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
    })

    // ── 9. Send confirmation email (never blocks or throws to the caller) ───────
    await sendRegistrationEmail({
      registrationId: result.registrationId,
      ticketCode:     result.ticketCode,
      attendeeName:   attendee.name.trim(),
      attendeeEmail:  attendee.email.trim().toLowerCase(),
      eventName,
      passName,
      rawDetails:     rawDetails as Record<string, unknown>,
    })

    return NextResponse.json({
      success:        true,
      registrationId: result.registrationId,
      ticketCode:     result.ticketCode,
      eventName,
      passName,
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
            : 'This pass is now sold out.',
        },
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

// ─── Email helper ─────────────────────────────────────────────────────────────
//
// Never throws. Email failures are logged and stored in Firestore but must
// never break the registration flow.

interface EmailArgs {
  registrationId: string
  ticketCode:     string
  attendeeName:   string
  attendeeEmail:  string
  eventName:      string
  passName:       string
  rawDetails:     Record<string, unknown>
}

async function sendRegistrationEmail(args: EmailArgs): Promise<void> {
  const provider = getEmailProvider()
  if (!provider) return   // email not configured — skip silently

  const {
    registrationId, ticketCode, attendeeName, attendeeEmail,
    eventName, passName, rawDetails,
  } = args

  // Extract schedule + venue from denormalised event details
  const schedule   = rawDetails.schedule as Record<string, unknown> | null
  const startDate  = typeof schedule?.startDate === 'string' ? schedule.startDate : ''
  const startTime  = typeof schedule?.startTime === 'string' ? schedule.startTime : ''

  const venueRaw   = rawDetails.venue as Record<string, unknown> | null
  const venueType  = typeof venueRaw?.type === 'string' ? venueRaw.type : ''
  const physical   = venueRaw?.physical as Record<string, unknown> | null
  const online     = venueRaw?.online   as Record<string, unknown> | null
  const venueName  = venueType === 'online'
    ? (typeof online?.platform === 'string' ? online.platform : 'Online')
    : (typeof physical?.name === 'string' ? physical.name : '')
  const venueCity  = venueType !== 'online'
    ? (typeof physical?.city === 'string' ? physical.city : '')
    : ''

  const baseUrl   = process.env.NEXT_PUBLIC_APP_URL ?? ''
  const pdfToken  = signTicketToken(registrationId)
  const pdfUrl    = `${baseUrl}/api/tickets/${registrationId}/pdf${pdfToken ? `?token=${encodeURIComponent(pdfToken)}` : ''}`

  let emailStatus: 'sent' | 'failed' = 'failed'
  let emailFailureReason: string | undefined

  try {
    const result = await provider.sendRegistrationEmail({
      to:             attendeeEmail,
      attendeeName,
      eventName,
      eventDate:      fmtEmailDate(startDate) || startDate,
      eventTime:      startTime   || undefined,
      venueName:      venueName   || undefined,
      venueCity:      venueCity   || undefined,
      ticketCode,
      passName,
      registrationId,
      ticketPageUrl:  `${baseUrl}/tickets/${registrationId}`,
      pdfDownloadUrl: pdfUrl,
    })

    emailStatus = result.success ? 'sent' : 'failed'
    if (!result.success) emailFailureReason = result.error
    if (!result.success) {
      console.error(`[email] Registration email failed for ${registrationId}:`, result.error)
    }
  } catch (err) {
    emailFailureReason = err instanceof Error ? err.message : 'Unknown error'
    console.error(`[email] Unexpected error sending registration email for ${registrationId}:`, err)
  }

  // Update emailStatus in Firestore — fire and forget (non-critical status field)
  adminDb.collection('registrations').doc(registrationId).update({
    emailStatus,
    ...(emailStatus === 'sent'
      ? { emailSentAt: FieldValue.serverTimestamp() }
      : { emailFailureReason }),
  }).catch(updateErr =>
    console.error(`[email] Failed to persist emailStatus for ${registrationId}:`, updateErr),
  )
}
