// GET /api/organizer/certificates
//
// Returns all certificate records for the authenticated organizer, sorted
// newest-first. Used by the Communications > Certificates dashboard page.

import { NextRequest, NextResponse }        from 'next/server'
import { adminAuth }                        from '@/lib/firebase/admin'
import { getCertificatesByOrganizerUid }    from '@/lib/certificates/firestore'
import type { SerializedCertificateRecord } from '@/lib/certificates/types'

export interface OrganizerCertificatesResponse {
  certificates: SerializedCertificateRecord[]
  total:        number
}

function toISO(val: unknown): string | null {
  if (!val) return null
  if (typeof (val as { toDate?: () => Date }).toDate === 'function') {
    return (val as { toDate: () => Date }).toDate().toISOString()
  }
  return null
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const token = (req.headers.get('authorization') ?? '').replace(/^Bearer /, '')
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let uid: string
  try {
    uid = (await adminAuth.verifyIdToken(token)).uid
  } catch {
    return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
  }

  const records = await getCertificatesByOrganizerUid(uid, 100)

  const serialized: SerializedCertificateRecord[] = records
    .sort((a, b) => (toISO(b.issuedAt) ?? '').localeCompare(toISO(a.issuedAt) ?? ''))
    .map(r => ({
      ...r,
      issuedAt:  toISO(r.issuedAt)  ?? new Date().toISOString(),
      emailedAt: toISO(r.emailedAt) ?? null,
    }))

  return NextResponse.json({
    certificates: serialized,
    total:        serialized.length,
  } satisfies OrganizerCertificatesResponse)
}
