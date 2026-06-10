// GET /api/verify/certificate/[certificateId]
//
// Public JSON verification endpoint. No authentication required.
// Called by the /verify/certificate/[certificateId] page.

import { NextRequest, NextResponse }  from 'next/server'
import { getCertificateById }         from '@/lib/certificates/firestore'
import { isValidCertificateId }       from '@/lib/certificates/id'

type Params = { params: Promise<{ certificateId: string }> }

export interface CertificateVerifyResponse {
  valid:          boolean
  certificateId?: string
  attendeeName?:  string
  eventName?:     string
  issueDate?:     string   // ISO string
  eventDate?:     string
  status?:        string
}

function toISO(val: unknown): string | null {
  if (!val) return null
  if (typeof (val as { toDate?: () => Date }).toDate === 'function') {
    return (val as { toDate: () => Date }).toDate().toISOString()
  }
  return null
}

export async function GET(_req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { certificateId } = await params

  if (!isValidCertificateId(certificateId)) {
    return NextResponse.json({ valid: false } satisfies CertificateVerifyResponse)
  }

  const record = await getCertificateById(certificateId)
  if (!record) {
    return NextResponse.json({ valid: false } satisfies CertificateVerifyResponse)
  }

  return NextResponse.json({
    valid:         true,
    certificateId: record.certificateId,
    attendeeName:  record.attendeeName,
    eventName:     record.eventName,
    issueDate:     toISO(record.issuedAt) ?? undefined,
    eventDate:     record.eventDate,
    status:        record.status,
  } satisfies CertificateVerifyResponse)
}
