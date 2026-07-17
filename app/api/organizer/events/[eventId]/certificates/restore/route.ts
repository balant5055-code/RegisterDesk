// POST /api/organizer/events/[eventId]/certificates/restore
//
// Restores a previously revoked certificate. Body: { certificateId }.
// Clears the revoked status (back to emailed/generated), preserves the
// append-only revocationHistory, and does NOT regenerate the certificate.
//
// Security: auth + the certificate must belong to the caller and this event
// (re-checked inside the transaction).

import { NextRequest, NextResponse } from 'next/server'
import { authorizeWorkspace }        from '@/lib/team/workspace'
import { restoreCertificate, CertificateServiceError } from '@/lib/certificates/firestore'
import { serializeCertificate }      from '@/lib/certificates/types'

type Params = { params: Promise<{ eventId: string }> }

async function authUid(req: NextRequest): Promise<{ uid: string } | { error: NextResponse }> {
  const authz = await authorizeWorkspace(req, 'certificates')
  if (!authz.ok) return { error: NextResponse.json({ error: authz.error }, { status: authz.status }) }
  return { uid: authz.workspaceUid }
}

export async function POST(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { eventId } = await params
  const auth = await authUid(req)
  if ('error' in auth) return auth.error

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const certificateId = typeof (body as Record<string, unknown>)?.certificateId === 'string'
    ? (body as { certificateId: string }).certificateId
    : ''
  if (!certificateId) return NextResponse.json({ error: 'certificateId is required' }, { status: 400 })

  try {
    const certificate = await restoreCertificate(eventId, certificateId, auth.uid)
    return NextResponse.json({ success: true, certificate: serializeCertificate(certificate) })
  } catch (err) {
    if (err instanceof CertificateServiceError) {
      const status = err.code === 'not_found' ? 404 : err.code === 'forbidden' ? 403 : 409
      return NextResponse.json({ error: err.message }, { status })
    }
    throw err
  }
}
