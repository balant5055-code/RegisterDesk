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
import { getEventCheckInStatus }        from '@/lib/checkin/eventStatus'
import { checkRateLimit }               from '@/lib/rateLimit'
import { enqueueWebhook }                from '@/lib/integrations/webhooks'
import { crmRecordCheckIn }              from '@/lib/crm/service'
import { consumeIdentifier }             from '@/lib/identifiers/engine'
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
  try {
    const body = await req.json() as { ticketCode?: unknown; source?: unknown }
    if (typeof body.ticketCode !== 'string' || !body.ticketCode.trim()) {
      return NextResponse.json({ success: false, error: 'MISSING_TICKET_CODE' }, { status: 400 })
    }
    ticketCode = body.ticketCode.trim().toUpperCase()
    source     = typeof body.source === 'string' ? body.source.trim() : undefined
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

  // ── Registration status and payment eligibility ──────────────────────────
  if (reg.status === 'cancelled') {
    return NextResponse.json({ success: false, error: 'REGISTRATION_CANCELLED' }, { status: 422 })
  }

  // P1-2: Pending registrations (manual approval not yet granted) must not be
  // admitted. Only 'confirmed' registrations are eligible; 'pending' means the
  // organizer has not reviewed or approved the application yet.
  if (reg.status === 'pending') {
    return NextResponse.json({ success: false, error: 'REGISTRATION_PENDING' }, { status: 422 })
  }

  // P1-1: Refunded registrations retain status:'confirmed' because the refund
  // flow updates only paymentStatus. Checking paymentStatus here closes the gap
  // that would otherwise allow a refunded attendee to enter the event.
  if (reg.paymentStatus === 'refunded') {
    return NextResponse.json({ success: false, error: 'REGISTRATION_REFUNDED' }, { status: 422 })
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
  })
}
