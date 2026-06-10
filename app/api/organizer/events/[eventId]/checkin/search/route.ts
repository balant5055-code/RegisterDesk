// GET /api/organizer/events/[eventId]/checkin/search?q=...
//
// Server-side attendee lookup for the check-in screen.
// Returns up to 50 registrations whose ticketCode, name, email, or phone
// contains the query string (case-insensitive substring match).
//
// Security:
//   1. Firebase ID token required.
//   2. Only registrations owned by the authenticated organizer are searched.
//   3. Event ownership is verified via the organizer's draft document.

import { NextRequest, NextResponse } from 'next/server'
import { adminDb, adminAuth }        from '@/lib/firebase/admin'
import type { RegistrationDocument } from '@/lib/registrations/types'

// ─── Response types ───────────────────────────────────────────────────────────

export interface AttendeeSearchResult {
  id:            string
  ticketCode:    string
  attendeeName:  string
  attendeeEmail: string
  attendeePhone: string | undefined
  passName:      string
  status:        string
  checkedIn:     boolean
  checkedInAt:   string | null
}

export interface AttendeeSearchResponse {
  results:   AttendeeSearchResult[]
  truncated: boolean
}

const MAX_RESULTS = 50

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toISO(ts: unknown): string | null {
  if (!ts) return null
  if (typeof (ts as { toDate?: () => Date }).toDate === 'function') {
    return (ts as { toDate: () => Date }).toDate().toISOString()
  }
  return null
}

function matches(reg: RegistrationDocument, q: string): boolean {
  const lower = q.toLowerCase()
  const upper = q.toUpperCase()
  return (
    reg.ticketCode.includes(upper) ||
    reg.attendee.name.toLowerCase().includes(lower) ||
    reg.attendee.email.toLowerCase().includes(lower) ||
    (typeof reg.attendee.phone === 'string' && reg.attendee.phone.includes(q))
  )
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function GET(
  req:     NextRequest,
  context: { params: Promise<{ eventId: string }> },
): Promise<NextResponse<AttendeeSearchResponse | { error: string }>> {
  // ── 1. Auth ────────────────────────────────────────────────────────────────
  const token = (req.headers.get('authorization') ?? '').replace('Bearer ', '')
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let uid: string
  try {
    uid = (await adminAuth.verifyIdToken(token)).uid
  } catch {
    return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
  }

  const { eventId } = await context.params

  // ── 2. Verify organizer owns this event ────────────────────────────────────
  const draftSnap = await adminDb.doc(`users/${uid}/eventDrafts/${eventId}`).get()
  if (!draftSnap.exists) {
    return NextResponse.json({ error: 'Event not found' }, { status: 404 })
  }
  const draft = draftSnap.data() as Record<string, unknown>
  if (draft.status !== 'published') {
    return NextResponse.json({ error: 'Event is not published' }, { status: 403 })
  }

  const rawDetails = draft.eventDetails as Record<string, unknown> | null
  const rawSeo     = rawDetails?.seo as Record<string, unknown> | null
  const slug       = typeof rawSeo?.urlSlug === 'string' ? rawSeo.urlSlug : ''
  if (!slug) {
    return NextResponse.json({ error: 'Event slug not resolved' }, { status: 404 })
  }

  // ── 3. Parse + validate query ──────────────────────────────────────────────
  const q = (req.nextUrl.searchParams.get('q') ?? '').trim()
  if (q.length < 2) {
    return NextResponse.json({ results: [], truncated: false })
  }
  if (q.length > 100) {
    return NextResponse.json({ error: 'Query too long' }, { status: 400 })
  }

  // ── 4. Load registrations (two equality filters, no composite index needed) ─
  const snap = await adminDb
    .collection('registrations')
    .where('organizerUid', '==', uid)
    .where('eventSlug',    '==', slug)
    .get()

  // ── 5. Filter and truncate ─────────────────────────────────────────────────
  const all: AttendeeSearchResult[] = []

  for (const doc of snap.docs) {
    const reg = doc.data() as RegistrationDocument
    if (!matches(reg, q)) continue

    all.push({
      id:            doc.id,
      ticketCode:    reg.ticketCode,
      attendeeName:  reg.attendee.name,
      attendeeEmail: reg.attendee.email,
      attendeePhone: reg.attendee.phone,
      passName:      reg.passName,
      status:        reg.status,
      checkedIn:     reg.checkedIn,
      checkedInAt:   toISO(reg.checkedInAt),
    })

    if (all.length > MAX_RESULTS) break
  }

  const truncated = all.length > MAX_RESULTS
  const results   = truncated ? all.slice(0, MAX_RESULTS) : all

  // Sort: not-checked-in first, then by name
  results.sort((a, b) => {
    if (a.checkedIn !== b.checkedIn) return a.checkedIn ? 1 : -1
    return a.attendeeName.localeCompare(b.attendeeName)
  })

  return NextResponse.json({ results, truncated })
}
