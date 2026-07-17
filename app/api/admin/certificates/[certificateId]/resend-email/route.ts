// POST /api/admin/certificates/[certificateId]/resend-email
//
// GA-7E S1 — admin SUPPORT resend of a certificate email. Reuses the existing
// emailCertificate service (force:true to bypass the already-sent idempotency guard).
// Admin-gated + audited. No new mail engine.

import { NextRequest, NextResponse } from 'next/server'
import { resolveAdminUid } from '@/lib/admin/auth'
import { getCertificate } from '@/lib/certificates/firestore'
import { emailCertificate } from '@/lib/certificates/email'
import { logAdminAction } from '@/lib/admin/audit'

export async function POST(
  req:     NextRequest,
  context: { params: Promise<{ certificateId: string }> },
): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { certificateId } = await context.params
  const cert = await getCertificate(certificateId)
  if (!cert) return NextResponse.json({ error: 'Certificate not found' }, { status: 404 })
  if ((cert as { status?: string }).status === 'revoked') {
    return NextResponse.json({ error: 'Cannot resend a revoked certificate.' }, { status: 422 })
  }

  const r = await emailCertificate(cert, { force: true })
  if (!r.success) return NextResponse.json({ error: r.error ?? 'Email delivery failed.' }, { status: 502 })

  void logAdminAction({ adminUid, action: 'support.certificate_resent', entityType: 'certificate', entityId: certificateId })
  return NextResponse.json({ success: true })
}
