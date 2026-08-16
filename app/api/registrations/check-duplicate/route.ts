// POST /api/registrations/check-duplicate
//
// Lightweight, pre-payment duplicate-registration pre-check (RD-ATTENDEE-03A H2).
// Lets the register form warn "you're already registered" BEFORE opening Razorpay,
// so an attendee never pays for a registration the server would reject (paid duplicates
// otherwise surface only after payment, triggering a refund). This is advisory only —
// create-order / submit / verify-payment remain the authoritative gate. It reveals only
// existence for the email/phone the caller themselves typed (the same disclosure that
// already happens at submit), and is rate-limited to prevent enumeration.

import { NextRequest, NextResponse } from 'next/server'
import { getEventBySlug }              from '@/lib/firebase/firestore/events'
import { checkDuplicateRegistration, resolveDuplicateEnforcement } from '@/lib/registrations/duplicateCheck'
import { checkRateLimit, getClientIp } from '@/lib/rateLimit'
import type { RegistrationRules }      from '@/components/wizard/registrationFormConfig'

interface CheckDuplicateBody {
  slug:   string
  email?: string
  phone?: string
}

export interface CheckDuplicateResponse {
  duplicate: boolean
  field?:    'email' | 'mobile'
  /** The organizer's duplicate policy. Absent on the early/error returns. */
  policy?:   'block' | 'warn' | 'allow'
  /** True only when this duplicate must STOP the registration (policy === 'block'). */
  blocking?: boolean
  error?:    string
}

export async function POST(req: NextRequest): Promise<NextResponse<CheckDuplicateResponse>> {
  // Enumeration guard: 20 checks/min/IP.
  const ip = getClientIp(req)
  const rl = checkRateLimit(ip, 'check-duplicate', 20, 60 * 1000)
  if (rl.limited) {
    return NextResponse.json(
      { duplicate: false, error: 'Too many requests. Please try again later.' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil((rl.resetAt - Date.now()) / 1000)) } },
    )
  }

  let body: CheckDuplicateBody
  try {
    body = (await req.json()) as CheckDuplicateBody
  } catch {
    return NextResponse.json({ duplicate: false, error: 'Invalid request body' }, { status: 400 })
  }

  const slug  = body.slug?.trim()
  const email = body.email?.trim()
  const phone = body.phone?.trim()
  if (!slug || (!email && !phone)) {
    // Nothing to check → not a duplicate (never blocks the flow).
    return NextResponse.json({ duplicate: false })
  }

  const event = await getEventBySlug(slug)
  if (!event) return NextResponse.json({ duplicate: false })

  const regRules = (event.registrationForm?.registrationRules as RegistrationRules | undefined)

  // RD-REG-DUP-01 — ONE resolver decides whether duplicates matter here at all. Under
  // "Allow All" it reports both limits as false, so no query is even issued.
  const enforcement = resolveDuplicateEnforcement(regRules)
  const result = await checkDuplicateRegistration({
    slug,
    email,
    phone,
    limitPerEmail:  enforcement.limitPerEmail,
    limitPerMobile: enforcement.limitPerMobile,
  })

  // `blocking` is the single value the form should branch on, so the block-vs-warn rule is
  // never re-derived client-side and can never drift from the server's decision.
  return NextResponse.json({
    duplicate: result.duplicate,
    policy:    enforcement.policy,
    blocking:  result.duplicate && enforcement.enforce,
    ...(result.field ? { field: result.field } : {}),
  })
}
