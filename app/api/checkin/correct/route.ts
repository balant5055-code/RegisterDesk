// POST /api/checkin/correct
//
// RD-CHECKIN-FIX-01 — the two corrections a gate operator must be able to make
// themselves: a mistyped identifier, and a check-in on the wrong person.
//
// ═══ WHY THIS IS A SEPARATE, NARROW DOOR ═════════════════════════════════════
// Both capabilities already exist in this codebase, behind permissions a gate-only
// role must never hold:
//
//   correcting an identifier → /api/organizer/events/[id]/identifiers/*  (`participants`)
//   undoing a check-in       → /api/checkin/undo                          (`registrations`)
//
// `participants` also carries pools, bulk assign, export, history and migration;
// `registrations` carries the whole registration surface. Widening either to
// `checkin` would hand over all of it. Neither route is touched by this file —
// they keep their permissions exactly as they are, and owners/admins/managers keep
// using them unchanged.
//
// Instead this is ONE operation, gated on `checkin`, that can do exactly two
// things to exactly one attendee, and delegates both to the existing engine and
// the existing canonical primitive. No new permission is introduced.
//
// ═══ THE UNDO IS DELIBERATELY NARROWER THAN /api/checkin/undo ════════════════
// RD-CHECKIN-STAFF-01 removed undo from gate staff on purpose. This does not give
// it back wholesale — it grants only the case that made the restriction painful:
// "I just scanned the wrong person." Three limits, all server-side:
//
//   1. the operator must be assigned to the event  (isEventSlugInScope)
//   2. they may only undo a check-in THEY performed (checkedInBy === callerUid)
//   3. only within UNDO_WINDOW_MS of it happening
//
// Anything outside that — a colleague's mistake, or one found an hour later — is
// still a `registrations` action, exactly as before.

import { NextRequest, NextResponse } from 'next/server'
import { adminDb }                    from '@/lib/firebase/admin'
import { authorizeWorkspace }         from '@/lib/team/workspace'
import { isEventSlugInScope }         from '@/lib/team/eventScope'
import { getEventCheckInStatus }      from '@/lib/checkin/eventStatus'
import { checkRateLimit }             from '@/lib/rateLimit'
import { uncheckInRegistration }      from '@/lib/firebase/firestore/registrations'
import { swapIdentifier }             from '@/lib/identifiers/engine'
import { IdentifierError }            from '@/lib/identifiers/types'
import type { RegistrationDocument }  from '@/lib/registrations/types'

/**
 * How long after a check-in its operator may still reverse it.
 *
 * Long enough to cover "wrong person, noticed at the gate"; short enough that it
 * is not a general-purpose attendance edit. Past this, correction is an organizer
 * action through the existing `registrations` route.
 */
export const UNDO_WINDOW_MS = 15 * 60_000

export interface CheckInCorrectResult {
  success:          boolean
  error?:           string
  /** The value now held, after a successful identifier correction. */
  identifierValue?: string
  attendee?: { name: string; passName: string }
}

