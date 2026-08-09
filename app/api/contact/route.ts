// POST /api/contact — the public contact enquiry endpoint.
//
// RD-LAUNCH-02. Closes RD-LAUNCH-01 P0-1: the contact form validated locally and then
// called `setSubmitted(true)`, showing a success panel for a message that was never
// stored or sent. Every enquiry since the page shipped was silently discarded.
//
// The endpoint does exactly two things per accepted enquiry — one Firestore write and
// one email — and reuses the existing infrastructure for both: `checkRateLimit` (the
// same limiter the registration routes use) and `sendCustomEmail` on the shared SES
// provider. No new email helper, no second transport.
//
// Deliberately unauthenticated: it is a public contact form. Abuse is bounded by the
// rate limiter and a honeypot rather than by a login wall.

import { NextRequest, NextResponse } from 'next/server'
import { adminDb }                    from '@/lib/firebase/admin'
import { FieldValue }                 from 'firebase-admin/firestore'
import { getEmailProvider }           from '@/lib/email'
import { checkRateLimit, getClientIp } from '@/lib/rateLimit'
import {
  validateEnquiry, normaliseEnquiry, buildEnquiryEmailHtml,
} from '@/lib/marketing/enquiry'

/** Where internal notifications land. Overridable per environment. */
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL?.trim() || 'support@registerdesk.in'

export interface ContactResponse {
  success: boolean
  error?:  string
  /** Field-level messages so the form can mark the offending inputs. */
  fieldErrors?: { field: string; message: string }[]
}

export async function POST(req: NextRequest): Promise<NextResponse<ContactResponse>> {
  // ── 1. Rate limit — 5 enquiries per hour per IP ────────────────────────────
  // A genuine visitor sends one. Five leaves room for a retry after a failure while
  // making the form useless as a spam relay.
  const ip = getClientIp(req)
  const rl = checkRateLimit(ip, 'contact', 5, 60 * 60 * 1000)
  if (rl.limited) {
    return NextResponse.json(
      { success: false, error: 'Too many enquiries from this connection. Please try again later, or email us directly.' },
      {
        status: 429,
        headers: {
          'Retry-After':       String(Math.ceil((rl.resetAt - Date.now()) / 1000)),
          'X-RateLimit-Limit': '5',
          'X-RateLimit-Reset': String(rl.resetAt),
        },
      },
    )
  }

  // ── 2. Parse ───────────────────────────────────────────────────────────────
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid request body.' }, { status: 400 })
  }

  // ── 3. Honeypot ────────────────────────────────────────────────────────────
  // A field hidden from humans; only a bot filling every input completes it. Answered
  // with 200 on purpose — telling a bot it was detected just teaches it to adapt.
  const trap = (body as Record<string, unknown>)?.website
  if (typeof trap === 'string' && trap.trim()) {
    return NextResponse.json({ success: true })
  }

  // ── 4. Validate server-side (same rules the form applies) ──────────────────
  const fieldErrors = validateEnquiry(body)
  if (fieldErrors.length > 0) {
    return NextResponse.json(
      { success: false, error: 'Please check the highlighted fields.', fieldErrors },
      { status: 400 },
    )
  }

  const enquiry = normaliseEnquiry(body)

  // ── 5. Store — ONE write ───────────────────────────────────────────────────
  // The record is written first. If the notification later fails the enquiry is still
  // captured and recoverable from Firestore, which is the outcome that matters; the
  // reverse ordering could email a message that was never persisted.
  let enquiryId: string
  try {
    const ref = await adminDb.collection('enquiries').add({
      ...enquiry,
      status:    'new',
      createdAt: FieldValue.serverTimestamp(),
    })
    enquiryId = ref.id
  } catch (err) {
    // Never surface the underlying error to the browser.
    console.error('[contact] enquiry write failed:', err instanceof Error ? err.message : err)
    return NextResponse.json(
      { success: false, error: 'We could not submit your enquiry just now. Please try again, or email us directly.' },
      { status: 500 },
    )
  }

  // ── 6. Notify — ONE email ──────────────────────────────────────────────────
  // Best-effort by design: the enquiry is already safe in Firestore, so a mail failure
  // must not tell the visitor their message was lost. It is logged for follow-up.
  try {
    const provider = getEmailProvider()
    if (provider) {
      const receivedAt = new Date().toLocaleString('en-IN', {
        dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata',
      })
      await provider.sendCustomEmail({
        to:      SUPPORT_EMAIL,
        subject: `New Contact Enquiry — ${enquiry.fullName}`,
        html:    buildEnquiryEmailHtml(enquiry, receivedAt),
      })
    } else {
      console.warn('[contact] email provider not configured; enquiry stored only:', enquiryId)
    }
  } catch (err) {
    console.error('[contact] notification failed for', enquiryId, err instanceof Error ? err.message : err)
  }

  return NextResponse.json({ success: true })
}
