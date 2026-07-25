// GET /api/organizer/events/[eventId]/registrations
//
// Query params (all OPTIONAL — omitting them preserves the original behaviour):
//   limit    — 25 | 50 | 100 (default 50); ignored when all=true
//   cursor   — registration doc ID to start after (server-side cursor pagination)
//   all      — 'true' to load full dataset (capped at 2000) — legacy client-filter mode
//   RD-ORGANIZER-01 P0-2 — server-side filter / sort / search (indexed, cursor-paginated):
//   status   — registration status equality filter
//   payment  — paymentStatus equality filter
//   passId   — passId equality filter
//   checkin  — 'yes' → checkedIn==true (see note: 'no' is NOT server-filtered because the
//              field is absent on never-checked-in docs — the client refines that case)
//   from,to  — registeredAt date range (YYYY-MM-DD, inclusive)
//   dir      — 'asc' | 'desc' sort on registeredAt (default 'desc')
//   q        — EXACT lookup: ticket code (RD-…) or email. Firestore has no substring
//              search; partial-name matching stays a client refinement over the page.

import { NextRequest, NextResponse } from 'next/server'
import { Timestamp }      from 'firebase-admin/firestore'
import { adminDb }        from '@/lib/firebase/admin'
import { authorizeWorkspace } from '@/lib/team/workspace'
import { getEventStats, aggregateRegistrationStatusCounts } from '@/lib/firebase/firestore/registrationCounters'
import type { RegistrationDocument }  from '@/lib/registrations/types'

// ─── Serialized shape (Timestamps → ISO strings) ──────────────────────────────

export interface SerializedRegistration extends Omit<RegistrationDocument, 'registeredAt' | 'updatedAt' | 'emailSentAt' | 'checkedInAt'> {
  registeredAt: string | null
  updatedAt:    string | null
  emailSentAt:  string | null
  checkedInAt:  string | null
}