export async function POST(req: NextRequest): Promise<NextResponse<CheckInCorrectResult>> {
  const authz = await authorizeWorkspace(req, 'checkin')
  if (!authz.ok) return NextResponse.json({ success: false, error: authz.error }, { status: authz.status })
  const uid       = authz.workspaceUid
  const callerUid = authz.callerUid

  // Corrections are rare next to scans; a tighter budget than the 120/min gate
  // rate keeps this from becoming a way to churn identifier locks.
  const rl = checkRateLimit(`${uid}:${callerUid}`, 'checkin-correct', 30, 60 * 1000)
  if (rl.limited) {
    return NextResponse.json(
      { success: false, error: 'Too many correction requests. Please slow down.' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil((rl.resetAt - Date.now()) / 1000)) } },
    )
  }

  let ticketCode: string
  let action: 'identifier' | 'undo'
  let identifierValue: string | undefined
  try {
    const body = await req.json() as { ticketCode?: unknown; action?: unknown; identifierValue?: unknown }
    if (typeof body.ticketCode !== 'string' || !body.ticketCode.trim()) {
      return NextResponse.json({ success: false, error: 'MISSING_TICKET_CODE' }, { status: 400 })
    }
    if (body.action !== 'identifier' && body.action !== 'undo') {
      return NextResponse.json({ success: false, error: 'INVALID_ACTION' }, { status: 400 })
    }
    ticketCode = body.ticketCode.trim().toUpperCase()
    action     = body.action
    identifierValue = typeof body.identifierValue === 'string' && body.identifierValue.trim()
      ? body.identifierValue.trim().slice(0, 64)
      : undefined
  } catch {
    return NextResponse.json({ success: false, error: 'INVALID_BODY' }, { status: 400 })
  }

  // The registration is resolved from the TICKET CODE, never from a client id —
  // the same rule the scan route follows.
  const regSnap = await adminDb.collection('registrations')
    .where('ticketCode', '==', ticketCode).limit(1).get()
  if (regSnap.empty) {
    return NextResponse.json({ success: false, error: 'TICKET_NOT_FOUND' }, { status: 404 })
  }
  const regDoc = regSnap.docs[0]!
  const reg    = regDoc.data() as RegistrationDocument

  if (reg.organizerUid !== uid) {
    return NextResponse.json({ success: false, error: 'UNAUTHORIZED' }, { status: 403 })
  }

  // Staff event assignment — derived from the caller's team record and the
  // registration's real event, so it cannot be sidestepped from the request.
  if (!await isEventSlugInScope(authz, reg.eventSlug)) {
    return NextResponse.json({ success: false, error: 'EVENT_NOT_ASSIGNED' }, { status: 403 })
  }

  const eventStatus = await getEventCheckInStatus(reg.eventSlug)
  if (eventStatus !== 'ok') {
    return NextResponse.json({ success: false, error: 'EVENT_NOT_ACCEPTING_CHECKINS' }, { status: 422 })
  }

  const attendee = { name: reg.attendee.name, passName: reg.passName }

  // ── Correct a mistyped identifier ─────────────────────────────────────────
  if (action === 'identifier') {
    if (!identifierValue) {
      return NextResponse.json({ success: false, error: 'MISSING_IDENTIFIER' }, { status: 400 })
    }

    // Only a CORRECTION. First assignment belongs to the check-in operation, which
    // owns the "assign then check in" ordering; routing it here instead would let a
    // caller assign an identifier without ever admitting anyone.
    const current = (reg as { identifier?: { value?: string } }).identifier
    if (!current?.value) {
      return NextResponse.json({ success: false, error: 'NO_IDENTIFIER_TO_CORRECT' }, { status: 422 })
    }
    if (current.value === identifierValue) {
      // Nothing to do — treated as success so a double-tap is harmless.
      return NextResponse.json({ success: true, identifierValue: current.value, attendee })
    }

    try {
      // The engine owns everything that follows: uniqueness against
      // identifierLocks, blocked/retired refusal, releasing the previous value
      // (whose reuse is then governed by the event's own reusePolicy) and the
      // history entries. This route validates no format and no range.
      const result = await swapIdentifier({
        registrationId: regDoc.id,
        actor:          callerUid,      // attribution: the operator at the gate
        explicitValue:  identifierValue,
        reason:         'gate correction',
      })
      return NextResponse.json({ success: true, identifierValue: result.value, attendee })
    } catch (err) {
      const code = err instanceof IdentifierError ? err.code : 'IDENTIFIER_CORRECT_FAILED'
      if (!(err instanceof IdentifierError)) console.error('[checkin/correct] swap failed:', err)
      return NextResponse.json({ success: false, error: code }, { status: 422 })
    }
  }

  // ── Undo a check-in this operator just performed ──────────────────────────
  if (!reg.checkedIn) {
    return NextResponse.json({ success: false, error: 'NOT_CHECKED_IN' }, { status: 422 })
  }

  // OWN check-ins only. `checkedInBy` is written by the scan transaction from the
  // authenticated caller, so it cannot be spoofed from a request.
  if (reg.checkedInBy !== callerUid) {
    return NextResponse.json({ success: false, error: 'NOT_YOUR_CHECKIN' }, { status: 403 })
  }

  // Inside the window. A missing/unreadable timestamp fails CLOSED — an undo whose
  // age cannot be established is refused rather than allowed.
  const checkedInAt = (reg.checkedInAt as { toMillis?: () => number } | undefined)?.toMillis?.()
  if (typeof checkedInAt !== 'number' || Date.now() - checkedInAt > UNDO_WINDOW_MS) {
    return NextResponse.json({ success: false, error: 'UNDO_WINDOW_EXPIRED' }, { status: 422 })
  }

  // The SAME canonical primitive /api/checkin/undo uses: one transaction, the
  // shard-matched counter reversal, idempotency, and the `check_in_undone` audit
  // entry attributing it to this operator.
  await uncheckInRegistration(regDoc.id, uid, { byUid: callerUid, workspaceUid: uid })

  return NextResponse.json({ success: true, attendee })
}
