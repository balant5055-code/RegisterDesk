// GET /api/certificates/[certificateId]
//
// Downloads the PDF certificate identified by certificateId.
//
// Authorization:
//   The certificateId is itself a capability token (unguessable, RDC-YYYY-XXXXXX).
//   Knowing the certificateId grants download access — same model as ticket PDF.
//   Organizer access additionally allowed via Bearer token.
//
// Increments downloadCount on each successful response.

import { NextRequest, NextResponse }    from 'next/server'
import { adminAuth }                    from '@/lib/firebase/admin'
import {
  getCertificateById,
  getTemplate,
  getSettings,
  incrementDownloadCount,
}                                       from '@/lib/certificates/firestore'
import { defaultCertificateSettings }   from '@/lib/certificates/types'
import { generateCertificatePdf }       from '@/lib/certificates/pdf'
import { isValidCertificateId }         from '@/lib/certificates/id'
import { timingSafeEqualStr }           from '@/lib/security/timingSafe'
import { getClientIp }                  from '@/lib/rateLimit'
import { RATE_POLICY, checkPolicy }     from '@/lib/rateLimit/policies'

type Params = { params: Promise<{ certificateId: string }> }

const APP_URL = (process.env.NEXT_PUBLIC_APP_URL ?? 'https://registerdesk.in').replace(/\/$/, '')

export async function GET(req: NextRequest, { params }: Params): Promise<NextResponse> {
  // On-the-fly PDF generation — per-IP throttle (same policy as ticket/receipt PDFs).
  const rl = checkPolicy(getClientIp(req), RATE_POLICY.pdfDownload)
  if (rl.limited) {
    return NextResponse.json(
      { error: 'Too many requests. Please try again shortly.' },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfter) } },
    )
  }

  const { certificateId } = await params

  // Basic format check
  if (!isValidCertificateId(certificateId)) {
    return NextResponse.json({ error: 'Invalid certificate ID' }, { status: 400 })
  }

  // Load certificate record
  const record = await getCertificateById(certificateId)
  if (!record) {
    return NextResponse.json({ error: 'Certificate not found' }, { status: 404 })
  }

  // Revoked certificates are never downloadable (defensive; legacy records carry
  // a status field even though legacy revoke is V1.1).
  if ((record as { status?: string }).status === 'revoked') {
    return NextResponse.json({ error: 'This certificate has been revoked' }, { status: 410 })
  }

  // The owning organizer (valid Bearer) bypasses the attendee-facing settings.
  let isOrganizer = false
  const authHeader = req.headers.get('authorization') ?? ''
  if (authHeader.startsWith('Bearer ')) {
    try {
      const uid = (await adminAuth.verifyIdToken(authHeader.slice(7))).uid
      isOrganizer = uid === record.organizerUid
    } catch { /* ignore — treat as public/attendee */ }
  }

  // P7.1: honor the organizer's download settings for non-organizer requests.
  // The certificateId is a capability token, but enabled/allowAttendee/
  // requireVerification must still gate access — no bypass.
  if (!isOrganizer) {
    const download = (await getSettings(record.eventId))?.download ?? defaultCertificateSettings().download
    if (!download.enabled) {
      return NextResponse.json({ error: 'Downloads are disabled for this certificate.' }, { status: 403 })
    }
    if (!download.allowAttendee) {
      return NextResponse.json({ error: 'Downloads are restricted by the organizer.' }, { status: 403 })
    }
    if (download.requireVerification) {
      const token    = req.nextUrl.searchParams.get('token') ?? ''
      const recToken = (record as { verificationToken?: string | null }).verificationToken ?? null
      if (!recToken || !timingSafeEqualStr(token, recToken)) {
        return NextResponse.json({ error: 'Verification required to download this certificate.' }, { status: 403 })
      }
    }
  }

  // Load template for design
  const template = await getTemplate(record.eventId)
  if (!template) {
    return NextResponse.json({ error: 'Certificate template not found' }, { status: 404 })
  }

  // Generate PDF
  const verifyUrl = `${APP_URL}/verify/certificate/${certificateId}`
  const issueDate = typeof (record.issuedAt as { toDate?: () => Date }).toDate === 'function'
    ? (record.issuedAt as { toDate: () => Date }).toDate().toLocaleDateString('en-IN', {
        day: 'numeric', month: 'long', year: 'numeric',
      })
    : new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })

  let pdfBytes: Uint8Array
  try {
    pdfBytes = await generateCertificatePdf(template, record, verifyUrl, issueDate)
  } catch (e) {
    console.error('[certificates/pdf]', e)
    return NextResponse.json({ error: 'PDF generation failed' }, { status: 500 })
  }

  // Increment download count — fire-and-forget
  void incrementDownloadCount(certificateId).catch(() => {})

  const filename = `certificate-${record.certificateId}.pdf`
  return new NextResponse(Buffer.from(pdfBytes), {
    status: 200,
    headers: {
      'Content-Type':        'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control':       'no-store',
    },
  })
}