export interface RegistrationsApiResponse {
  registrations: SerializedRegistration[]
  eventName:     string
  eventSlug:     string
  passes:        { id: string; name: string }[]
  fieldLabels:   Record<string, string>
  stats: {
    total:      number
    confirmed:  number
    pending:    number
    cancelled:  number
    waitlisted: number
    rejected:   number
    checkedIn:  number
  }
  hasMore:    boolean
  nextCursor: string | null
  totalCount: number
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toISO(ts: unknown): string | null {
  if (!ts) return null
  if (typeof (ts as { toDate?: () => Date }).toDate === 'function') {
    return (ts as { toDate: () => Date }).toDate().toISOString()
  }
  return null
}

function serializeDoc(doc: { data(): unknown }): SerializedRegistration {
  const data = doc.data() as RegistrationDocument
  return {
    ...data,
    registeredAt: toISO(data.registeredAt),
    updatedAt:    toISO(data.updatedAt),
    emailSentAt:  toISO(data.emailSentAt),
    checkedInAt:  toISO(data.checkedInAt),
  } as SerializedRegistration
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function GET(
  req:     NextRequest,
  context: { params: Promise<{ eventId: string }> },
): Promise<NextResponse<RegistrationsApiResponse | { error: string }>> {
  try {
  // ── 1. Auth ────────────────────────────────────────────────────────────────
  const authz = await authorizeWorkspace(req, 'registrations')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  const uid = authz.workspaceUid

  const { eventId } = await context.params

  // ── 2. Verify ownership ────────────────────────────────────────────────────
  const draftRef  = adminDb.doc(`users/${uid}/eventDrafts/${eventId}`)
  const draftSnap = await draftRef.get()
  if (!draftSnap.exists) return NextResponse.json({ error: 'Event not found' }, { status: 404 })

  const draft = draftSnap.data() as Record<string, unknown>
  if (draft.status !== 'published') {
    return NextResponse.json({ error: 'Event is not published' }, { status: 403 })
  }

  // ── 3. Extract event metadata ───────────────────────────────────────────────
  const rawDetails = draft.eventDetails as Record<string, unknown> | null
  const rawSeo     = rawDetails?.seo  as Record<string, unknown> | null
  const rawInfo    = rawDetails?.info as Record<string, unknown> | null
  const slug       = typeof rawSeo?.urlSlug === 'string' ? rawSeo.urlSlug : ''
  const eventName  = typeof rawInfo?.name   === 'string' ? rawInfo.name   : 'Event'
  if (!slug) return NextResponse.json({ error: 'Event slug not resolved' }, { status: 404 })

  // ── 4. Build pass list ─────────────────────────────────────────────────────
  const rawPricing = draft.pricing as Record<string, unknown> | null
  const rawPasses  = Array.isArray(rawPricing?.passes) ? rawPricing.passes as Record<string, unknown>[] : []
  const passes     = rawPasses.map(p => ({
    id:   String(p.id   ?? ''),
    name: String(p.name ?? 'Pass'),
  }))

  // ── 5. Build fieldId → label map ───────────────────────────────────────────
  const rawForm = draft.registrationForm as {
    sections?: Array<{ fields: Array<{ id: string; label: string }> }>
  } | null
  const fieldLabels: Record<string, string> = {}
  for (const section of rawForm?.sections ?? []) {
    for (const field of section.fields ?? []) {
      if (field.id && field.label) fieldLabels[field.id] = field.label
    }
  }

  // ── 6. Parse query params ──────────────────────────────────────────────────
  const params   = req.nextUrl.searchParams
  const allMode  = params.get('all') === 'true'
  const rawLimit = Number(params.get('limit') ?? '50')
  const pageSize = [25, 50, 100].includes(rawLimit) ? rawLimit : 50
  const cursor   = params.get('cursor') ?? null

  // P0-2 — server-side filter / sort / exact-search inputs (all optional).
  const statusF  = params.get('status')  ?? ''
  const paymentF = params.get('payment') ?? ''
  const passF    = params.get('passId')  ?? ''
  const checkinF = params.get('checkin') ?? ''       // 'yes' → checkedIn==true (see header note)
  const fromF    = params.get('from')    ?? ''
  const toF      = params.get('to')      ?? ''
  const dir: 'asc' | 'desc' = params.get('dir') === 'asc' ? 'asc' : 'desc'
  const q        = (params.get('q') ?? '').trim()

  // ── 7. Stats — O(1) from the per-event statistics doc (EA-2 S1) ────────────
  // The status breakdown is served from registrationCounters/{slug} instead of
  // scanning every registration on each page load. Falls back to the former
  // projected scan for events whose stats doc has not yet been backfilled
  // (statsVersion < current) so legacy events are never mis-reported.
  // (Waitlist entries live in a separate `waitlists` collection, so the
  // registrations status breakdown never contains 'waitlisted'.)
  const stats = { total: 0, confirmed: 0, pending: 0, cancelled: 0, waitlisted: 0, rejected: 0, checkedIn: 0 }
  const { counter, complete } = await getEventStats(slug)

  if (complete && counter) {
    stats.confirmed  = counter.totalCount     ?? 0
    stats.pending    = counter.pendingCount   ?? 0
    stats.cancelled  = counter.cancelledCount ?? 0
    stats.rejected   = counter.rejectedCount  ?? 0
    stats.checkedIn  = counter.checkedInCount ?? 0
    stats.total      = stats.confirmed + stats.pending + stats.cancelled + stats.rejected + stats.waitlisted
  } else {
    // Fallback (not-yet-backfilled) — the ONE shared statistics fallback: indexed count()
    // aggregates that transfer zero documents (RD-REGISTRATIONS-01 Phase 4 / M8), replacing
    // the former per-registration projected scan. Same source of truth, same values.
    const c = await aggregateRegistrationStatusCounts(uid, slug)
    stats.total      = c.total
    stats.confirmed  = c.confirmed
    stats.pending    = c.pending
    stats.cancelled  = c.cancelled
    stats.waitlisted = c.waitlisted
    stats.rejected   = c.rejected
    stats.checkedIn  = c.checkedIn
  }

  let registrations: SerializedRegistration[]
  let hasMore    = false
  let nextCursor: string | null = null

  // ── 8a. Exact search (ticket code / email) — bypasses pagination + filters ──
  // Firestore has no substring search, so `q` is an EXACT lookup that finds a specific
  // attendee at any scale. ticketCode is globally unique (single-field indexed) and email
  // uses the existing (eventSlug, attendee.email) index; ownership is re-verified in memory.
  // A free-text (name) `q` falls through to the filtered/paginated path for client refinement.
  const looksLikeTicket = /^rd[-_ ]?[a-z0-9]/i.test(q) || /^[a-z0-9]{6,}$/i.test(q)
  if (q && q.includes('@')) {
    const snap = await adminDb.collection('registrations')
      .where('eventSlug', '==', slug).where('attendee.email', '==', q.toLowerCase())
      .limit(50).get()
    registrations = snap.docs.map(serializeDoc).filter(r => r.organizerUid === uid)
    return NextResponse.json({ registrations, eventName, eventSlug: slug, passes, fieldLabels, stats, hasMore: false, nextCursor: null, totalCount: stats.total })
  }
  if (q && looksLikeTicket) {
    const code = q.replace(/\s+/g, '').toUpperCase()
    const snap = await adminDb.collection('registrations').where('ticketCode', '==', code).limit(5).get()
    registrations = snap.docs.map(serializeDoc).filter(r => r.organizerUid === uid && r.eventSlug === slug)
    return NextResponse.json({ registrations, eventName, eventSlug: slug, passes, fieldLabels, stats, hasMore: false, nextCursor: null, totalCount: stats.total })
  }

  // ── 8b. Filtered + sorted + cursor-paginated query (indexed) ────────────────
  // Optional equality/range filters are applied server-side so filtered browsing
  // paginates over the WHOLE matching set (never a capped client slice). Composite
  // indexes: (organizerUid, eventSlug, <status|paymentStatus|passId|checkedIn>, registeredAt).
  // Any uncovered combination falls back to the base (organizerUid, eventSlug, registeredAt)
  // index and the client refines the remainder over the page — never a large fetch, never a 500.
  function buildQuery(applyFilters: boolean): FirebaseFirestore.Query {
    let query: FirebaseFirestore.Query = adminDb.collection('registrations')
      .where('organizerUid', '==', uid).where('eventSlug', '==', slug)
    if (applyFilters) {
      if (statusF)            query = query.where('status', '==', statusF)
      if (paymentF)           query = query.where('paymentStatus', '==', paymentF)
      if (passF)              query = query.where('passId', '==', passF)
      if (checkinF === 'yes') query = query.where('checkedIn', '==', true)
      if (fromF) { const d = new Date(`${fromF}T00:00:00`);     if (!Number.isNaN(d.getTime())) query = query.where('registeredAt', '>=', Timestamp.fromDate(d)) }
      if (toF)   { const d = new Date(`${toF}T23:59:59.999`);   if (!Number.isNaN(d.getTime())) query = query.where('registeredAt', '<=', Timestamp.fromDate(d)) }
    }
    return query.orderBy('registeredAt', dir)
  }

  async function runPaged(base: FirebaseFirestore.Query): Promise<FirebaseFirestore.QuerySnapshot> {
    if (allMode) return base.limit(2000).get()
    let pageQuery = base.limit(pageSize + 1)
    if (cursor) {
      const cursorDoc = await adminDb.collection('registrations').doc(cursor).get()
      if (cursorDoc.exists) pageQuery = base.startAfter(cursorDoc).limit(pageSize + 1)
    }
    return pageQuery.get()
  }

  let snap: FirebaseFirestore.QuerySnapshot
  try {
    snap = await runPaged(buildQuery(true))
  } catch {
    // Missing composite index for this rare filter combination → degrade to the base
    // indexed query; the client's refinement covers the remaining predicates.
    snap = await runPaged(buildQuery(false))
  }

  if (allMode) {
    registrations = snap.docs.map(serializeDoc)
    hasMore = snap.size === 2000
  } else {
    hasMore    = snap.size > pageSize
    const docs = hasMore ? snap.docs.slice(0, pageSize) : snap.docs
    nextCursor = hasMore ? docs[docs.length - 1].id : null
    registrations = docs.map(serializeDoc)
  }

  return NextResponse.json({
    registrations,
    eventName,
    eventSlug: slug,
    passes,
    fieldLabels,
    stats,
    hasMore,
    nextCursor,
    totalCount: stats.total,
  })
  } catch (error) {
    // Logged server-side; return a generic message rather than the raw exception.
    console.error('EVENT_REGISTRATIONS_ERROR', error)
    return NextResponse.json(
      { error: 'Failed to load registrations.' },
      { status: 500 },
    )
  }
}
