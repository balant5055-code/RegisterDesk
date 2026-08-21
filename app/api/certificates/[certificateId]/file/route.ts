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
import { signCertificateArtifact }   from '@/lib/certificates/artifact'
import { captureError }              from '@/lib/monitoring/sentry'
import { timingSafeEqualStr }        from '@/lib/security/timingSafe'
import { getClientIp }               from '@/lib/rateLimit'
import { RATE_POLICY, checkPolicy }  from '@/lib/rateLimit/policies'

type Params = { params: Promise<{ certificateId: string }> }

export async function GET(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { certificateId } = await params

  // Throttle on the stored-PDF fetch/stream (same policy as ticket PDFs).
  //
  // RD-CERT-SCALE-01 — keyed on IP **and** the certificate, not IP alone. A whole venue
  // shares one NAT address at a live event, so an IP-only bucket refused legitimate attendees
  // downloading their own certificates. Limit and window are UNCHANGED (60/min): repeatedly
  // pulling the SAME certificate from one address is still throttled exactly as before, while
  // a thousand attendees fetching a thousand different certificates no longer collide.
  //
  // Moved below the params read because the key needs the id. Nothing above it touches
  // Firestore or storage — the throttle still precedes every read and every gate.
  const rl = checkPolicy(`${getClientIp(req)}|${certificateId}`, RATE_POLICY.pdfDownload)
  if (rl.limited) {
    return NextResponse.json(
      { error: 'Too many requests. Please try again shortly.' },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfter) } },
    )
  }

  if (!isValidCertificateId(certificateId)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const cert = await getCertificate(certificateId)
  // RD-CERT-ARTIFACT-01 — a certificate is downloadable if it has EITHER artifact:
  //   • `fileKey`  — the canonical R2 object written by issuance/regeneration (current)
  //   • `fileUrl`  — the legacy Firebase Storage pointer (pre-R2 records)
  // Requiring `fileUrl` alone would 404 every certificate issued after artifact
  // persistence, because that path deliberately writes `fileUrl: null`.
  if (!cert || (!cert.fileUrl && !cert.fileKey)) {
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

  // ═══ RD-CERT-ARTIFACT-01 · THE CANONICAL ARTIFACT, BY REDIRECT ══════════════
  //
  // Placed AFTER every gate above — revocation, organizer ownership, the download
  // settings and the verification token — because a signed URL is a bearer credential.
  // It is minted only once the request has already earned the bytes.
  //
  // `fileKey` WINS over `fileUrl`, and that precedence is a correctness requirement, not
  // a preference. Regeneration writes the new artifact to `fileKey` and deliberately
  // leaves `fileUrl` in place as provenance (see recordCertificateRegeneration), so a
  // regenerated legacy certificate carries BOTH — a current R2 object and a superseded
  // Firebase render, potentially from a different template.
  //
  // For the same reason a signing failure must NOT fall back to `fileUrl`: serving the
  // superseded document would be a wrong certificate returned as success, which is worse
  // than failing. It degrades to the route's existing 502 instead — the same response
  // this endpoint already returns when the stored file cannot be read.
  if (cert.fileKey) {
    try {
      const url = await signCertificateArtifact(cert.fileKey, cert.certificateId)
      // Best-effort tracking — never block the download on a counter write.
      void incrementCertificateDownload(certificateId).catch(() => {})
      // 302, not 307: a GET with no body to preserve, and the target is a one-shot
      // credential rather than a permanent location. `Content-Disposition: attachment`
      // is folded into the signature by signCertificateArtifact, so it cannot be
      // stripped from the URL.
      return NextResponse.redirect(new URL(url), {
        status: 302,
        headers: { 'Cache-Control': 'no-store' },
      })
    } catch (err) {
      captureError(err, { scope: 'certificate_artifact_sign', area: 'certificate', certificateId })
      return NextResponse.json({ error: 'Could not read the certificate file' }, { status: 502 })
    }
  }

  // Only reachable with NO `fileKey` (that branch always returns), and the guard above
  // rejected the neither-artifact case — so `fileUrl` is necessarily set here. Re-checked
  // explicitly rather than asserted with `!`, so that if either branch above is ever
  // edited, this degrades to the existing 404 instead of fetching `null`.
  if (!cert.fileUrl) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
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

  return new NextResponse(Buffer.from(bytes), {
    status: 200,
    headers: {
      'Content-Type':        'application/pdf',
      'Content-Disposition': `inline; filename="certificate-${certificateId}.pdf"`,
      'Cache-Control':       'no-store',
    },
  })
}
