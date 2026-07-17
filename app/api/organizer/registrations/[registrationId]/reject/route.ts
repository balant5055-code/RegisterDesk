// POST /api/organizer/registrations/[registrationId]/reject
//
// Rejects a pending registration:
//   - status → rejected
//   - counter NOT touched (pending was never counted)
//   - No automatic refund (handled separately if payment was involved)

import { NextRequest, NextResponse }  from 'next/server'
import { authorizeWorkspace }          from '@/lib/team/workspace'
import {
  rejectRegistration,
  writeAuditEntry,
  RegistrationNotFoundError,
  NotPendingError,
  AlreadyRejectedError,
  UnauthorizedCancellationError,
} from '@/lib/firebase/firestore/registrations'
import { sendRejectionEmail }          from '@/lib/registrations/sendRejectionEmail'

export interface RejectRegistrationResponse {
  success: boolean
  error?:  string
}

export async function POST(
  req:     NextRequest,
  context: { params: Promise<{ registrationId: string }> },
): Promise<NextResponse<RejectRegistrationResponse>> {
  // ── 1. Auth ────────────────────────────────────────────────────────────────
  const authz = await authorizeWorkspace(req, 'registrations')
  if (!authz.ok) return NextResponse.json({ success: false, error: authz.error }, { status: authz.status })
  const uid = authz.workspaceUid
  const callerUid = authz.callerUid

  const { registrationId } = await context.params
  if (!registrationId) {
    return NextResponse.json({ success: false, error: 'registrationId is required' }, { status: 400 })
  }

  // ── 1b. Parse optional reason ─────────────────────────────────────────────
  let reason: string | undefined
  try {
    const body = await req.json().catch(() => null) as { reason?: unknown } | null
    if (typeof body?.reason === 'string' && body.reason.trim()) {
      reason = body.reason.trim()
    }
  } catch { /* no body — fine */ }

  // ── 2. Reject atomically ───────────────────────────────────────────────────
  try {
    await rejectRegistration(registrationId, uid)
  } catch (err) {
    if (err instanceof RegistrationNotFoundError) {
      return NextResponse.json({ success: false, error: 'Registration not found' }, { status: 404 })
    }
    if (err instanceof NotPendingError) {
      return NextResponse.json({ success: false, error: 'Only pending registrations can be rejected' }, { status: 409 })
    }
    if (err instanceof AlreadyRejectedError) {
      return NextResponse.json({ success: false, error: 'Registration is already rejected' }, { status: 409 })
    }
    if (err instanceof UnauthorizedCancellationError) {
      return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
    }
    console.error('[reject] Unexpected error:', { registrationId, err })
    return NextResponse.json({ success: false, error: 'Failed to reject registration' }, { status: 500 })
  }

  // ── 3. Audit entry (fire-and-forget) ──────────────────────────────────────
  writeAuditEntry(registrationId, 'rejected', callerUid, 'organizer', uid).catch(err =>
    console.error('[reject] Failed to write audit entry:', err),
  )

  // ── 4. Rejection email (fire-and-forget) ──────────────────────────────────
  sendRejectionEmail(registrationId, reason).catch(err =>
    console.error('[reject] Failed to send rejection email:', err),
  )

  return NextResponse.json({ success: true })
}
