// POST /api/organizer/events/[eventId]/certificates/revoke
//
// Revokes a certificate. Body: { certificateId, reason, customReason? }.
// `reason` must be a supported RevocationReason; `customReason` is required when
// reason is "other". Appends to the certificate's append-only revocationHistory.
//
// Security: auth + the certificate must belong to the caller and this event
// (re-checked inside the transaction).

import { NextRequest, NextResponse } from 'next/server'
import { authorizeWorkspace }        from '@/lib/team/workspace'
import { revokeCertificate, CertificateServiceError } from '@/lib/certificates/firestore'
import { validateRevoke }            from '@/lib/certificates/validation'
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

  const parsed = validateRevoke(body)
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })

  try {
    const certificate = await revokeCertificate(
      eventId, certificateId, auth.uid, parsed.value.reason, parsed.value.customReason,
    )
    return NextResponse.json({ success: true, certificate: serializeCertificate(certificate) })
  } catch (err) {
    if (err instanceof CertificateServiceError) {
      const status = err.code === 'not_found' ? 404 : err.code === 'forbidden' ? 403 : 409
      return NextResponse.json({ error: err.message }, { status })
    }
    throw err
  }
}
