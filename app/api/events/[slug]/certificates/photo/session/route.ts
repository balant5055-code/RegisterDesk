// POST /api/events/{slug}/certificates/photo/session
//
// RD-CERT-PHOTO-03 — mints a certificate-photo grant WITHOUT an OTP.
//
// This replaces `photo/otp/verify`. The product decision is that adding a photo to your own
// certificate should not require a code: the attendee has already found their certificate by
// email / mobile / registration id / bib and explicitly confirmed WHICH person they are.
//
// WHAT THAT COSTS, AND WHY IT IS ACCEPTABLE HERE. Without the OTP this grant no longer
// proves control of the certificate's email — it proves only that the caller completed a
// public lookup, which a mobile number is enough for. That would be a real vulnerability if
// the grant still authorised a PERMANENT write to `registration.attendeePhotoKey`: anyone
// knowing a family's mobile could overwrite a stranger's stored photo for good. It does not.
// The grant now authorises exactly one thing — a TEMPORARY, certificate-scoped object that
// expires with the grant (see photoGrant.photoKey) and is used only to personalise a
// download. The blast radius is one PDF, for 20 minutes.
//
// Everything else the grant could never do, it still cannot do: it is single-purpose, bound
// to one certificateId AND one eventSlug, carries a server-resolved registrationId the
// browser never supplies, and is NOT accepted in place of `downloadCapability` for ordinary
// certificate downloads.

import { NextRequest, NextResponse } from 'next/server'
import { getCertificate, getTemplateById, getActiveTemplate } from '@/lib/certificates/firestore'
import { isValidCertificateId }      from '@/lib/certificates/id'
import { layoutHasAttendeePhoto }    from '@/lib/certificates/attendeePhotoLayout'
import { createCertificatePhotoGrant, GRANT_TTL_MS } from '@/lib/certificates/photoGrant'
import { getClientIp }               from '@/lib/rateLimit'
import { RATE_POLICY, checkPolicy }  from '@/lib/rateLimit/policies'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ slug: string }> }

/** Unknown, wrong-event and revoked certificates are indistinguishable — no enumeration. */
const INVALID = () =>
  NextResponse.json({ error: 'That certificate is not available.' }, { status: 400 })

export async function POST(req: NextRequest, { params }: Params): Promise<NextResponse> {
  // Same policy the OTP verify step used: minting is now the cheapest step in the flow, so
  // it keeps the rate limit that used to sit on code-checking.
  const rl = checkPolicy(getClientIp(req), RATE_POLICY.certificatePhotoVerify)
  if (rl.limited) {
    return NextResponse.json(
      { error: 'Too many attempts. Please wait a moment and try again.' },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfter) } },
    )
  }

  const { slug } = await params
  let body: { certificateId?: unknown }
  try { body = await req.json() as typeof body }
  catch { return NextResponse.json({ error: 'Invalid request.' }, { status: 400 }) }

  const certificateId = typeof body.certificateId === 'string' ? body.certificateId.trim() : ''
  if (!isValidCertificateId(certificateId)) return INVALID()

  const cert = await getCertificate(certificateId)
  if (!cert || cert.eventSlug !== slug) return INVALID()
  if (cert.status === 'revoked' || cert.revokedAt) return INVALID()

  // Server-derived or nothing. THE anchor of the whole design: a family sharing one mobile
  // and one email is separated here, and only here, by which certificate was selected.
  const registrationId = typeof cert.registrationId === 'string' ? cert.registrationId.trim() : ''
  if (!registrationId) return INVALID()

  // ═══ CAN THIS CERTIFICATE ACTUALLY PRINT A PHOTO? ═══════════════════════════
  //
  // Resolved BEFORE the grant is minted, and read-only: nothing about the grant's security
  // model depends on it, and no grant is written for a request that fails here.
  //
  // Template precedence is deliberately the SAME as renderCertificateOnDemand's — pin to the
  // certificate's own templateId, fall back to the event's active template — so the answer
  // the Center is given describes the template the download will actually render against.
  // The detection itself is the ONE shared predicate; this route does not restate it.
  //
  // A failure reports `false` rather than throwing: hiding the upload is recoverable, while
  // offering one whose bytes could never appear on the PDF is the exact silent no-op this
  // field exists to prevent. The grant is still minted either way, so a transient template
  // read can never break the photo flow for an attendee who reloads.
  let photoSupported = false
  try {
    const template = cert.templateId
      ? (await getTemplateById(cert.templateId)) ?? await getActiveTemplate(cert.eventId, cert.organizerUid)
      : await getActiveTemplate(cert.eventId, cert.organizerUid)
    photoSupported = layoutHasAttendeePhoto(template?.layout)
  } catch { /* stays false — see above */ }

  const grant = await createCertificatePhotoGrant({ certificateId, registrationId, eventSlug: slug })

  return NextResponse.json(
    { grant, expiresInMs: GRANT_TTL_MS, participantName: cert.attendeeName ?? '', photoSupported },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
