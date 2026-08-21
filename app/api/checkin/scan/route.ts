// POST /api/checkin/scan
//
// Validates a ticket code and marks the registration as checked-in.
// Requires organizer authentication — only the event owner can check people in.
//
// Security:
//   1. Token verified server-side via Firebase Admin Auth.
//   2. Registration loaded from Firestore by ticketCode query — never trusts client.
//   3. Ownership verified: reg.organizerUid must equal authenticated uid.
//   4. Double-entry prevention: checkedIn flag checked before write.
//   5. Event lifecycle checked: only published/registration_closed/completed events
//      accept check-ins.  draft, unpublished, cancelled, archived all rejected.

import { NextRequest, NextResponse }   from 'next/server'
import { FieldValue }                   from 'firebase-admin/firestore'
import { adminDb }                      from '@/lib/firebase/admin'
import { writeCheckinDelta }            from '@/lib/firebase/firestore/registrationCounters'
import { authorizeWorkspace }           from '@/lib/team/workspace'
import { isEventSlugInScope }           from '@/lib/team/eventScope'
import { getEventCheckInStatus }        from '@/lib/checkin/eventStatus'
import { checkRateLimit }               from '@/lib/rateLimit'
import { enqueueWebhook }                from '@/lib/integrations/webhooks'
import { crmRecordCheckIn }              from '@/lib/crm/service'
import { consumeIdentifier, allocateIdentifier } from '@/lib/identifiers/engine'
import { resolveIdentifierConfig }      from '@/lib/identifiers/config'
import { IdentifierError }              from '@/lib/identifiers/types'
import { checkInBlockReason, type CheckInBlockReason } from '@/lib/registrations/checkinEligibility'
import type { RegistrationDocument }    from '@/lib/registrations/types'

// ─── Response types ───────────────────────────────────────────────────────────

