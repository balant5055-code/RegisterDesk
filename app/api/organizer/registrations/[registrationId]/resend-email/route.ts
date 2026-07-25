// POST /api/organizer/registrations/[registrationId]/resend-email
//
// Resends the ticket email for a specific registration.
// Organizer-only: the authenticated user must own the event
// (verified via reg.organizerUid === uid).
//
// GA-7E S1: the send logic now lives in the shared resendRegistrationTicketEmail
// service (reused by the admin support route). This route keeps auth + ownership + audit.

import { NextRequest, NextResponse }  from 'next/server'
import { authorizeWorkspace }          from '@/lib/team/workspace'
import { writeAuditEntry, loadOwnedRegistration } from '@/lib/firebase/firestore/registrations'
import { resendRegistrationTicketEmail } from '@/lib/registrations/resendTicketEmail'

export interface ResendEmailResponse {
  success: boolean
  error?:  string
}

export async function POST(
  req:     NextRequest,
  context: { params: Promise<{ registrationId: string }> },
): Promise<NextResponse<ResendEmailResponse>> {
  // ── 1. Auth ────────────────────────────────────────────────────────────────
  const authz = await authorizeWorkspace(req, 'registrations')
  if (!authz.ok) return NextResponse.json({ success: false, error: authz.error }, { status: authz.status })
  const uid = authz.workspaceUid
  const callerUid = authz.callerUid

  const { registrationId } = await context.params

  // ── 2. Ownership (canonical resolver, M7) ───────────────────────────────────
  const owned = await loadOwnedRegistration(registrationId, uid)
  if (!owned.ok) return NextResponse.json({ success: false, error: owned.error }, { status: owned.status })

  // ── 3. Send (shared service: guards + engine + persist) ─────────────────────
  const result = await resendRegistrationTicketEmail(registrationId)
  if (!result.ok) {
    return NextResponse.json({ success: false, error: result.error }, { status: result.status })
  }

  writeAuditEntry(registrationId, 'email_resent', callerUid, 'organizer', uid).catch(err =>
    console.error(`[email] Failed to write audit entry for ${registrationId}:`, err),
  )
  return NextResponse.json({ success: true })
}
