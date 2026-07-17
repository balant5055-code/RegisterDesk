// POST /api/organizer/events/[eventId]/certificates/email
//
// Sends or resends a single certificate by email. Body:
//   { certificateId: string, resend?: boolean }
//
// `resend: true` forces a re-send even if already delivered. Idempotent: this
// never regenerates the certificate — it only emails the existing one.
//
// Security: auth + the certificate must belong to the caller and this event.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeWorkspace }        from '@/lib/team/workspace'
import { getCertificate }            from '@/lib/certificates/firestore'
import { emailCertificate }          from '@/lib/certificates/email'

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
  const resend = (body as Record<string, unknown>)?.resend === true

  const certificate = await getCertificate(certificateId)
  if (!certificate || certificate.organizerUid !== auth.uid || certificate.eventId !== eventId) {
    return NextResponse.json({ error: 'Certificate not found' }, { status: 404 })
  }

  const result = await emailCertificate(certificate, { force: resend })

  if (!result.success && !result.skipped) {
    return NextResponse.json({ success: false, error: result.error ?? 'Email failed' }, { status: 502 })
  }
  return NextResponse.json({ success: true, skipped: result.skipped, messageId: result.messageId })
}
