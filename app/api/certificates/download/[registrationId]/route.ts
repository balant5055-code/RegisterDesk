// GET /api/certificates/download/[registrationId]
//
// Attendee self-serve certificate download. Accessed from the ticket page.
// The registrationId is the capability token (non-guessable UUID from Firestore).
//
// Flow:
//  1. Load registration
//  2. Load certificate template for the event
//  3. Check eligibility (template.enabled, type, check-in status)
//  4. Find or create a certificate record
//  5. Generate and return the PDF

import { NextRequest, NextResponse }         from 'next/server'
import { adminDb }                           from '@/lib/firebase/admin'
import {
  getTemplate,
  getCertificateByRegistrationId,
  createCertificateRecord,
  incrementDownloadCount,
  getSettings,
}                                            from '@/lib/certificates/firestore'
import { defaultCertificateSettings }        from '@/lib/certificates/types'
import { generateCertificatePdf }            from '@/lib/certificates/pdf'
import { generateCertificateId }             from '@/lib/certificates/id'
import { getClientIp }                       from '@/lib/rateLimit'
import { RATE_POLICY, checkPolicy }          from '@/lib/rateLimit/policies'
import type { RegistrationDocument }         from '@/lib/registrations/types'

type Params = { params: Promise<{ registrationId: string }> }

const APP_URL = (process.env.NEXT_PUBLIC_APP_URL ?? 'https://registerdesk.in').replace(/\/$/, '')

export interface CertificateEligibilityResponse {
  eligible: false
  reason:   'not_enabled' | 'checkin_required' | 'not_confirmed' | 'not_found' | 'refunded' | 'downloads_disabled' | 'verification_required'
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })
}

function toISO(val: unknown): string | null {
  if (!val) return null
  if (typeof (val as { toDate?: () => Date }).toDate === 'function') {
    return (val as { toDate: () => Date }).toDate().toISOString()
  }
  return null
}

