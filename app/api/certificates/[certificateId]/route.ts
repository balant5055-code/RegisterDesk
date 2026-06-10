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
  incrementDownloadCount,
}                                       from '@/lib/certificates/firestore'
import { generateCertificatePdf }       from '@/lib/certificates/pdf'
import { isValidCertificateId }         from '@/lib/certificates/id'

type Params = { params: Promise<{ certificateId: string }> }

const APP_URL = (process.env.NEXT_PUBLIC_APP_URL ?? 'https://registerdesk.in').replace(/\/$/, '')

export async function GET(req: NextRequest, { params }: Params): Promise<NextResponse> {
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

  // Optional: if Bearer token provided, verify organizer ownership — but not required.
  // The certificateId IS the capability token for attendee access.
  const bearerToken = (req.headers.get('authorization') ?? '').replace(/^Bearer /, '')
  if (bearerToken) {
    try {
      const decoded = await adminAuth.verifyIdToken(bearerToken)
      // If signed in, user must be the organizer or the registration owner
      const uid = decoded.uid
      if (uid !== record.organizerUid) {
        // Allow if they're the attendee — no per-attendee uid stored on record, so just allow
        // as long as they have a valid Firebase token (they're logged in)
      }
    } catch {
      // Invalid token — proceed with certificateId capability model anyway
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
