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
//   5. Event lifecycle checked: cancelled events cannot accept check-ins.

import { NextRequest, NextResponse }   from 'next/server'
import { FieldValue }                   from 'firebase-admin/firestore'
import { adminAuth, adminDb }           from '@/lib/firebase/admin'
import { checkRateLimit }               from '@/lib/rateLimit'
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
  const token = (req.headers.get('authorization') ?? '').replace('Bearer ', '')
  if (!token) return NextResponse.json({ success: false, error: 'UNAUTHORIZED' }, { status: 401 })

  let uid: string
  try {
    uid = (await adminAuth.verifyIdToken(token)).uid
  } catch {
    return NextResponse.json({ success: false, error: 'INVALID_TOKEN' }, { status: 401 })
  }

  // ── Rate limit: 120 scans per minute per organizer UID ────────────────────
  // Using UID (not IP) because organisers scanning at a venue may share a NAT.
  // 120/min = 2 scans/second, enough headroom for rapid scanning.
  const rl = checkRateLimit(uid, 'checkin', 120, 60 * 1000)
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

  // ── Registration status ───────────────────────────────────────────────────
  if (reg.status === 'cancelled') {
    return NextResponse.json({ success: false, error: 'REGISTRATION_CANCELLED' }, { status: 422 })
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
  const eventSnap = await adminDb.collection('events').doc(reg.eventSlug).get()
  if (eventSnap.exists) {
    const evData = eventSnap.data() as Record<string, unknown>
    const ls = evData.lifecycleStatus as string | undefined
    if (ls === 'cancelled') {
      return NextResponse.json({ success: false, error: 'EVENT_CANCELLED' }, { status: 422 })
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
      checkedIn:   true,
      checkedInAt: now,
      checkedInBy: uid,
      updatedAt:   now,
      ...(source ? { checkedInSource: source } : {}),
    })

    // Increment checked-in counter on the registration counter document
    const counterRef = adminDb.collection('registrationCounters').doc(reg.eventSlug)
    txn.set(counterRef, { checkedInCount: FieldValue.increment(1) }, { merge: true })
  })

  const checkedInAt = new Date().toISOString()

  return NextResponse.json({
    success:         true,
    alreadyCheckedIn: false,
    attendee:        { name: reg.attendee.name, passName: reg.passName },
    eventName:       reg.eventName,
    checkedInAt,
  })
}
