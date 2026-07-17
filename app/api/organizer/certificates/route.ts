// GET /api/organizer/certificates
//
// Returns all certificate records for the authenticated organizer, sorted
// newest-first. Used by the Communications > Certificates dashboard page.

import { NextRequest, NextResponse }        from 'next/server'
import { authorizeWorkspace }               from '@/lib/team/workspace'
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
  const authz = await authorizeWorkspace(req, 'certificates')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  const uid = authz.workspaceUid

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
