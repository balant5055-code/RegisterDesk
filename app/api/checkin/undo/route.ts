// POST /api/checkin/undo
//
// Reverts a check-in: clears checkedIn flag, removes timestamps, decrements
// the attendance counter.  Requires the same organizer auth as /api/checkin/scan.
//
// Security:
//   1. Token verified server-side via Firebase Admin Auth.
//   2. Registration is loaded by ticketCode — client payload is never trusted.
//   3. Ownership verified: reg.organizerUid must equal authenticated uid.
//   4. Double-undo prevention: re-read inside transaction; no-op if already false.

import { NextRequest, NextResponse }  from 'next/server'
import { adminDb }                     from '@/lib/firebase/admin'
import { uncheckInRegistration }       from '@/lib/firebase/firestore/registrations'
import { authorizeWorkspace }          from '@/lib/team/workspace'
import { getEventCheckInStatus }       from '@/lib/checkin/eventStatus'
import { checkRateLimit }              from '@/lib/rateLimit'
import type { RegistrationDocument }   from '@/lib/registrations/types'

// ─── Response type ────────────────────────────────────────────────────────────

export interface CheckInUndoResult {
  success:   boolean
  attendee?: { name: string; passName: string }
  error?:    string
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest): Promise<NextResponse<CheckInUndoResult>> {
  // ── Auth ──────────────────────────────────────────────────────────────────
  const authz = await authorizeWorkspace(req, 'checkin')
  if (!authz.ok) return NextResponse.json({ success: false, error: authz.error }, { status: authz.status })
  const uid       = authz.workspaceUid
  const callerUid = authz.callerUid

  // ── Rate limit: 60 undos per minute per organizer UID ─────────────────────
  const rl = checkRateLimit(uid, 'checkin-undo', 60, 60 * 1000)
  if (rl.limited) {
    return NextResponse.json(
      { success: false, error: 'Too many undo requests. Please slow down.' },
      {
        status: 429,
        headers: {
          'Retry-After':       String(Math.ceil((rl.resetAt - Date.now()) / 1000)),
          'X-RateLimit-Limit': '60',
          'X-RateLimit-Reset': String(rl.resetAt),
        },
      },
    )
  }

  // ── Parse body ────────────────────────────────────────────────────────────
  let ticketCode: string
  try {
    const body = await req.json() as { ticketCode?: unknown }
    if (typeof body.ticketCode !== 'string' || !body.ticketCode.trim()) {
      return NextResponse.json({ success: false, error: 'MISSING_TICKET_CODE' }, { status: 400 })
    }
    ticketCode = body.ticketCode.trim().toUpperCase()
  } catch {
    return NextResponse.json({ success: false, error: 'INVALID_BODY' }, { status: 400 })
  }

  // ── Lookup registration by ticketCode ─────────────────────────────────────
  const regSnap = await adminDb
    .collection('registrations')
    .where('ticketCode', '==', ticketCode)
    .limit(1)
    .get()

  if (regSnap.empty) {
    return NextResponse.json({ success: false, error: 'TICKET_NOT_FOUND' }, { status: 404 })
  }

  const regDoc = regSnap.docs[0]!
  const reg    = regDoc.data() as RegistrationDocument

  // ── Ownership check ───────────────────────────────────────────────────────
  if (reg.organizerUid !== uid) {
    return NextResponse.json({ success: false, error: 'UNAUTHORIZED' }, { status: 403 })
  }

  // ── Event lifecycle check ─────────────────────────────────────────────────
  const eventStatus = await getEventCheckInStatus(reg.eventSlug)
  if (eventStatus !== 'ok') {
    return NextResponse.json({ success: false, error: 'EVENT_NOT_ACCEPTING_CHECKINS' }, { status: 422 })
  }

  // ── Nothing to undo ───────────────────────────────────────────────────────
  if (!reg.checkedIn) {
    return NextResponse.json({ success: false, error: 'NOT_CHECKED_IN' }, { status: 422 })
  }

  // ── Atomically revert check-in — canonical helper (transaction + counter + audit) ──
  await uncheckInRegistration(regDoc.id, uid, { byUid: callerUid, workspaceUid: uid })

  return NextResponse.json({
    success:  true,
    attendee: { name: reg.attendee.name, passName: reg.passName },
  })
}
