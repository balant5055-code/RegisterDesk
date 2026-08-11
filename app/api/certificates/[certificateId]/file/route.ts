// GET /api/certificates/[certificateId]/file
//
// Tracked download for a generated certificate (new `certificates` collection).
// Streams the stored PDF (same-origin) after enforcing the organizer's download
// settings. Increments downloadCount + lastDownloadedAt on a served download.
//
// Access model:
//   - Revoked certificates are always blocked (410), for everyone.
//   - Organizer (valid Bearer token, owner) always downloads — bypasses the
//     attendee-facing settings below. The dashboard uses an authenticated fetch.
//   - Public / attendee (no Bearer) is gated by CertificateSettings.download:
//       enabled:false           → 403 (downloads disabled)
//       allowAttendee:false     → 403 (only the organizer may download)
//       requireVerification:true→ require ?token == the certificate's verificationToken
//   - Absent settings default to { enabled:true, requireVerification:false,
//     allowAttendee:true } so existing behavior is preserved.
//
// Used as the email download link (with ?token) so recipients can download when
// requireVerification is on.

import { NextRequest, NextResponse } from 'next/server'
import { adminAuth }                 from '@/lib/firebase/admin'
import { getCertificate, incrementCertificateDownload, getSettings } from '@/lib/certificates/firestore'
import { defaultCertificateSettings } from '@/lib/certificates/types'
import { looksLikeDownloadCapability, verifyCertificateDownloadCapability } from '@/lib/certificates/downloadCapability'
import { isValidCertificateId }      from '@/lib/certificates/id'
import { safeFetchBytes, validateGeneratedCertificateUrl } from '@/lib/certificates/urlGuard'
import { timingSafeEqualStr }        from '@/lib/security/timingSafe'
import { getClientIp }               from '@/lib/rateLimit'
import { RATE_POLICY, checkPolicy }  from '@/lib/rateLimit/policies'

type Params = { params: Promise<{ certificateId: string }> }

export async function GET(req: NextRequest, { params }: Params): Promise<NextResponse> {
  // Per-IP throttle on the stored-PDF fetch/stream (same policy as ticket PDFs).
  const rl = checkPolicy(getClientIp(req), RATE_POLICY.pdfDownload)
  if (rl.limited) {
    return NextResponse.json(
      { error: 'Too many requests. Please try again shortly.' },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfter) } },
    )
  }

  const { certificateId } = await params

  if (!isValidCertificateId(certificateId)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const cert = await getCertificate(certificateId)
  if (!cert || !cert.fileUrl) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  // Revoked is always blocked — for organizer and attendee alike.
  if (cert.status === 'revoked') {
    return NextResponse.json({ error: 'This certificate has been revoked' }, { status: 410 })
  }

  // Is this an authenticated request from the owning organizer?
  let isOrganizer = false
  const authHeader = req.headers.get('authorization') ?? ''
  if (authHeader.startsWith('Bearer ')) {
    try {
      const uid = (await adminAuth.verifyIdToken(authHeader.slice(7))).uid
      isOrganizer = uid === cert.organizerUid
    } catch { /* ignore — treat as public */ }
  }

  // Attendee-facing gating (organizer bypasses).
  if (!isOrganizer) {
    const download = (await getSettings(cert.eventId))?.download ?? defaultCertificateSettings().download

    if (!download.enabled) {
      return NextResponse.json({ error: 'Downloads are disabled for this certificate.' }, { status: 403 })
    }
    if (!download.allowAttendee) {
      return NextResponse.json({ error: 'Downloads are restricted by the organizer.' }, { status: 403 })
    }
    if (download.requireVerification) {
      const token = req.nextUrl.searchParams.get('token') ?? ''

      // TWO accepted credentials, never a bypass:
      //   • the PERMANENT verificationToken — the emailed link, unchanged below
      //   • a SHORT-LIVED capability minted by the Event Day Certificate Center, which
      //     identifies people by guessable email / registration id and therefore must
      //     never be handed the permanent token
      //
      // The shapes are disjoint (capability = "<expiry>.<64 hex>", permanent = bare
      // 64 hex), so `looksLikeDownloadCapability` routes to exactly one comparison —
      // a capability can never be tried against, or substituted for, the permanent token.
      const viaCapability = looksLikeDownloadCapability(token)
        && verifyCertificateDownloadCapability(cert.certificateId, cert.eventSlug, token)

      const viaPermanent = !!cert.verificationToken && timingSafeEqualStr(token, cert.verificationToken)

      if (!viaCapability && !viaPermanent) {
        return NextResponse.json({ error: 'Verification required to download this certificate.' }, { status: 403 })
      }
    }
  }

  // Fetch the stored PDF (SSRF-guarded) and stream it same-origin.
  let bytes: Uint8Array
  try {
    bytes = await safeFetchBytes(cert.fileUrl, validateGeneratedCertificateUrl(cert.fileUrl))
  } catch {
    return NextResponse.json({ error: 'Could not read the certificate file' }, { status: 502 })
  }

  // Best-effort tracking — never block the download on a counter write.
  void incrementCertificateDownload(certificateId).catch(() => {})

  // `attachment`, not `inline`. Every consumer of this route is a DOWNLOAD: the public
  // Certificate Center button, the attendee dashboard button, and the emailed download
  // link. `inline` made the browser render the PDF in the new tab instead, forcing a second
  // click on the viewer's own download control. Certificate VIEWING is a different route
  // (/verify/certificate/[certificateId]), which renders metadata and never embeds this
  // PDF — so nothing relies on inline rendering. The organizer dashboard reads this route
  // with fetch()+blob, where Content-Disposition has no effect either way.
  //
  // This also brings the route in line with every other file endpoint in the repo,
  // including its two siblings (certificates/[certificateId] and
  // certificates/download/[registrationId]) which already send `attachment` with this
  // exact filename shape.
  //
  // The filename is injection-safe by construction: isValidCertificateId() has already
  // rejected anything but /^RDC-\d{4}-[A-Z0-9]{6}$/, so no quote or CRLF can reach the header.
  return new NextResponse(Buffer.from(bytes), {
    status: 200,
    headers: {
      'Content-Type':        'application/pdf',
      'Content-Disposition': `attachment; filename="certificate-${certificateId}.pdf"`,
      'Cache-Control':       'no-store',
    },
  })
}
