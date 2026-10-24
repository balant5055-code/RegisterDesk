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
//   checkin  — 'yes' → checkedIn==true (server-side); 'no' → checkedIn !== true.
//              RD-CHECKIN-FILTER-01: 'no' is applied IN MEMORY while paging (bounded scan,
//              resumable cursor), because paid registrations settled before
//              settleCapturedRegistration wrote `checkedIn: false` carry NO such field, and
//              Firestore's `== false` silently excluded every one of them. The list is exact;
//              `checkinFilterComplete` is still returned (always true) for existing clients.
//   coupon   — 'with' → any coupon; or an exact coupon CODE. There is deliberately no
//              'without': `couponCode` is not written at all when no coupon is used
//              (see createRegistration), and Firestore cannot query for an absent field —
//              exactly the same limitation as checkin='no' above. Offering a broken
//              "Without coupon" that silently returned everything would be worse than
//              omitting it, so the option is not shown.
//   from,to  — registeredAt date range (YYYY-MM-DD, inclusive)
//   dir      — 'asc' | 'desc' sort on registeredAt (default 'desc')
//   q        — EXACT lookup: ticket code (RD-…) or email. Firestore has no substring
//              search; partial-name matching stays a client refinement over the page.

import { NextRequest, NextResponse } from 'next/server'
import { Timestamp }      from 'firebase-admin/firestore'
import { parseTrendDays, trendRanges } from '@/lib/events/registrationTrend'
import { adminDb }        from '@/lib/firebase/admin'
import { authorizeWorkspace } from '@/lib/team/workspace'
import { getEventStats, aggregateRegistrationStatusCounts } from '@/lib/firebase/firestore/registrationCounters'
import {
  classifySearch, isSearchable, normalizeEmail, normalizeTicket,
  rowMatches, searchMeta, type SearchKind, type TextSearchMeta,
} from '@/lib/registrations/search'
import type { RegistrationDocument }  from '@/lib/registrations/types'
import { resolveOwnedEventSlug } from '@/lib/events/liveEventRef'

/**
 * How many documents a free-text search may scan, and how many matches it returns.
 *
 * The scan is SERVER-side and projected by `serializeDoc`, so the browser receives at
 * most `SEARCH_RESULT_CAP` rows regardless. The ceiling is reported to the caller
 * (`search.truncated`) rather than silently applied.
 */
const SEARCH_SCAN_CAP   = 1000
const SEARCH_RESULT_CAP = 50

/**
 * RD-REPORT-02 · how many passes the summary breakdown will measure.
 *
 * Each pass costs exactly two `count()` aggregates, which transfer no documents, so the
 * cost is bounded by the number of PASSES an organizer configured — never by how many
 * people registered. The ceiling exists only so a pathological pass list cannot turn one
 * request into hundreds of aggregates; it is REPORTED (`passStatsTruncated`) rather than
 * silently applied, because a breakdown that quietly omits passes is exactly the class of
 * defect this phase exists to remove.
 */
