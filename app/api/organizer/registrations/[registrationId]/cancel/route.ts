// POST /api/organizer/registrations/[registrationId]/cancel
//
// Cancels a registration by URL-param registrationId.
// Atomically: status → cancelled, counter decremented, claim docs cleaned up.
// Writes an audit entry fire-and-forget after the transaction.

import { NextRequest, NextResponse }  from 'next/server'
import { adminAuth }                   from '@/lib/firebase/admin'
import {
  cancelRegistration,
  writeAuditEntry,
  AlreadyCancelledError,
  RegistrationNotFoundError,
  UnauthorizedCancellationError,
} from '@/lib/firebase/firestore/registrations'

export interface CancelRegistrationResponse {
  success: boolean
  error?:  string
}

export async function POST(
  req:     NextRequest,
  context: { params: Promise<{ registrationId: string }> },
): Promise<NextResponse<CancelRegistrationResponse>> {
  // ── 1. Auth ────────────────────────────────────────────────────────────────
  const token = (req.headers.get('authorization') ?? '').replace(/^Bearer /, '')
  if (!token) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  let uid: string
  try {
    uid = (await adminAuth.verifyIdToken(token)).uid
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid or expired token' }, { status: 401 })
  }

  const { registrationId } = await context.params
  if (!registrationId) {
    return NextResponse.json({ success: false, error: 'registrationId is required' }, { status: 400 })
  }

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
  writeAuditEntry(registrationId, 'cancelled', uid, 'organizer').catch(err =>
    console.error('[cancel] Failed to write audit entry:', err),
  )

  return NextResponse.json({ success: true })
}
