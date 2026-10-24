// GET /api/certificates/download/[registrationId]
//
// Attendee self-serve certificate download. Accessed from the ticket page.
// The registrationId is the capability token (non-guessable UUID from Firestore).
//
// Flow:
//  1. Load registration
//  2. Load certificate template for the event
//  3. Check eligibility (template.enabled, type, check-in status)
//  4. Find the issued certificate (modern → redirect; legacy record → serve). Never creates one.
//  5. Render and return the PDF of an issued legacy record

import { NextRequest, NextResponse }         from 'next/server'
import { adminDb }                           from '@/lib/firebase/admin'
import {
  getTemplate,
  getCertificateByRegistrationId,
  findCertificate,
  incrementDownloadCount,
  getSettings,
}                                            from '@/lib/certificates/firestore'
import { defaultCertificateSettings }        from '@/lib/certificates/types'
import { generateCertificatePdf }            from '@/lib/certificates/pdf'
import { getClientIp }                       from '@/lib/rateLimit'
import { RATE_POLICY, checkPolicy }          from '@/lib/rateLimit/policies'
import type { RegistrationDocument }         from '@/lib/registrations/types'
import { getEmailAppUrl } from '@/lib/email/appUrl'

type Params = { params: Promise<{ registrationId: string }> }

// RD-EMAIL-PRODUCTION-URL — one guarded resolver; the old local fallback could not
// tell a localhost origin from a real one before embedding it in mail.
const APP_URL = () => getEmailAppUrl()

export interface CertificateEligibilityResponse {
  eligible: false
  // RD-CERT-03 · 'revoked' is additive: a modern certificate can be revoked, and the
  // attendee must be told that rather than silently handed a regenerated PDF.
  // RD-CERT-BILL-01 · 'not_issued': no certificate has been issued for this registration yet
  // (this route serves issued certificates; it never mints one).
  reason:   'not_enabled' | 'checkin_required' | 'not_confirmed' | 'not_found' | 'refunded' | 'downloads_disabled' | 'verification_required' | 'revoked' | 'not_issued'
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
  const { registrationId } = await params

  // RD-CERT-SCALE-01 — keyed on IP **and** the certificate, not IP alone. A whole venue
  // shares one NAT address at a live event, so an IP-only bucket refused legitimate attendees
  // downloading their own certificates. Limit and window are UNCHANGED (60/min): repeatedly
  // pulling the SAME certificate from one address is still throttled exactly as before, while
  // a thousand attendees fetching a thousand different certificates no longer collide.
  const rl = checkPolicy(`${getClientIp(req)}|${registrationId}`, RATE_POLICY.pdfDownload)
  if (rl.limited) {
    return NextResponse.json(
      { error: 'Too many requests. Please try again shortly.' },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfter) } },
    )
  }

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

  // ═══ RD-CERT-03 · THE MODERN CERTIFICATE COMES FIRST ═══════════════════════
  //
  // ═══ THE DEFECT THIS CLOSES ═════════════════════════════════════════════════
  // This route did find-or-create against `certificateRecords` ALONE. It is reached
  // from the attendee's own ticket page and from the organizer's check-in drawer, so
  // an attendee whose certificate had already been issued through the modern engine
  // clicked "Download" and:
  //
  //   • their real certificate was not found (wrong collection),
  //   • a SECOND certificate was created for them in the legacy collection,
  //   • with a DIFFERENT certificateId — so the PDF they received carried a
  //     verification id the organizer had never issued and Reports had never seen,
  //   • and the download was counted against that phantom record.
  //
  // One participant, two certificates, two inventories, and the two surfaces
  // permanently disagreeing. A public button forked the certificate inventory.
  //
  // So: if a modern certificate exists for this registration, it IS the certificate.
  // The attendee is redirected to the canonical `/file` route, which serves the
  // stored R2 artifact, applies the same download settings, and increments the
  // download on the RIGHT document.
  //
  // The legacy find-or-create below is untouched and still runs for events that only
  // ever used the MVP path — no migration, no behaviour change for them.
  const modern = await findCertificate(eventId, registrationId, template.type)
  if (modern) {
    // Revoked is refused here rather than by redirecting into a 410, so the attendee
    // sees this route's own vocabulary.
    if (modern.status === 'revoked') {
      return NextResponse.json(
        { eligible: false, reason: 'revoked' } satisfies CertificateEligibilityResponse,
        { status: 410 },
      )
    }
    const token = req.nextUrl.searchParams.get('token')
    const target = `/api/certificates/${encodeURIComponent(modern.certificateId)}/file`
      + (token ? `?token=${encodeURIComponent(token)}` : '')
    // 307 preserves the method and lets `/file` own the artifact, the settings gate
    // and the download counter — one implementation, not two.
    return NextResponse.redirect(new URL(target, req.nextUrl.origin), 307)
  }

  // RD-CERT-BILL-01 — a legacy (MVP) record ALREADY issued is still served, exactly as before.
  // This route no longer CREATES one: the auto-generate here minted a verifiable certificate
  // without reserving the event's paid certificate capacity (an unmetered path, reachable by
  // anyone holding the registrationId). New certificates are issued through the modern engine
  // (organizer issue / bulk jobs → generateCertificate), which reserves a unit BEFORE any
  // render, upload or record write. Refused here before any write or PDF render.
  const record = await getCertificateByRegistrationId(registrationId)
  if (!record) {
    return NextResponse.json({ eligible: false, reason: 'not_issued' } satisfies CertificateEligibilityResponse, { status: 404 })
  }

  // Generate PDF
  const verifyUrl = `${APP_URL()}/verify/certificate/${record.certificateId}`
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
