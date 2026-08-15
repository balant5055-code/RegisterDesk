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
import type { EmailClaimIntent }     from '@/lib/certificates/firestore'
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

  // RD-CERT-EMAIL-BULK — `resend_after_review` is the ONLY way to send a certificate whose
  // previous delivery outcome is unknown, and it is deliberately a separate value from an
  // ordinary resend: the operator is accepting a duplicate risk, so the UI must ask for it
  // explicitly rather than let a generic Resend button take it. It still acquires the same
  // transactional claim — this is not a bypass.
  const rawIntent = (body as Record<string, unknown>)?.intent
  const intent: EmailClaimIntent | undefined =
    rawIntent === 'resend_after_review' ? 'resend_after_review'
      : rawIntent === 'resend'       ? 'resend'
      : rawIntent === 'retry_failed' ? 'retry_failed'
      : rawIntent === 'send'         ? 'send'
      : undefined

  const certificate = await getCertificate(certificateId)
  if (!certificate || certificate.organizerUid !== auth.uid || certificate.eventId !== eventId) {
    return NextResponse.json({ error: 'Certificate not found' }, { status: 404 })
  }

  // emailCertificate is contracted never to throw, but a bare 500 tells the operator
  // nothing and leaves no history row — so the contract is enforced HERE as well. An
  // unexpected throw becomes a safe, actionable message rather than 'Request failed (500)'.
  let result
  try {
    result = await emailCertificate(certificate, { force: resend, ...(intent ? { intent } : {}) })
  } catch (err) {
    console.error('[certificate-email] unexpected_failure', {
      certificateId, eventId, name: err instanceof Error ? err.name : 'unknown',
    })
    return NextResponse.json(
      { success: false, error: 'The certificate email could not be sent. Please check the email configuration and try again.' },
      { status: 502 },
    )
  }

  // A provider/config failure is an upstream problem, not a server bug — 502, with the
  // reason the service already produced, so the UI can show something useful.
  if (!result.success && !result.skipped) {
    return NextResponse.json({ success: false, error: result.error ?? 'Email failed' }, { status: 502 })
  }
  return NextResponse.json({ success: true, skipped: result.skipped, messageId: result.messageId })
}