export interface CheckInResult {
  success:         boolean
  alreadyCheckedIn?: boolean
  attendee?: {
    name:     string
    passName: string
  }
  eventName?:   string
  checkedInAt?: string          // ISO string
  error?:       string
  /**
   * RD-CHECKIN-BIB-01 — set when this event issues identifiers and THIS attendee
   * has none. The caller must collect one and retry with `identifierValue`; the
   * attendee is NOT checked in until it is supplied and accepted.
   */
  requiresIdentifier?: boolean
  /** The organizer's configured label ("Bib Number", "Member ID", …). Never hardcoded. */
  identifierLabel?:    string
  /** The value that was assigned as part of this check-in, when one was. */
  identifierValue?:    string
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest): Promise<NextResponse<CheckInResult>> {
  // ── Auth ──────────────────────────────────────────────────────────────────
  const authz = await authorizeWorkspace(req, 'checkin')
  if (!authz.ok) return NextResponse.json({ success: false, error: authz.error }, { status: authz.status })
  const uid       = authz.workspaceUid    // authorization / ownership scope
  const callerUid = authz.callerUid       // attribution: the actual operator

  // ── Rate limit: 120 scans per minute per operator within a workspace ───────
  // Keyed by workspace+operator so one staff member can't exhaust the whole
  // workspace's quota; each operator gets their own 120/min budget.
  const rl = checkRateLimit(`${uid}:${callerUid}`, 'checkin', 120, 60 * 1000)
  if (rl.limited) {
    return NextResponse.json(
      { success: false, error: 'Too many scan requests. Please slow down.' },
      {
        status: 429,
        headers: {
          'Retry-After':       String(Math.ceil((rl.resetAt - Date.now()) / 1000)),
          'X-RateLimit-Limit': '120',
          'X-RateLimit-Reset': String(rl.resetAt),
        },
      },
    )
  }

  // ── Parse body ────────────────────────────────────────────────────────────
  let ticketCode: string
  let source: string | undefined
  let expectedEventSlug: string | undefined
  let identifierValue: string | undefined
  try {
    const body = await req.json() as {
      ticketCode?: unknown; source?: unknown; eventSlug?: unknown; identifierValue?: unknown
    }
    if (typeof body.ticketCode !== 'string' || !body.ticketCode.trim()) {
      return NextResponse.json({ success: false, error: 'MISSING_TICKET_CODE' }, { status: 400 })
    }
    ticketCode = body.ticketCode.trim().toUpperCase()
    source     = typeof body.source === 'string' ? body.source.trim() : undefined
    // RD-CHECKIN-BIB-01 — the identifier the operator typed, when the previous
    // attempt reported one was required. Length-capped here only to keep an absurd
    // payload out of the engine; the ENGINE owns format, range and uniqueness.
    identifierValue = typeof body.identifierValue === 'string' && body.identifierValue.trim()
      ? body.identifierValue.trim().slice(0, 64)
      : undefined
    // Optional (backward-compatible): the gate the operator is running. When
    // present, the scanned ticket must belong to THIS event — otherwise a ticket
    // for another of the same organizer's events would open this gate.
    expectedEventSlug = typeof body.eventSlug === 'string' && body.eventSlug.trim()
      ? body.eventSlug.trim()
      : undefined
  } catch {
    return NextResponse.json({ success: false, error: 'INVALID_BODY' }, { status: 400 })
  }

  // ── Lookup registration by ticketCode ─────────────────────────────────────
  // ticketCode is indexed via ticketCodeClaims — query registrations directly
  const regSnap = await adminDb
    .collection('registrations')
    .where('ticketCode', '==', ticketCode)
    .limit(1)
    .get()

  if (regSnap.empty) {
    return NextResponse.json({ success: false, error: 'TICKET_NOT_FOUND' }, { status: 404 })
  }

  const regDoc  = regSnap.docs[0]
  const reg     = regDoc.data() as RegistrationDocument
  const regRef  = regDoc.ref

  // ── Ownership check (never trust client for this) ─────────────────────────
  if (reg.organizerUid !== uid) {
    return NextResponse.json({ success: false, error: 'UNAUTHORIZED' }, { status: 403 })
  }

  // ── Event-scope check ─────────────────────────────────────────────────────
  // A ticket only admits at its OWN event's gate. Cross-organizer is already
  // blocked above; this closes the same-organizer cross-event case (an Event B
  // ticket must not open the Event A gate). Mirrors the event-scoped offline
  // cache and the session check-in EVENT_MISMATCH guard.
  if (expectedEventSlug && reg.eventSlug !== expectedEventSlug) {
    return NextResponse.json({ success: false, error: 'WRONG_EVENT' }, { status: 422 })
  }

  // ── Staff event assignment (RD-CHECKIN-STAFF-01) ──────────────────────────
  // The check above is a CLIENT-DECLARED gate and is optional, so on its own it
  // cannot contain an operator: omitting `eventSlug` skips it entirely. This one
  // is derived from the caller's own team record and the registration's real
  // event, so it cannot be sidestepped from the request. A gate operator assigned
  // to Event A is refused an Event B ticket even if the client sends nothing.
  if (!await isEventSlugInScope(authz, reg.eventSlug)) {
    return NextResponse.json({ success: false, error: 'EVENT_NOT_ASSIGNED' }, { status: 403 })
  }

  // ── Registration status and payment eligibility ──────────────────────────
  // RD-ORGANIZER-01 P0-1: use the ONE canonical eligibility rule shared with the
  // bulk / canonical checkInRegistration path (lib/registrations/checkinEligibility).
  // This closes the prior gap where a `rejected` registration was admitted at the QR
  // gate while the bulk path blocked it. Cancelled/pending/refunded keep their exact
  // error codes; rejected now returns REGISTRATION_REJECTED.
  const blockReason = checkInBlockReason(reg)
  if (blockReason) {
    const errorByReason: Record<CheckInBlockReason, string> = {
      CANCELLED: 'REGISTRATION_CANCELLED',
      PENDING:   'REGISTRATION_PENDING',
      REJECTED:  'REGISTRATION_REJECTED',
      REFUNDED:  'REGISTRATION_REFUNDED',
    }
    return NextResponse.json({ success: false, error: errorByReason[blockReason] }, { status: 422 })
  }

  // ── Already checked in ────────────────────────────────────────────────────
  if (reg.checkedIn) {
    const checkedInAt = reg.checkedInAt
      ? (() => {
          const ts = reg.checkedInAt as { toDate?: () => Date }
          return ts.toDate ? ts.toDate().toISOString() : null
        })()
      : null

    return NextResponse.json({
      success:         true,
      alreadyCheckedIn: true,
      attendee:        { name: reg.attendee.name, passName: reg.passName },
      eventName:       reg.eventName,
      checkedInAt:     checkedInAt ?? undefined,
    })
  }

  // ── Event lifecycle check ─────────────────────────────────────────────────
  // Must be published, registration_closed, or completed. All other states
  // (draft, unpublished, cancelled, archived, or doc missing) reject here.
  const eventStatus = await getEventCheckInStatus(reg.eventSlug)
  if (eventStatus !== 'ok') {
    return NextResponse.json({ success: false, error: 'EVENT_NOT_ACCEPTING_CHECKINS' }, { status: 422 })
  }

  // ── Identifier gate (RD-CHECKIN-BIB-01) ───────────────────────────────────
  //
  // Runs AFTER every eligibility check and BEFORE the check-in transaction, which
  // is what makes the ordering requirement true: an attendee who cannot be
  // identified is never marked present, and an ineligible attendee is rejected
  // before we would have asked for an identifier at all.
  //
  // ORDER IS THE ATOMICITY STORY. `allocateIdentifier` runs its own Firestore
  // transaction (lock read + write + registration mirror). Assigning FIRST means:
  //   • assignment fails  → we return here; the attendee is NOT checked in.
  //   • check-in fails    → the identifier stays assigned. That is deliberate and
  //     safe: it belongs to this attendee, a retry finds it present, skips the
  //     prompt, and completes. The alternative — folding both into one
  //     transaction — would mean reimplementing the identifier engine, which owns
  //     locks, pools, reuse policy and history.
  //
  // The identifier value is the ONLY thing taken from the request here. The
  // registration was resolved from the ticket code and the event from the stored
  // document, so an operator can name a value, never a victim.
  let assignedIdentifier: string | undefined

  const { config: idConfig } = await resolveIdentifierConfig(reg.eventSlug)
  if (idConfig.enabled) {
    const existing = (reg as { identifier?: { value?: string } }).identifier
    const hasIdentifier = typeof existing?.value === 'string' && existing.value.length > 0

    if (!hasIdentifier) {
      // Nothing typed yet → tell the caller what to ask for, and stop. This is the
      // "show the popup" signal; no write of any kind has happened.
      if (!identifierValue) {
        return NextResponse.json({
          success: false,
          error:   'IDENTIFIER_REQUIRED',
          requiresIdentifier: true,
          identifierLabel:    idConfig.label,
          attendee:  { name: reg.attendee.name, passName: reg.passName },
          eventName: reg.eventName,
        }, { status: 422 })
      }

      try {
        const allocated = await allocateIdentifier({
          eventSlug:      reg.eventSlug,
          registrationId: regDoc.id,
          actor:          callerUid,      // attribution: the operator at the gate
          source:         'manual',       // an operator typed it
          explicitValue:  identifierValue,
        })
        assignedIdentifier = allocated.value
      } catch (err) {
        // The engine is the authority on duplicate / blocked / retired / range /
        // manual-override-disabled. Its codes are surfaced verbatim so the operator
        // is told which one it was, and the attendee stays NOT checked in.
        const code = err instanceof IdentifierError ? err.code : 'IDENTIFIER_ASSIGN_FAILED'
        if (!(err instanceof IdentifierError)) {
          console.error('[scan] identifier allocation failed:', err)
        }
        return NextResponse.json({
          success: false,
          error:   code,
          requiresIdentifier: true,
          identifierLabel:    idConfig.label,
        }, { status: 422 })
      }
    }
  }

  // ── Perform check-in atomically ───────────────────────────────────────────
  const now = FieldValue.serverTimestamp()

  await adminDb.runTransaction(async txn => {
    // Re-read inside transaction to prevent double check-in under concurrent load
    const freshSnap = await txn.get(regRef)
    const fresh     = freshSnap.data() as RegistrationDocument
    if (fresh.checkedIn) return  // already done — idempotent

    txn.update(regRef, {
      checkedIn:             true,
      checkedInAt:           now,
      checkedInBy:           callerUid,   // the operator who scanned (attribution)
      checkedInWorkspaceUid: uid,         // the workspace the action belongs to
      updatedAt:             now,
      ...(source ? { checkedInSource: source } : {}),
    })

    // Increment attendance counters (event-level + per-pass) atomically — GA-5 S3:
    // routed to the registration's shard so mass gate scanning spreads the writes.
    writeCheckinDelta(txn, reg.eventSlug, regRef.id, reg.passId, 1)
  })

  const checkedInAt = new Date().toISOString()

  void enqueueWebhook(uid, 'registration.checked_in', {
    registrationId: regDoc.id, ticketCode: reg.ticketCode, eventSlug: reg.eventSlug,
    attendeeName: reg.attendee.name, checkedInBy: callerUid, checkedInAt,
  }).catch(() => {})

  // CRM check-in activity (fire-and-forget, idempotent per registration).
  crmRecordCheckIn({
    organizerUid: uid, email: reg.attendee.email, name: reg.attendee.name,
    registrationId: regDoc.id, eventSlug: reg.eventSlug, eventName: reg.eventName,
  })

  // Identity engine: consume the identifier on check-in (assigned → consumed,
  // everCheckedIn=true — permanent). Fire-and-forget + idempotent + a no-op when
  // the registration holds no identifier, so it never affects the check-in path.
  void consumeIdentifier(regDoc.id, callerUid).catch(err =>
    console.error('[scan] consumeIdentifier failed:', err),
  )

  return NextResponse.json({
    success:         true,
    alreadyCheckedIn: false,
    attendee:        { name: reg.attendee.name, passName: reg.passName },
    eventName:       reg.eventName,
    checkedInAt,
    // Echoed so the gate can confirm on screen what was written — an operator who
    // just typed a bib needs to see the one that actually stuck.
    ...(assignedIdentifier ? { identifierValue: assignedIdentifier } : {}),
  })
}
