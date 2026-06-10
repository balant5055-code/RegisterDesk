// POST /api/organizer/registrations/cancel
//
// Cancels a registration and restores event capacity atomically.
// The organizer must own the registration (organizerUid check inside the transaction).

import { NextRequest, NextResponse }  from 'next/server'
import { adminAuth }                  from '@/lib/firebase/admin'
import {
  cancelRegistration,
  AlreadyCancelledError,
  RegistrationNotFoundError,
  UnauthorizedCancellationError,
} from '@/lib/firebase/firestore/registrations'

interface CancelBody {
  registrationId: string
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  // ── 1. Verify organizer token ──────────────────────────────────────────────
  const authHeader = req.headers.get('authorization') ?? ''
  const token      = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''

  if (!token) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  let uid: string
  try {
    const decoded = await adminAuth.verifyIdToken(token)
    uid = decoded.uid
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid or expired token' }, { status: 401 })
  }

  // ── 2. Parse body ──────────────────────────────────────────────────────────
  let body: CancelBody
  try {
    body = (await req.json()) as CancelBody
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid request body' }, { status: 400 })
  }

  const { registrationId } = body
  if (!registrationId || typeof registrationId !== 'string') {
    return NextResponse.json({ success: false, error: 'registrationId is required' }, { status: 400 })
  }

  // ── 3. Cancel atomically: status, counter decrement, claim cleanup ─────────
  try {
    await cancelRegistration(registrationId, uid)
    return NextResponse.json({ success: true })
  } catch (err) {
    if (err instanceof RegistrationNotFoundError) {
      return NextResponse.json({ success: false, error: 'Registration not found' }, { status: 404 })
    }
    if (err instanceof AlreadyCancelledError) {
      return NextResponse.json({ success: false, error: 'Registration is already cancelled' }, { status: 409 })
    }
    if (err instanceof UnauthorizedCancellationError) {
      return NextResponse.json({ success: false, error: 'Not authorized to cancel this registration' }, { status: 403 })
    }
    console.error('[organizer/registrations/cancel] Unexpected error:', { registrationId, err })
    return NextResponse.json({ success: false, error: 'Failed to cancel registration' }, { status: 500 })
  }
}
