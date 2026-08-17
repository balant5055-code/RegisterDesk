// GET /api/certificates/[certificateId]/file/personalized
//
// RD-CERT-PHOTO-02 — the SAME certificate, rendered with the attendee's own photo.
//
// ═══ WHY THIS IS A SIBLING AND NOT A BRANCH IN /file ═════════════════════════
// `/file` is the emailed download link, the organizer dashboard's download, and the path
// the ZIP/backfill jobs rely on. It streams the STORED ARTIFACT and must keep doing exactly
// that, byte-for-byte, for every caller that has ever used it. Personalization is a
// different product behaviour — a render that is never stored — so it gets its own URL and
// leaves the artifact endpoint untouched.
//
// ═══ THIS IS NOT A WEAKER DOOR ═══════════════════════════════════════════════
// Every gate `/file` applies is applied here, in the same order, from the same helpers:
// per-IP throttle → id validation → certificate exists AND has an artifact → revoked is
// blocked for everyone → organizer bypass by Bearer → the organizer's download settings
// (enabled / allowAttendee / requireVerification, the latter satisfied by EITHER the
// short-lived Certificate Center capability OR the permanent emailed token, compared the
// same disjoint way).
//
// A certificate photo GRANT is deliberately NOT accepted here. A grant is the WRITE
// credential for a photo and is minted straight after a public lookup; it is not, and must
// not become, a way to download a PDF (see photo/session/route.ts). The only credentials
// this route knows are the ones `/file` already honours.
//
// ═══ NOTHING IS PERSISTED ════════════════════════════════════════════════════
// `renderCertificateOnDemand` uploads nothing and writes no certificate field. The stored
// artifact, the `data` snapshot, the issuance timestamp and the verification token are all
// untouched — two people downloading the same certificate id, one with a photo and one
// without, get two different files and the SAME issued certificate.

import { NextRequest, NextResponse } from 'next/server'
import { adminAuth }                 from '@/lib/firebase/admin'
import { getCertificate, incrementCertificateDownload, getSettings } from '@/lib/certificates/firestore'
import { defaultCertificateSettings } from '@/lib/certificates/types'
import { looksLikeDownloadCapability, verifyCertificateDownloadCapability } from '@/lib/certificates/downloadCapability'
import { isValidCertificateId }      from '@/lib/certificates/id'
import { renderCertificateOnDemand } from '@/lib/certificates/generate'
import { captureError }              from '@/lib/monitoring/sentry'
import { timingSafeEqualStr }        from '@/lib/security/timingSafe'
import { getClientIp }               from '@/lib/rateLimit'
import { RATE_POLICY, checkPolicy }  from '@/lib/rateLimit/policies'

type Params = { params: Promise<{ certificateId: string }> }

/**
 * Hands the request back to the canonical artifact endpoint, query string intact.
 *
 * Used whenever there is no photo to apply, or the personalized render could not be
 * produced. Redirecting rather than re-implementing `/file`'s artifact branch is the point:
 * there is exactly ONE implementation of "serve the stored certificate", so the fallback
 * can never drift from it — including the `fileKey`-wins-over-`fileUrl` precedence, the
 * signed-URL redirect and the legacy Firebase streaming path. `/file` re-applies its own
 * gates on arrival, so this hop grants nothing that endpoint would not have granted.
 */
function toStoredArtifact(req: NextRequest, certificateId: string): NextResponse {
  const url = new URL(`/api/certificates/${encodeURIComponent(certificateId)}/file`, req.nextUrl.origin)
  url.search = req.nextUrl.search
  return NextResponse.redirect(url, { status: 302, headers: { 'Cache-Control': 'no-store' } })
}

export async function GET(req: NextRequest, { params }: Params): Promise<NextResponse> {
  // Same per-IP throttle as the stored-PDF endpoint. Rendering costs more than streaming, so
  // this route must never be the cheaper way to ask for the same bytes.
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
  // Identical existence rule to `/file`: EITHER artifact makes a certificate downloadable.
  // Kept even though a personalized render does not read the artifact, so this route can
  // never surface a certificate that `/file` would 404 — it is a second door to the same
  // room, not a wider one.
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

  // Attendee-facing gating (organizer bypasses) — the same three settings, read from the
  // same document, with the same defaults as `/file`.
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

      // The shapes are disjoint (capability = "<expiry>.<64 hex>", permanent = bare 64 hex),
      // so exactly one comparison runs — a capability can never be tried against, or
      // substituted for, the permanent token.
      const viaCapability = looksLikeDownloadCapability(token)
        && verifyCertificateDownloadCapability(cert.certificateId, cert.eventSlug, token)

      const viaPermanent = !!cert.verificationToken && timingSafeEqualStr(token, cert.verificationToken)

      if (!viaCapability && !viaPermanent) {
        return NextResponse.json({ error: 'Verification required to download this certificate.' }, { status: 403 })
      }
    }
  }

  // ═══ NOTHING TO PERSONALIZE ═════════════════════════════════════════════════
  // No photo on this certificate — the attendee still gets their certificate. This is the
  // path a stale client takes (it believed a photo existed, or the photo was removed after
  // the page loaded), so it must be ordinary, not an error.
  if (!cert.attendeePhotoKey) return toStoredArtifact(req, certificateId)

  // The key comes from the certificate record loaded above — NEVER from the request. A
  // caller cannot name the bytes that get embedded, only the certificate they have already
  // proved they may download.
  const rendered = await renderCertificateOnDemand(certificateId, {
    attendeePhotoKeyOverride: cert.attendeePhotoKey,
  })

  if (!rendered.ok) {
    // A missing/stripped template or a render failure must not deny the attendee the
    // certificate they are entitled to — degrade to the stored artifact, which is exactly
    // what they would have received before this route existed.
    captureError(new Error(`personalized_render_failed:${rendered.error}`), {
      scope: 'certificate_personalized_download', area: 'certificate', certificateId,
    })
    return toStoredArtifact(req, certificateId)
  }

  // Best-effort tracking — never block the download on a counter write. Counted once, here,
  // because the render path does not pass through `/file`.
  void incrementCertificateDownload(certificateId).catch(() => {})

  return new NextResponse(Buffer.from(rendered.bytes), {
    status: 200,
    headers: {
      'Content-Type':        'application/pdf',
      'Content-Disposition': `inline; filename="${rendered.filename}"`,
      'Cache-Control':       'no-store',
    },
  })
}