const MAX_BREAKDOWN_PASSES = 40

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
  /**
   * RD-REPORT-02 · per-pass registration counts over the WHOLE event.
   *
   * Present only in `?view=summary`, which is the mode whose job is aggregates. The
   * Reports tab used to build this by grouping the 50-row page it happened to hold, so a
   * 1,200-person event reported single-digit pass counts. These come from `count()`
   * aggregates over the full dataset instead.
   *
   * `confirmed` / `cancelled` are `number | null`: null means the aggregate did not run,
   * and the client must render "—". A failed count is never 0 — 0 asserts that nobody
   * chose that pass, which is a different and much worse claim than "not measured".
   */
  passStats?: { id: string; name: string; confirmed: number | null; cancelled: number | null }[]
  /** True when the event has more passes than the breakdown measured. */
  passStatsTruncated?: boolean

  /**
   * RD-EVENT-11 · present ONLY when `checkin=no` was requested. Additive.
   *
   * `false` means some registrations carry no `checkedIn` field at all — legacy rows
   * written before it was set on create — and Firestore cannot match an absent field,
   * so those people are missing from the list. Attendance says so out loud: an
   * incomplete "who has not arrived" list is worse at a gate than no list.
   */
  checkinFilterComplete?: boolean

  /**
   * RD-EVENT-12 · present ONLY when `q` was a searchable query. Additive.
   *
   * `kind` says how the query was resolved; `truncated` says the free-text scan hit its
   * ceiling, so there may be matches it never saw. The UI must state that rather than
   * present a bounded scan as a complete answer.
   */
  search?: { kind: SearchKind } & TextSearchMeta

  /** RD-EVENT-07 · present ONLY in `?trend=<days>` mode, which returns no rows.
   *  A null count means that bucket could not be read — it is NOT zero. Additive. */
  trend?: {
    timeZone: string
    buckets:  { date: string; count: number | null }[]
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toISO(ts: unknown): string | null {
  if (!ts) return null
  if (typeof (ts as { toDate?: () => Date }).toDate === 'function') {
    return (ts as { toDate: () => Date }).toDate().toISOString()
  }
  return null
}

function serializeDoc(doc: { id: string; data(): unknown }): SerializedRegistration {
  const data = doc.data() as RegistrationDocument
  return {
    ...data,
    // RD-EVENT-21 · the id comes from the DOCUMENT, not from a field inside it.
    // `createRegistration` writes `id` into the body and every real registration has
    // it, so this changes nothing for them — the two are equal by construction. But
    // `id` is what every row action addresses (`/registrations/{id}/cancel`, refund,
    // audit) and what React keys the table by, so a document that somehow lacked the
    // field produced rows keyed `undefined` and actions posted to `/undefined/`.
    // Deriving it removes that possibility entirely.
    id:           doc.id,
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
  const rawInfo    = rawDetails?.info as Record<string, unknown> | null
  // RD-CE-FIX C1 · only a slug proven to be THIS workspace's live event (counter stats have no owner filter).
  const slug       = (await resolveOwnedEventSlug(uid, eventId, draft)) ?? ''
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
  // Uppercased to match the normalized `couponCode` the registration stores.
  const couponF  = (params.get('coupon') ?? '').trim().toUpperCase()
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

  // ── 8·0. TREND MODE (RD-EVENT-07) — additive, opt-in, zero documents ───────
  //
  // `?trend=<days>` answers "how did registrations arrive over time" with one
  // `count()` aggregate per local day. It returns NO registration rows: drawing an
  // aggregate chart must never transfer attendee PII (§8).
  //
  // Overview previously computed this in the browser from the 51-document page, which
  // made the chart wrong for any event past 51 registrations and bucketed on a UTC date
  // while labelling with a local weekday. Buckets are now day boundaries in the EVENT's
  // timezone, counted over the whole dataset.
  //
  // Served by the existing (organizerUid, eventSlug, registeredAt) composite — no new
  // index. Bounded to 31 days, so the aggregate count can never grow with the event.
  const trendDays = parseTrendDays(params.get('trend'))
  if (trendDays !== null) {
    // The EVENT's own timezone, so a bucket boundary is the organizer's midnight — not
    // the server's and not the viewer's. Falls back to the platform default when the
    // draft carries no zone or an unrecognised one.
    const details  = (draft.eventDetails as Record<string, unknown> | undefined) ?? {}
    const schedule = (details.schedule as Record<string, unknown> | undefined) ?? {}
    const rawZone  = typeof schedule.timezone === 'string' ? schedule.timezone : null
    let timeZone = 'Asia/Kolkata'
    if (rawZone) {
      try { new Intl.DateTimeFormat('en-CA', { timeZone: rawZone }); timeZone = rawZone }
      catch { /* unrecognised zone — keep the default rather than throwing */ }
    }
    const ranges = trendRanges(new Date(), timeZone, trendDays)

    const counts = await Promise.all(ranges.map(r =>
      adminDb.collection('registrations')
        .where('organizerUid', '==', uid)
        .where('eventSlug', '==', slug)
        .where('registeredAt', '>=', Timestamp.fromDate(r.start))
        .where('registeredAt', '<',  Timestamp.fromDate(r.end))
        .count().get()
        .then(s => s.data().count as number)
        // A failed bucket stays NULL. Rendering it as 0 would claim nobody registered
        // that day — the one thing the chart must never invent.
        .catch(() => null),
    ))

    return NextResponse.json({
      registrations: [],
      eventName, eventSlug: slug, passes, fieldLabels,
      stats, hasMore: false, nextCursor: null, totalCount: stats.total,
      trend: { timeZone, buckets: ranges.map((r, i) => ({ date: r.date, count: counts[i] })) },
    } satisfies RegistrationsApiResponse)
  }

  // ── 7b. SUMMARY MODE (RD-EVENT-12) — additive, opt-in, zero documents ──────
  //
  // `?view=summary` answers "how many, and in what state" and returns NO rows.
  //
  // The Event → Registrations tab used to render a five-row preview of attendee names
  // and email addresses, which meant the shell fetched a full 51-document page — fifty
  // registrations' worth of PII — to decorate a page whose real job is to hand the
  // organizer over to the Registration Manager. The tab now shows counts only, and
  // counts already exist: `stats` above is served from `registrationCounters/{slug}`,
  // one document, or from count() aggregates that transfer none at all.
  if (params.get('view') === 'summary') {
    // RD-REPORT-02 · the per-pass breakdown, over the whole event.
    //
    // Two `count()` aggregates per pass, both served by the EXISTING
    // (organizerUid, eventSlug, status, passId) composite — zero documents transferred and
    // no new index. This is the same shape the event already uses for its status counts,
    // applied one level down.
    const measured = passes.slice(0, MAX_BREAKDOWN_PASSES)
    const countFor = (passId: string, status: string) =>
      adminDb.collection('registrations')
        .where('organizerUid', '==', uid)
        .where('eventSlug',    '==', slug)
        .where('status',       '==', status)
        .where('passId',       '==', passId)
        .count().get()
        .then(s => s.data().count as number)
        // Stays null. See `passStats` on the response type: a failed aggregate must not
        // become a zero that reads as "nobody bought this pass".
        .catch(() => null)

    const passStats = await Promise.all(measured.map(async p => {
      const [confirmed, cancelled] = await Promise.all([
        countFor(p.id, 'confirmed'),
        countFor(p.id, 'cancelled'),
      ])
      return { id: p.id, name: p.name, confirmed, cancelled }
    }))

    return NextResponse.json({
      registrations: [],
      eventName, eventSlug: slug, passes, fieldLabels,
      stats, hasMore: false, nextCursor: null, totalCount: stats.total,
      passStats, passStatsTruncated: passes.length > measured.length,
    } satisfies RegistrationsApiResponse)
  }

  let registrations: SerializedRegistration[]
  let hasMore    = false
  let nextCursor: string | null = null

  // ── 8a. Search — resolved ENTIRELY server-side ─────────────────────────────
  //
  // RD-EVENT-12 · This block used to classify a query with
  //   /^rd[-_ ]?[a-z0-9]/i.test(q) || /^[a-z0-9]{6,}$/i.test(q)
  // whose second alternative matches any single ASCII word of six characters or more.
  // "Bartholomew" and "Murugan" were therefore looked up as TICKET CODES and returned
  // empty — a present attendee reported as no match, which is what the organizer saw as
  // "search is not working". Anything that heuristic missed had no name predicate at
  // all, so the client asked for `all=true` and filtered 2,000 documents in the browser:
  // correct only below the 2,000 ceiling, and invisible above it.
  //
  // Now: exact lookups stay O(1) on their existing indexes, and free text is matched on
  // the SERVER over a bounded, PROJECTED window — the browser receives matches, never a
  // collection. The window's ceiling is reported rather than hidden (§16, §23).
  if (q && isSearchable(q)) {
    const kind = classifySearch(q)
    const reply = (rows: SerializedRegistration[], meta?: TextSearchMeta) =>
      NextResponse.json({
        registrations: rows, eventName, eventSlug: slug, passes, fieldLabels, stats,
        hasMore: false, nextCursor: null, totalCount: stats.total,
        search: { kind, ...(meta ?? { scanned: rows.length, scanLimit: 0, truncated: false, capped: false }) },
      })

    if (kind === 'email') {
      const snap = await adminDb.collection('registrations')
        .where('eventSlug', '==', slug).where('attendee.email', '==', normalizeEmail(q))
        .limit(SEARCH_RESULT_CAP).get()
      return reply(snap.docs.map(serializeDoc).filter(r => r.organizerUid === uid))
    }

    if (kind === 'ticket') {
      const snap = await adminDb.collection('registrations')
        .where('ticketCode', '==', normalizeTicket(q)).limit(5).get()
      // Ownership AND event scope re-verified in memory: `ticketCode` is globally
      // unique and single-field indexed, so the query itself is not event-scoped.
      const exact = snap.docs.map(serializeDoc).filter(r => r.organizerUid === uid && r.eventSlug === slug)
      // A miss FALLS THROUGH to the text search. No prefix rule can be perfect — someone
      // named "RD Sharma" exists — and the old code's mistake was not the heuristic
      // itself but that a misclassified query dead-ended in an empty result instead of
      // being searched as what it also might be: a name.
      if (exact.length > 0) return reply(exact)
    }

    if (kind === 'phone') {
      // Served by the existing (eventSlug, attendee.phone) index when the stored value
      // matches exactly. Digits rarely round-trip identically (`+91` prefixes, spaces),
      // so a miss falls through to the scan rather than reporting "no such person".
      const snap = await adminDb.collection('registrations')
        .where('eventSlug', '==', slug).where('attendee.phone', '==', q.trim())
        .limit(SEARCH_RESULT_CAP).get()
      const exact = snap.docs.map(serializeDoc).filter(r => r.organizerUid === uid)
      if (exact.length > 0) return reply(exact)
    }

    // ── Identifier: exact, indexed, and tried before the scan ────────────────
    //
    // RD-EVENT-20 · "who is bib 5001?" is the most-typed query at an event desk and
    // it used to return NOTHING: the value classified as free text, and free text had
    // no identifier field to match. A scan alone would not have fixed it either —
    // `SEARCH_SCAN_CAP` is 1,000, so at 20,000 registrations the holder is usually
    // outside the window.
    //
    // `bibNumber` is the LEGACY mirror the engine writes in the same transaction as
    // the lock, and it already carries a single composite index (eventSlug,
    // bibNumber). So this is one exact indexed read, event-scoped, with ownership
    // re-checked in memory — and a miss FALLS THROUGH to the text search, because a
    // conference identifier like "DEL-0001" is also a plausible thing to type at a
    // person whose name nobody can spell.
    // (An email query has already returned above, so anything reaching here could
    // legitimately be an identifier.)
    const idSnap = await adminDb.collection('registrations')
      .where('eventSlug', '==', slug).where('bibNumber', '==', q.trim())
      .limit(SEARCH_RESULT_CAP).get()
    const idExact = idSnap.docs.map(serializeDoc).filter(r => r.organizerUid === uid)
    if (idExact.length > 0) return reply(idExact)

    // ── Free text: bounded, projected, server-side ───────────────────────────
    // Firestore has no substring index and this schema carries no normalized name
    // field to build one on, so a name search is a scan. It is bounded, it never
    // leaves the server unfiltered, and its ceiling is REPORTED (see `search.truncated`)
    // so the UI can say what it actually searched instead of implying it saw everyone.
    const scanSnap = await adminDb.collection('registrations')
      .where('organizerUid', '==', uid).where('eventSlug', '==', slug)
      .orderBy('registeredAt', 'desc').limit(SEARCH_SCAN_CAP)
      .get()

    const matchedDocs = scanSnap.docs.filter(d => {
      const r = d.data() as RegistrationDocument
      return rowMatches({
        name:       r.attendee?.name  ?? '',
        email:      r.attendee?.email ?? '',
        phone:      r.attendee?.phone,
        ticketCode: r.ticketCode,
        // The generic mirror first, falling back to the legacy one, so an event
        // predating RD-EVENT-19A is searchable by its identifier too.
        identifier: r.identifier?.value ?? r.bibNumber ?? null,
      }, q)
    })

    return reply(
      matchedDocs.slice(0, SEARCH_RESULT_CAP).map(serializeDoc),
      searchMeta(scanSnap.size, SEARCH_SCAN_CAP, matchedDocs.length, SEARCH_RESULT_CAP),
    )
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
      // RD-EVENT-11 · BOTH directions are server-side now. "Who has not arrived yet"
      // is the single most operational question Attendance asks, and answering it by
      // filtering a 50-row page in the browser is correct only until the 51st
      // registration. `checkedIn` is stored on every registration and the
      // (organizerUid, eventSlug, checkedIn, registeredAt) composite already exists —
      // the same one `yes` uses — so this paginates over the WHOLE matching set and
      // needs no new index.
      if (checkinF === 'yes')     query = query.where('checkedIn', '==', true)
      // RD-CHECKIN-FILTER-01 · 'no' is NOT pushed to Firestore. Paid registrations settled before
      // the fix carry NO `checkedIn` field, and an `== false` query excludes documents missing the
      // field — it silently dropped every one of them. 'no' is applied in memory below
      // (`checkedIn !== true`), the same rule the export uses.
      // 'WITH' uses a range predicate because every stored code is a non-empty string, so
      // >= '' matches exactly the documents that HAVE the field. Documents without a coupon
      // are absent from this index entirely, which is precisely why the inverse is impossible.
      if (couponF === 'WITH')  query = query.where('couponCode', '>=', '')
      else if (couponF)        query = query.where('couponCode', '==', couponF)
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

  // RD-CHECKIN-FILTER-01 · "Not checked in" — the other filters stay server-side; `checkedIn !== true`
  // is applied while paging, so registrations WITHOUT the field (paid ones settled before the fix)
  // are included. Bounded: at most NOT_CHECKED_IN_SCAN_CAP documents are read per request; a request
  // that hits the bound before filling its page returns what it found with `hasMore` and a cursor at
  // the last row SCANNED, so the next page resumes exactly there and nothing is skipped or repeated.
  const NOT_CHECKED_IN_SCAN_CAP = 2000
  const isNotCheckedIn = (d: FirebaseFirestore.QueryDocumentSnapshot) => d.get('checkedIn') !== true
  async function runNotCheckedIn(base: FirebaseFirestore.Query): Promise<{ docs: FirebaseFirestore.QueryDocumentSnapshot[]; more: boolean; next: string | null }> {
    if (allMode) {
      const s = await base.limit(2000).get()
      return { docs: s.docs.filter(isNotCheckedIn), more: s.size === 2000, next: null }
    }
    let q = base
    if (cursor) {
      const cursorDoc = await adminDb.collection('registrations').doc(cursor).get()
      if (cursorDoc.exists) q = base.startAfter(cursorDoc)
    }
    const kept: FirebaseFirestore.QueryDocumentSnapshot[] = []
    let scanned = 0
    let last: FirebaseFirestore.QueryDocumentSnapshot | null = null
    for (;;) {
      const batchSize = Math.min(500, NOT_CHECKED_IN_SCAN_CAP - scanned)
      const s = await q.limit(batchSize).get()
      for (const d of s.docs) {
        scanned++; last = d
        if (isNotCheckedIn(d)) kept.push(d)
        if (kept.length > pageSize) break
      }
      if (kept.length > pageSize) return { docs: kept.slice(0, pageSize), more: true, next: kept[pageSize - 1].id }
      if (s.size < batchSize || !last) return { docs: kept, more: false, next: null }
      if (scanned >= NOT_CHECKED_IN_SCAN_CAP) return { docs: kept, more: true, next: last.id }
      q = base.startAfter(last)
    }
  }

  if (checkinF === 'no') {
    let page: Awaited<ReturnType<typeof runNotCheckedIn>>
    try {
      page = await runNotCheckedIn(buildQuery(true))
    } catch {
      // Missing composite index for this rare filter combination → the base indexed query, as below.
      page = await runNotCheckedIn(buildQuery(false))
    }
    registrations = page.docs.map(serializeDoc)
    hasMore       = page.more
    nextCursor    = allMode ? null : page.next
  } else {
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
  }

  // RD-EVENT-11 · kept for the clients that read it. The "not checked in" list is now exact (it no
  // longer depends on documents carrying the field), so it is always complete.
  const checkinFilterComplete: boolean | undefined = checkinF === 'no' ? true : undefined

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
    ...(checkinFilterComplete === undefined ? {} : { checkinFilterComplete }),
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
