// POST /api/organizer/registrations/[registrationId]/approve
//
// Approves a pending registration:
//   - status → confirmed
//   - registrationCounters incremented
//   - confirmation email sent to attendee

import { NextRequest, NextResponse }  from 'next/server'
import { authorizeWorkspace }           from '@/lib/team/workspace'
import {
  approveRegistration,
  writeAuditEntry,
  RegistrationNotFoundError,
  NotPendingError,
  UnauthorizedCancellationError,
  CapacityBlocksApprovalError,
} from '@/lib/firebase/firestore/registrations'
import { sendApprovalEmail }          from '@/lib/registrations/sendApprovalEmail'

export interface ApproveRegistrationResponse {
  success: boolean
  error?:  string
}

export async function POST(
  req:     NextRequest,
  context: { params: Promise<{ registrationId: string }> },
): Promise<NextResponse<ApproveRegistrationResponse>> {
  // ── 1. Auth ────────────────────────────────────────────────────────────────
  const authz = await authorizeWorkspace(req, 'registrations')
  if (!authz.ok) return NextResponse.json({ success: false, error: authz.error }, { status: authz.status })
  const uid = authz.workspaceUid
  const callerUid = authz.callerUid

  const { registrationId } = await context.params
  if (!registrationId) {
    return NextResponse.json({ success: false, error: 'registrationId is required' }, { status: 400 })
  }

  // ── 2. Approve atomically ──────────────────────────────────────────────────
  try {
    await approveRegistration(registrationId, uid)
  } catch (err) {
    if (err instanceof RegistrationNotFoundError) {
      return NextResponse.json({ success: false, error: 'Registration not found' }, { status: 404 })
    }
    if (err instanceof NotPendingError) {
      return NextResponse.json({ success: false, error: 'Registration is not pending approval' }, { status: 409 })
    }
    if (err instanceof CapacityBlocksApprovalError) {
      const msg = err.reason === 'EVENT_CAPACITY_FULL'
        ? 'Event is at full capacity — cannot approve.'
        : 'This pass is at full capacity — cannot approve.'
      return NextResponse.json({ success: false, error: msg }, { status: 409 })
    }
    if (err instanceof UnauthorizedCancellationError) {
      return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
    }
    console.error('[approve] Unexpected error:', { registrationId, err })
    return NextResponse.json({ success: false, error: 'Failed to approve registration' }, { status: 500 })
  }

  // ── 3. Audit entry (fire-and-forget) ──────────────────────────────────────
  writeAuditEntry(registrationId, 'approved', callerUid, 'organizer', uid).catch(err =>
    console.error('[approve] Failed to write audit entry:', err),
  )

  // ── 4. Send confirmation email (fire-and-forget) ───────────────────────────
  sendApprovalEmail(registrationId).catch(err =>
    console.error('[approve] Failed to send confirmation email:', err),
  )

  return NextResponse.json({ success: true })
}
