// POST /api/organizer/registrations/[registrationId]/cancel
//
// Cancels a registration by URL-param registrationId.
// Atomically: status → cancelled, counter decremented, claim docs cleaned up.
// Writes an audit entry fire-and-forget after the transaction.

import { NextRequest, NextResponse }  from 'next/server'
import { authorizeWorkspace }          from '@/lib/team/workspace'
import {
  cancelRegistration,
  writeAuditEntry,
  AlreadyCancelledError,
  RegistrationNotFoundError,
  UnauthorizedCancellationError,
} from '@/lib/firebase/firestore/registrations'
import { sendCancellationEmail }       from '@/lib/registrations/sendCancellationEmail'
import { enqueueWebhook }              from '@/lib/integrations/webhooks'
import { releaseIdentifier }           from '@/lib/identifiers/engine'
// RD-BIB-TIMING-01 · the device is surrendered with the number, and goes first.
import { detachTimingTagByRegistration } from '@/lib/identifiers/timingTagEngine'

export interface CancelRegistrationResponse {
  success: boolean
  error?:  string
}

export async function POST(
  req:     NextRequest,
  context: { params: Promise<{ registrationId: string }> },
): Promise<NextResponse<CancelRegistrationResponse>> {
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

  // ── 2. Cancel atomically ───────────────────────────────────────────────────
  try {
    await cancelRegistration(registrationId, uid)
  } catch (err) {
    if (err instanceof RegistrationNotFoundError) {
      return NextResponse.json({ success: false, error: 'Registration not found' }, { status: 404 })
    }
    if (err instanceof AlreadyCancelledError) {
      return NextResponse.json({ success: false, error: 'Registration is already cancelled' }, { status: 409 })
    }
    if (err instanceof UnauthorizedCancellationError) {
      return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
    }
    console.error('[cancel] Unexpected error:', { registrationId, err })
    return NextResponse.json({ success: false, error: 'Failed to cancel registration' }, { status: 500 })
  }

  // ── 3. Audit entry (fire-and-forget) ──────────────────────────────────────
  writeAuditEntry(registrationId, 'cancelled', callerUid, 'organizer', uid).catch(err =>
    console.error('[cancel] Failed to write audit entry:', err),
  )

  // ── 3b. Release any held identifier (fire-and-forget, idempotent no-op when
  //        none). Returns the number to the pool per the event's reuse policy. ──
  // RD-BIB-TIMING-01 · a cancelled participant surrenders BOTH credentials, and the
  // device goes first. The identifier engine now refuses to release a number while a
  // timing device depends on it; a cancellation is the one case where the number
  // must go anyway, so the device is detached and `allowWhileTagged` is passed
  // explicitly rather than the guard being weakened for everybody.
  //
  // Either ordering is safe: if the detach fails, the release is refused and the
  // participant keeps a valid number+device pair; if the release fails, they keep a
  // number with no device, which is also valid.
  void detachTimingTagByRegistration(registrationId, callerUid, 'cancelled')
    .catch(err => console.error('[cancel] Failed to remove timing tag:', err))
    .then(() => releaseIdentifier(registrationId, callerUid, 'cancelled', { allowWhileTagged: true }))
    .catch(err => console.error('[cancel] Failed to release identifier:', err))

  // ── 4. Cancellation email (fire-and-forget) ────────────────────────────────
  sendCancellationEmail(registrationId, reason).catch(err =>
    console.error('[cancel] Failed to send cancellation email:', err),
  )

  // ── 5. Organizer webhook (fire-and-forget) ─────────────────────────────────
  void enqueueWebhook(uid, 'registration.cancelled', { registrationId }).catch(() => {})

  return NextResponse.json({ success: true })
}
