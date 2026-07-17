// POST /api/admin/registrations/[registrationId]/resend-email
//
// GA-7E S1 — admin SUPPORT resend of a registration's ticket email, on the attendee's
// behalf. Reuses the shared resendRegistrationTicketEmail service (same guards + send
// path as the organizer route) — no duplicate mail engine. Admin-gated + audited; no
// ownership check (admin acts cross-tenant by design).

import { NextRequest, NextResponse } from 'next/server'
import { resolveAdminUid } from '@/lib/admin/auth'
import { resendRegistrationTicketEmail } from '@/lib/registrations/resendTicketEmail'
import { logAdminAction } from '@/lib/admin/audit'

export async function POST(
  req:     NextRequest,
  context: { params: Promise<{ registrationId: string }> },
): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { registrationId } = await context.params
  const result = await resendRegistrationTicketEmail(registrationId)
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })

  void logAdminAction({ adminUid, action: 'support.ticket_resent', entityType: 'registration', entityId: registrationId })
  return NextResponse.json({ success: true })
}
