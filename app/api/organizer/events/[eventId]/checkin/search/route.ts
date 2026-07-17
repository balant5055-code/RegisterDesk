// GET /api/organizer/events/[eventId]/checkin/search?q=...
//
// Server-side attendee lookup for the check-in screen.
//
// Search strategy (scales beyond 2 000 registrations):
//
//   1. Ticket-code path (q starts with "RD-"):
//      Single equality query on the globally-unique `ticketCode` field.
//      O(1) — one Firestore read regardless of event size.
//
//   2. General path (name / email / phone):
//      Scoped query filtered to this event (organizerUid + eventSlug),
//      capped at 500 documents, then filtered in-process.
//      For most events this is fast; the 500-doc cap prevents unbounded reads
//      on very large events.  Gate staff get a hint to use ticket code or email
//      for exact results when a name search is truncated.
//
// Security:
//   1. Firebase ID token required.
//   2. Only registrations owned by the authenticated organizer are searched.
//   3. Event ownership verified via the organizer's draft document.

import { NextRequest, NextResponse } from 'next/server'
import { adminDb }        from '@/lib/firebase/admin'
import { authorizeWorkspace } from '@/lib/team/workspace'
import { getEventCheckInStatus }     from '@/lib/checkin/eventStatus'
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
  results:    AttendeeSearchResult[]
  truncated:  boolean
  searchMode: 'exact' | 'scan'   // 'exact' = O(1) ticket lookup; 'scan' = bounded name scan
}

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_RESULTS   = 50
const SCAN_DOC_CAP  = 500   // max docs loaded from Firestore in scan mode

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toISO(ts: unknown): string | null {
  if (!ts) return null
  if (typeof (ts as { toDate?: () => Date }).toDate === 'function') {
    return (ts as { toDate: () => Date }).toDate().toISOString()
  }
  return null
}

function toResult(id: string, reg: RegistrationDocument): AttendeeSearchResult {
  return {
    id,
    ticketCode:    reg.ticketCode,
    attendeeName:  reg.attendee.name,
    attendeeEmail: reg.attendee.email,
    attendeePhone: reg.attendee.phone,
    passName:      reg.passName,
    status:        reg.status,
    checkedIn:     reg.checkedIn,
    checkedInAt:   toISO(reg.checkedInAt),
  }
}

function matchesScan(reg: RegistrationDocument, q: string): boolean {
  const lower = q.toLowerCase()
  return (
    reg.attendee.name.toLowerCase().includes(lower)  ||
    reg.attendee.email.toLowerCase().includes(lower) ||
    (typeof reg.attendee.phone === 'string' && reg.attendee.phone.includes(q))
  )
}

function sortResults(results: AttendeeSearchResult[]): void {
  // Not-yet-checked-in first, then alphabetical — most useful order at the gate
  results.sort((a, b) => {
    if (a.checkedIn !== b.checkedIn) return a.checkedIn ? 1 : -1
    return a.attendeeName.localeCompare(b.attendeeName)
  })
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function GET(
  req:     NextRequest,
  context: { params: Promise<{ eventId: string }> },
): Promise<NextResponse<AttendeeSearchResponse | { error: string }>> {

  // ── 1. Auth ────────────────────────────────────────────────────────────────
  const authz = await authorizeWorkspace(req, 'checkin')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  const uid = authz.workspaceUid

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

  // ── 2b. Verify event lifecycle accepts check-ins ───────────────────────────
  // draft.status confirms ownership/publication; lifecycleStatus confirms the
  // event has not been cancelled, archived, or otherwise closed to check-ins.
  const eventStatus = await getEventCheckInStatus(slug)
  if (eventStatus !== 'ok') {
    return NextResponse.json({ error: 'Event is not accepting check-ins' }, { status: 403 })
  }

  // ── 3. Parse + validate query ──────────────────────────────────────────────
  const q = (req.nextUrl.searchParams.get('q') ?? '').trim()
  if (q.length < 2) {
    return NextResponse.json({ results: [], truncated: false, searchMode: 'scan' })
  }
  if (q.length > 100) {
    return NextResponse.json({ error: 'Query too long' }, { status: 400 })
  }

  // ── 4a. Ticket-code fast path ──────────────────────────────────────────────
  // Ticket codes are globally unique and stored with a single-field auto-index.
  // An exact lookup is O(1) regardless of how many registrations the event has.
  // Detect: query starts with "RD-" (case-insensitive) — the system's ticket prefix.
  if (/^RD-/i.test(q)) {
    const codeSnap = await adminDb
      .collection('registrations')
      .where('ticketCode', '==', q.toUpperCase())
      .limit(1)
      .get()

    if (codeSnap.empty) {
      return NextResponse.json({ results: [], truncated: false, searchMode: 'exact' })
    }

    const doc = codeSnap.docs[0]!
    const reg = doc.data() as RegistrationDocument

    // Ownership: the found ticket must belong to this organizer
    if (reg.organizerUid !== uid) {
      return NextResponse.json({ results: [], truncated: false, searchMode: 'exact' })
    }

    return NextResponse.json({
      results:    [toResult(doc.id, reg)],
      truncated:  false,
      searchMode: 'exact',
    })
  }

  // ── 4b. General scan path (name / email / phone) ───────────────────────────
  // Load up to SCAN_DOC_CAP docs scoped to this organizer + event, filter in-process.
  // The two equality conditions use the existing [organizerUid, eventSlug] composite
  // index — no additional indexes required.
  const snap = await adminDb
    .collection('registrations')
    .where('organizerUid', '==', uid)
    .where('eventSlug',    '==', slug)
    .limit(SCAN_DOC_CAP)
    .get()

  const matched: AttendeeSearchResult[] = []

  for (const doc of snap.docs) {
    const reg = doc.data() as RegistrationDocument
    if (!matchesScan(reg, q)) continue
    matched.push(toResult(doc.id, reg))
    if (matched.length > MAX_RESULTS) break
  }

  const truncated = matched.length > MAX_RESULTS
  const results   = truncated ? matched.slice(0, MAX_RESULTS) : matched
  sortResults(results)

  // truncated may also be true if we hit SCAN_DOC_CAP before exhausting the event
  const hitCap = snap.size === SCAN_DOC_CAP

  return NextResponse.json({
    results,
    truncated: truncated || hitCap,
    searchMode: 'scan',
  })
}