export async function GET(req: NextRequest, { params }: Params): Promise<NextResponse> {
  // Per-IP throttle: this route renders a PDF (and may scan drafts) on every hit.
  const rl = checkPolicy(getClientIp(req), RATE_POLICY.pdfDownload)
  if (rl.limited) {
    return NextResponse.json(
      { error: 'Too many requests. Please try again shortly.' },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfter) } },
    )
  }

  const { registrationId } = await params

  // Load registration
  const regSnap = await adminDb.collection('registrations').doc(registrationId).get()
  if (!regSnap.exists) {
    return NextResponse.json({ eligible: false, reason: 'not_found' } satisfies CertificateEligibilityResponse, { status: 404 })
  }
  const reg = regSnap.data() as RegistrationDocument

  if (reg.status !== 'confirmed') {
    return NextResponse.json({ eligible: false, reason: 'not_confirmed' } satisfies CertificateEligibilityResponse, { status: 403 })
  }

  // P7.1: a refunded registration (status stays 'confirmed') is not eligible.
  if (reg.paymentStatus === 'refunded') {
    return NextResponse.json({ eligible: false, reason: 'refunded' } satisfies CertificateEligibilityResponse, { status: 403 })
  }

  // Load draft to get eventId — need to find the organizer's draft for this event
  // Since RegistrationDocument has organizerUid + eventSlug, we need the eventId (draftId).
  // We do a reverse-lookup via the draft's seo.urlSlug matching reg.eventSlug.
  // More efficient: query eventDrafts isn't possible without knowing the uid.
  // Instead, store eventId in the certificate record — but we don't have it in reg.
  // Workaround: scan certificateTemplates by eventSlug is not indexed.
  // Best approach: use reg.organizerUid to query their drafts for matching slug.

  const draftsSnap = await adminDb
    .collection(`users/${reg.organizerUid}/eventDrafts`)
    .get()

  let eventId: string | null = null
  for (const d of draftsSnap.docs) {
    const data    = d.data() as Record<string, unknown>
    const details = (data.eventDetails as Record<string, unknown>) ?? {}
    const seo     = (details.seo       as Record<string, unknown>) ?? {}
    if (seo.urlSlug === reg.eventSlug) { eventId = d.id; break }
  }

  if (!eventId) {
    return NextResponse.json({ eligible: false, reason: 'not_enabled' } satisfies CertificateEligibilityResponse, { status: 404 })
  }

  // Load template
  const template = await getTemplate(eventId)
  if (!template?.enabled) {
    return NextResponse.json({ eligible: false, reason: 'not_enabled' } satisfies CertificateEligibilityResponse, { status: 403 })
  }

  if (template.type === 'completion' && !reg.checkedIn) {
    return NextResponse.json({ eligible: false, reason: 'checkin_required' } satisfies CertificateEligibilityResponse, { status: 403 })
  }

  // P7.1: enforce the organizer's download settings on this attendee route too
  // (no bypass). This is an attendee-facing endpoint, so the organizer-bypass of
  // the /file route does not apply here.
  const download = (await getSettings(eventId))?.download ?? defaultCertificateSettings().download
  if (!download.enabled || !download.allowAttendee) {
    return NextResponse.json({ eligible: false, reason: 'downloads_disabled' } satisfies CertificateEligibilityResponse, { status: 403 })
  }
  if (download.requireVerification) {
    const token  = req.nextUrl.searchParams.get('token') ?? ''
    const record = await getCertificateByRegistrationId(registrationId)
    const recToken = (record as { verificationToken?: string | null } | null)?.verificationToken ?? null
    if (!recToken || token !== recToken) {
      return NextResponse.json({ eligible: false, reason: 'verification_required' } satisfies CertificateEligibilityResponse, { status: 403 })
    }
  }

  // Find existing or create new certificate record
  let record = await getCertificateByRegistrationId(registrationId)

  if (!record) {
    // Auto-generate
    const draft    = draftsSnap.docs.find(d => d.id === eventId)!.data() as Record<string, unknown>
    const details  = (draft.eventDetails as Record<string, unknown>) ?? {}
    const info     = (details.info       as Record<string, unknown>) ?? {}
    const sched    = (details.schedule   as Record<string, unknown>) ?? {}
    const eventName = typeof info.name === 'string' ? info.name : reg.eventName
    const startDate = typeof sched.startDate === 'string'
      ? fmtDate(new Date(sched.startDate).toISOString())
      : ''

    const certificateId = generateCertificateId()
    await createCertificateRecord({
      certificateId,
      eventId,
      eventSlug:      reg.eventSlug,
      registrationId,
      organizerUid:   reg.organizerUid,
      attendeeName:   reg.attendee.name,
      attendeeEmail:  reg.attendee.email,
      eventName,
      eventDate:      startDate,
    })

    record = await getCertificateByRegistrationId(registrationId)
    if (!record) {
      return NextResponse.json({ error: 'Certificate generation failed' }, { status: 500 })
    }
  }

  // Generate PDF
  const verifyUrl = `${APP_URL}/verify/certificate/${record.certificateId}`
  const issueDate = toISO(record.issuedAt)
    ? fmtDate(toISO(record.issuedAt)!)
    : new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })

  let pdfBytes: Uint8Array
  try {
    pdfBytes = await generateCertificatePdf(template, record, verifyUrl, issueDate)
  } catch (e) {
    console.error('[certificates/download]', e)
    return NextResponse.json({ error: 'PDF generation failed' }, { status: 500 })
  }

  void incrementDownloadCount(record.certificateId).catch(() => {})

  return new NextResponse(Buffer.from(pdfBytes), {
    status: 200,
    headers: {
      'Content-Type':        'application/pdf',
      'Content-Disposition': `attachment; filename="certificate-${record.certificateId}.pdf"`,
      'Cache-Control':       'no-store',
    },
  })
}
