// POST /api/organizer/registrations/[registrationId]/restore
//
// Restores a cancelled registration.
// Atomically: verifies capacity, sets status → confirmed, increments counter.
// Writes an audit entry fire-and-forget after the transaction.
//
// Blocked if:
//   - registration is not cancelled
//   - event or pass capacity is already full

import { NextRequest, NextResponse }  from 'next/server'
import { authorizeWorkspace }          from '@/lib/team/workspace'
import {
  restoreRegistration,
  writeAuditEntry,
  RegistrationNotFoundError,
  NotCancelledError,
  UnauthorizedCancellationError,
  CapacityBlocksRestoreError,
} from '@/lib/firebase/firestore/registrations'
import { SessionError } from '@/lib/sessions/types'

export interface RestoreRegistrationResponse {
  success: boolean
  error?:  string
}

export async function POST(
  req:     NextRequest,
  context: { params: Promise<{ registrationId: string }> },
): Promise<NextResponse<RestoreRegistrationResponse>> {
  // ── 1. Auth ────────────────────────────────────────────────────────────────
  const authz = await authorizeWorkspace(req, 'registrations')
  if (!authz.ok) return NextResponse.json({ success: false, error: authz.error }, { status: authz.status })
  const uid = authz.workspaceUid
  const callerUid = authz.callerUid

  const { registrationId } = await context.params
  if (!registrationId) {
    return NextResponse.json({ success: false, error: 'registrationId is required' }, { status: 400 })
  }

  // ── 2. Restore atomically ──────────────────────────────────────────────────
  try {
    await restoreRegistration(registrationId, uid)
  } catch (err) {
    if (err instanceof RegistrationNotFoundError) {
      return NextResponse.json({ success: false, error: 'Registration not found' }, { status: 404 })
    }
    if (err instanceof NotCancelledError) {
      return NextResponse.json({ success: false, error: 'Registration is not cancelled' }, { status: 409 })
    }
    if (err instanceof UnauthorizedCancellationError) {
      return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
    }
    if (err instanceof CapacityBlocksRestoreError) {
      const msg = err.reason === 'PASS_CAPACITY_FULL'
        ? 'Cannot restore — this pass is sold out.'
        : 'Cannot restore — the event is at full capacity.'
      return NextResponse.json({ success: false, error: msg }, { status: 422 })
    }
    if (err instanceof SessionError && err.code === 'SESSION_FULL') {
      return NextResponse.json({ success: false, error: `Cannot restore — a selected session is now full${err.detail ? ` (${err.detail})` : ''}.` }, { status: 422 })
    }
    console.error('[restore] Unexpected error:', { registrationId, err })
    return NextResponse.json({ success: false, error: 'Failed to restore registration' }, { status: 500 })
  }

  // ── 3. Audit entry (fire-and-forget) ──────────────────────────────────────
  writeAuditEntry(registrationId, 'restored', callerUid, 'organizer', uid).catch(err =>
    console.error('[restore] Failed to write audit entry:', err),
  )

  return NextResponse.json({ success: true })
}
