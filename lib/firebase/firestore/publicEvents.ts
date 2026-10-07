// Server-only — uses Firebase Admin SDK. Never import this directly from client components.
// Use `import type { PublicEventCard, PlatformStats }` for type-only imports in client code.

import { adminDb } from '@/lib/firebase/admin'
import { organizersQuery } from '@/lib/organizer/identity'
import { isContentTakenDown } from '@/lib/admin/moderation'
import { isArchivedEvent } from '@/lib/events/lifecycleStateMachine'
import type { ModerationStatus } from '@/lib/admin/moderation'

// ─── Exported types (safe to `import type` from client components) ────────────

export interface PublicEventCard {
  id:            string        // === slug
  slug:          string
  name:          string
  tagline:       string
  startDate:     string | null // YYYY-MM-DD
  endDate:       string | null
  startTime:     string | null // HH:mm
  city:          string | null
  state:         string | null
  venueType:     'physical' | 'online' | 'hybrid'
  eventType:     string | null
  bannerUrl:     string | null
  logoUrl:       string | null
  isFreeEvent:   boolean
  minPrice:      number        // rupees
  totalCapacity: number | null
  totalCount:    number        // registered
  organizerName: string | null
  organizerLogo: string | null
  approvalMode:  'auto' | 'manual'
  publishedAt:   string | null // ISO
}

export interface PlatformStats {
  totalEvents:        number
  totalRegistrations: number
  totalCities:        number
  totalOrganizers:    number
}

export interface DiscoveryData {
  events:     PublicEventCard[]
  stats:      PlatformStats
  nextCursor: string | null   // additive: pass back as ?cursor= for the next page; null = last page
}

// Server-authoritative discovery query (RD-DISCOVERY-01 Phase 1 / D-C1). All filters run over
// the FULL published dataset via the paginated scan below, so nothing depends on a loaded page.
export interface DiscoveryQuery {
  limit?:    number
  cursor?:   string | null
  search?:   string
  category?: string
  city?:     string
  /** Exact match on `eventDetails.venue.physical.state` — the state half of location discovery. */
  state?:    string
  free?:     boolean | null
  online?:   boolean | null
  /**
   * Venue mode. Supersedes `online` when present, and is the only one of the two that can
   * express 'hybrid'. `online` is kept intact so existing callers/links are unaffected.
   */
  venue?:    'physical' | 'online' | 'hybrid' | '' | null
  date?:     DateRangeKey | '' | null
  /** Inclusive custom window (YYYY-MM-DD). Only read when `date === 'custom'`. */
  dateFrom?: string | null
  dateTo?:   string | null
  /**
   * Platform statistics are three O(1) count() aggregates over the whole database. They are
   * worth running for a first page render and pure waste for a caller that already has them:
   * the discovery client refetches on every filter change but renders its hero from the SSR
   * payload and never reads the stats a refetch returns — three aggregates per keystroke,
   * computed and discarded. Passing false skips them.
   *
   * Defaults to true (omitted === true), so every existing caller is unchanged.
   */
  withStats?: boolean
}

/** Every date range the discovery UI may ask for. Each one is implemented in matchesDateRange. */
export type DateRangeKey =
  | 'today' | 'tomorrow' | 'weekend' | 'week' | 'month' | 'nextmonth' | 'custom' | 'live'

const DATE_RANGE_KEYS: readonly string[] = [
  'today', 'tomorrow', 'weekend', 'week', 'month', 'nextmonth', 'custom', 'live',
]

/** Narrowing guard for the `?date=` query param — keeps the route free of a duplicate list. */
export function isDateRangeKey(v: string | null | undefined): v is DateRangeKey {
  return !!v && DATE_RANGE_KEYS.includes(v)
}

const EMPTY_PLATFORM_STATS: PlatformStats = {
  totalEvents: 0, totalRegistrations: 0, totalCities: 0, totalOrganizers: 0,
}

// RD-DISCOVERY-01 Phase 2 (D-H1): the ONE platform-statistics resolver. Every hero metric
// derives from a platform-wide O(1) count() aggregate (the same pattern /api/admin/stats and
// getAdminAnalytics use), NOT from a discovery page — so the numbers are correct regardless of
// which page is loaded and stay O(1) at 1M events. Distinct-city count has no O(1) Firestore
// aggregate; rather than a full scan (unscalable) or a page-derived value (the D-H1 defect),
// totalCities is 0 and the hero hides zero-value metrics (a maintained cities counter would be
// a future additive enhancement).
export async function getPlatformStats(): Promise<PlatformStats> {
  const [eventsSnap, regsSnap, orgsSnap] = await Promise.all([
    adminDb.collection('events').where('lifecycleStatus', '==', 'published').count().get().catch(() => null),
    adminDb.collection('registrations').where('status', '==', 'confirmed').count().get().catch(() => null),
    organizersQuery(adminDb).count().get().catch(() => null),
  ])
  return {
    totalEvents:        eventsSnap?.data().count ?? 0,
    totalRegistrations: regsSnap?.data().count   ?? 0,
    totalOrganizers:    orgsSnap?.data().count    ?? 0,
    totalCities:        0,
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function str(obj: unknown, key: string): string | null {
  if (!obj || typeof obj !== 'object') return null
  const v = (obj as Record<string, unknown>)[key]
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

function rec(obj: unknown, key: string): Record<string, unknown> {
  if (!obj || typeof obj !== 'object') return {}
  const v = (obj as Record<string, unknown>)[key]
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

// ─── Discovery filtering (server-side, over the FULL published set) ───────────

const DEFAULT_PAGE_SIZE = 48
const SCAN_BATCH        = 200

/**
 * The lifecycle states in which an event is publicly real — live, or having run.
 *
 * This is NOT a new rule. It mirrors ACCEPTING_STATUSES in lib/checkin/eventStatus.ts and
 * CHECKIN_LIFECYCLE_STATES in lib/attendance/attendanceView.ts, which already define exactly
 * this triple, and which explicitly reject 'draft', 'unpublished', 'cancelled' and 'archived'.
 *
 * It matters here because `listPublishedEvents` filters `lifecycleStatus == 'published'`, and
 * an event that has actually happened usually is NOT in that state any more: closing
 * registrations moves it to 'registration_closed', and the organizer's "Complete" action moves
 * it to 'completed'. Both are past events that a "published only" query can never return.
 */
export const PUBLIC_LIFECYCLE = ['published', 'registration_closed', 'completed'] as const

/** How far back "recently completed" reaches. A section, not an archive. */
export const RECENT_COMPLETED_WINDOW_DAYS = 90

/**
 * Ceiling on documents examined by the completed-events scan.
 *
 * The scan walks the canonical (lifecycleStatus, publishedAt) index because the completion
 * boundary is `endDate ?? startDate` — two fields — and no single Firestore range filter can
 * coalesce them. Ordering by publishedAt therefore does not order by completion, so the
 * matches have to be collected and sorted in memory.
 *
 * That is bounded rather than unbounded on purpose: at most this many documents are read
 * however large the catalogue grows. The honest limit is that an event completed inside the
 * window but published further back than this many documents ago will not be found. If the
 * catalogue ever outgrows it, the fix is a (lifecycleStatus, startDate) index and a range
 * query — not a bigger number here.
 */
const MAX_COMPLETED_SCAN = 600

// Server-side date-range predicate — the ONE place a discovery date range is defined.
//
// Every range an attendee can pick in the UI is implemented here, so the picker never offers
// a shortcut that quietly matches everything. 'today' / 'week' / 'month' keep their original
// meaning exactly; 'tomorrow' / 'weekend' / 'nextmonth' / 'custom' are additive.
//
// A past event never matches any range: discovery is forward-looking, and that was already
// true of the three original ranges.
function matchesDateRange(
  startDate: string | null,
  range:     string,
  from?:     string | null,
  to?:       string | null,
  endDate?:  string | null,
): boolean {
  if (!range) return true
  if (!startDate) return false
  const now = new Date(); now.setHours(0, 0, 0, 0)
  const [y, m, d] = startDate.split('-').map(Number)
  const ev = new Date(y, (m ?? 1) - 1, d ?? 1)

  // 'live' is the ONE range that must be evaluated BEFORE the past-event guard below.
  // Every other range is forward-looking, but an event that STARTED yesterday and ends
  // tomorrow is happening right now — which is exactly what "live" means. Expressing it
  // as 'today' instead would silently drop every multi-day event already under way, which
  // is most of the ones worth surfacing.
  if (range === 'live') {
    const end = endDate && endDate >= startDate ? endDate : startDate
    const [ey, em, ed] = end.split('-').map(Number)
    const evEnd = new Date(ey, (em ?? 1) - 1, ed ?? 1)
    return ev <= now && evEnd >= now
  }

  if (ev < now) return false

  const addDays = (base: Date, n: number) => { const x = new Date(base); x.setDate(x.getDate() + n); return x }

  switch (range) {
    case 'today':    return ev.getTime() === now.getTime()
    case 'tomorrow': return ev.getTime() === addDays(now, 1).getTime()
    case 'weekend': {
      // The NEXT Saturday–Sunday pair. Standing inside a weekend, "this weekend" is the one
      // being lived through (today → its Sunday), not the one seven days out.
      const dow = now.getDay()                       // 0 Sun … 6 Sat
      const sat = dow === 0 ? addDays(now, -1) : addDays(now, 6 - dow)
      const sun = addDays(sat, 1)
      return ev >= now && ev >= sat && ev <= sun
    }
    case 'week':      return ev <= addDays(now, 7)
    case 'month':     return ev.getFullYear() === now.getFullYear() && ev.getMonth() === now.getMonth()
    case 'nextmonth': {
      const nm = new Date(now.getFullYear(), now.getMonth() + 1, 1)
      return ev.getFullYear() === nm.getFullYear() && ev.getMonth() === nm.getMonth()
    }
    case 'custom': {
      // An open-ended window is legitimate (a "from" with no "to"); a window with neither
      // bound is not a filter at all, so it matches nothing rather than everything.
      if (!from && !to) return false
      if (from && startDate < from) return false
      if (to   && startDate > to)   return false
      return true
    }
    default: return true
  }
}

// Minimum active pass price (rupees) — same derivation the card uses.
function minPriceOf(pricing: Record<string, unknown> | null, isFree: boolean): number {
  if (isFree) return 0
  const passes = Array.isArray(pricing?.passes) ? (pricing!.passes as Array<Record<string, unknown>>) : []
  const prices = passes.filter(p => p.status !== 'inactive' && p.name).map(p => Number(p.price ?? 0)).filter(n => n > 0)
  return prices.length ? Math.min(...prices) : 0
}

// The ONE discovery predicate — search / category / city / free / online / date. Runs over the
// FULL published dataset via the scan, so results are complete at any scale; the browser never
// filters loaded pages. Mirrors the former client-side predicate exactly.
function matchesDiscoveryFilter(raw: Record<string, unknown>, f: {
  search: string; category: string; city: string; state: string
  free: boolean | null; online: boolean | null; venue: string
  date: string; dateFrom: string | null; dateTo: string | null
}): boolean {
  const ed = rec(raw, 'eventDetails'); const info = rec(ed, 'info'); const sched = rec(ed, 'schedule')
  const venue = rec(ed, 'venue');      const org  = rec(ed, 'organizer'); const physical = rec(venue, 'physical')
  const pricing = raw.pricing && typeof raw.pricing === 'object' ? raw.pricing as Record<string, unknown> : null

  const name      = str(info, 'name') ?? ''
  const tagline   = str(info, 'tagline') ?? ''
  const cityVal   = str(physical, 'city')
  const stateVal  = str(physical, 'state')
  const orgName   = str(org, 'name')
  const eventType = str(raw, 'eventType')
  const venueType = str(venue, 'type') ?? 'physical'
  const isFree    = pricing?.eventType === 'free'
  const startDate = str(sched, 'startDate')
  const endDate   = str(sched, 'endDate')

  if (f.search) {
    const hay = [name, tagline, cityVal, orgName, eventType].filter(Boolean).join(' ').toLowerCase()
    if (!hay.includes(f.search)) return false
  }
  if (f.category && (eventType ?? '').toLowerCase() !== f.category) return false
  if (f.city  && cityVal  !== f.city)  return false
  if (f.state && (stateVal ?? '').toLowerCase() !== f.state.toLowerCase()) return false
  if (f.free !== null)   { const fr = isFree || minPriceOf(pricing, isFree) === 0; if (f.free !== fr) return false }
  // `venue` wins when supplied — it is the only one of the two that can name 'hybrid'.
  if (f.venue)               { if (venueType !== f.venue) return false }
  else if (f.online !== null) { const on = venueType === 'online'; if (f.online !== on) return false }
  if (f.date && !matchesDateRange(startDate, f.date, f.dateFrom, f.dateTo, endDate)) return false
  return true
}

// ─── Main fetch ───────────────────────────────────────────────────────────────
//
// RD-DISCOVERY-01 Phase 1 (D-C1): the former fixed .limit(48) ceiling is gone. Published events
// are read in ONE canonical, deterministic order (publishedAt desc, docId tiebreak via
// startAfter) with cursor pagination, and search/category/city/free/online/date filter over the
// WHOLE published set (scan + in-memory post-filter, since Firestore has no substring search).
// The browser receives exactly one page + a nextCursor. Same endpoint, additive params.
export async function listPublishedEvents(opts: DiscoveryQuery | number = {}): Promise<DiscoveryData> {
  // Back-compat: a bare number is treated as the page size.
  const o = typeof opts === 'number' ? { limit: opts } as DiscoveryQuery : opts
  const pageSize = Math.min(Math.max(o.limit ?? DEFAULT_PAGE_SIZE, 1), 100)
  const filters  = {
    search:   (o.search ?? '').trim().toLowerCase(),
    category: (o.category ?? '').trim().toLowerCase(),
    city:     (o.city ?? '').trim(),
    state:    (o.state ?? '').trim(),
    free:     o.free ?? null,
    online:   o.online ?? null,
    venue:    (o.venue ?? '') || '',
    date:     (o.date ?? '') || '',
    dateFrom: o.dateFrom ?? null,
    dateTo:   o.dateTo ?? null,
  }
  const hasFilter = !!filters.search || !!filters.category || !!filters.city || !!filters.state ||
    filters.free !== null || filters.online !== null || !!filters.venue || !!filters.date

  const col  = adminDb.collection('events')
  // ONE canonical ordering — stable across pages, gap-free, duplicate-free; served by the
  // existing (lifecycleStatus, publishedAt) composite index.
  const base = col.where('lifecycleStatus', '==', 'published').orderBy('publishedAt', 'desc')

  let cursorSnap: FirebaseFirestore.DocumentSnapshot | null = null
  if (o.cursor) {
    const cs = await col.doc(o.cursor).get()
    if (cs.exists) cursorSnap = cs
  }

  let pageDocs:   FirebaseFirestore.QueryDocumentSnapshot[]
  let nextCursor: string | null

  if (!hasFilter) {
    // Fast path: one bounded page, +1 to detect a further page.
    let q = base.limit(pageSize + 1)
    if (cursorSnap) q = q.startAfter(cursorSnap)
    const snap = await q.get()
    const more = snap.docs.length > pageSize
    pageDocs   = more ? snap.docs.slice(0, pageSize) : snap.docs
    nextCursor = more ? pageDocs[pageDocs.length - 1].id : null
  } else {
    // Filter path: scan the published set in canonical order, post-filtering in memory until a
    // full page of MATCHES is collected (or the set is exhausted). Cursor = last matched slug,
    // so pages stay gap-free / duplicate-free.
    const wanted = pageSize + 1
    const matched: FirebaseFirestore.QueryDocumentSnapshot[] = []
    let scanCursor: FirebaseFirestore.DocumentSnapshot | null = cursorSnap
    for (;;) {
      let q = base.limit(SCAN_BATCH)
      if (scanCursor) q = q.startAfter(scanCursor)
      const batch = await q.get()
      if (batch.empty) break
      let filled = false
      for (const doc of batch.docs) {
        if (matchesDiscoveryFilter(doc.data() as Record<string, unknown>, filters)) {
          matched.push(doc)
          if (matched.length >= wanted) { filled = true; break }
        }
      }
      if (filled) break
      if (batch.size < SCAN_BATCH) break
      scanCursor = batch.docs[batch.docs.length - 1]
    }
    const more = matched.length > pageSize
    pageDocs   = more ? matched.slice(0, pageSize) : matched
    nextCursor = more ? pageDocs[pageDocs.length - 1].id : null
  }

  // Platform stats come from the ONE canonical resolver (D-H1) — never page-derived. Only the
  // first page (no cursor) carries them; cursor pages return empty (the client keeps the initial
  // hero values), so the O(1) aggregates run at most once per discovery view.
  const stats = (o.cursor || o.withStats === false) ? EMPTY_PLATFORM_STATS : await getPlatformStats()

  if (pageDocs.length === 0) {
    return { events: [], stats, nextCursor }
  }

  const slugs       = pageDocs.map(d => d.id)
  const counterRefs = slugs.map(s => adminDb.collection('registrationCounters').doc(s))
  const counterSnaps = await adminDb.getAll(...counterRefs)

  const counterMap = new Map<string, number>()
  for (const cs of counterSnaps) {
    if (cs.exists) {
      counterMap.set(cs.id, ((cs.data() as Record<string, unknown>).totalCount as number | undefined) ?? 0)
    }
  }

  const events: PublicEventCard[] = []

  for (const doc of pageDocs) {
    const raw = doc.data() as Record<string, unknown>
    if (!isPubliclyDiscoverable(raw)) continue
    events.push(toPublicEventCard(doc, counterMap.get(doc.id) ?? 0))
  }

  // No in-memory re-sort: events are already in the ONE canonical order (publishedAt desc)
  // that the cursor paginates by, so display order and page boundaries stay consistent. Stats
  // are the platform-wide values resolved above (D-H1), not derived from this page.
  return { events, stats, nextCursor }
}

/**
 * Is this raw event document allowed to appear in a PUBLIC listing?
 *
 * Three independent axes, and this is the one place all three are applied together:
 *
 *   moderation — an admin takedown hides the event while `lifecycleStatus` stays as it was.
 *   visibility — a PRIVATE event is published but not DISCOVERABLE. The organizer is told it
 *                is "reachable only by direct link / invite", and /events/[slug] deliberately
 *                still serves it (marked noindex).
 *   archive    — `isArchivedEvent` is the ONE archive predicate; archiving keeps publishedAt,
 *                so an archived event would otherwise sail through any "was published" filter.
 *
 * Visibility is filtered HERE rather than in the query, for the same reason sitemap.ts
 * filters it in memory: only an EXPLICIT 'private' is withheld. Events published before the
 * field existed store `null`, and `where('visibility','==','public')` would hide every one
 * of them — a regression far worse than the leak. Keeping the query to one equality filter
 * also leaves the (lifecycleStatus, publishedAt) index and the cursor strategy untouched.
 */
function isPubliclyDiscoverable(raw: Record<string, unknown>): boolean {
  if (isContentTakenDown(raw.moderationStatus as ModerationStatus | undefined)) return false
  if (raw.visibility === 'private') return false
  if (isArchivedEvent(raw)) return false
  return true
}

/**
 * One event document → the public projection. Extracted so every public listing maps a
 * document the SAME way; two copies of this would be two chances to disagree about what a
 * price, a place or a date is.
 */
function toPublicEventCard(
  doc: FirebaseFirestore.QueryDocumentSnapshot,
  totalCount: number,
): PublicEventCard {
  {
    const raw     = doc.data() as Record<string, unknown>
    const ed      = rec(raw, 'eventDetails')
    const info    = rec(ed,  'info')
    const sched   = rec(ed,  'schedule')
    const venue   = rec(ed,  'venue')
    const media   = rec(ed,  'media')
    const org     = rec(ed,  'organizer')
    const pricing = raw.pricing && typeof raw.pricing === 'object' ? raw.pricing as Record<string, unknown> : null
    const physical = rec(venue, 'physical')

    const slug = doc.id
    const city = str(physical, 'city')

    const isFreeEvent = pricing?.eventType === 'free'
    const passes = Array.isArray(pricing?.passes) ? (pricing!.passes as Array<Record<string, unknown>>) : []
    const prices  = passes
      .filter(p => p.status !== 'inactive' && p.name)
      .map(p => Number(p.price ?? 0))
      .filter(n => n > 0)
    const minPrice = isFreeEvent ? 0 : (prices.length ? Math.min(...prices) : 0)

    const formSettings = rec(raw.registrationForm as unknown, 'settings')
    const approvalMode = (formSettings.approvalMode as 'auto' | 'manual' | undefined) ?? 'auto'

    let publishedAt: string | null = null
    const pts = raw.publishedAt as { _seconds?: number; toDate?: () => Date } | null | undefined
    if (pts) {
      try {
        const d = typeof pts.toDate === 'function' ? pts.toDate() : new Date((pts._seconds ?? 0) * 1000)
        publishedAt = d.toISOString()
      } catch { /* ignore */ }
    }

    return {
      id:            slug,
      slug,
      name:          str(info, 'name') ?? 'Untitled Event',
      tagline:       str(info, 'tagline') ?? '',
      startDate:     str(sched, 'startDate'),
      endDate:       str(sched, 'endDate'),
      startTime:     str(sched, 'startTime'),
      city,
      state:         str(physical, 'state'),
      venueType:     (str(venue, 'type') as 'physical' | 'online' | 'hybrid' | null) ?? 'physical',
      eventType:     str(raw, 'eventType'),
      bannerUrl:     str(rec(media, 'coverBanner'), 'value'),
      logoUrl:       str(rec(media, 'logo'), 'value'),
      isFreeEvent,
      minPrice,
      totalCapacity: typeof raw.totalCapacity === 'number' ? raw.totalCapacity : null,
      totalCount,
      organizerName: str(org, 'name'),
      organizerLogo: str(org, 'logoUrl'),
      approvalMode,
      publishedAt,
    }
  }
}

/**
 * Recently completed public events, MOST RECENTLY COMPLETED FIRST.
 *
 * Separate from `listPublishedEvents` rather than folded into it, deliberately: that
 * function's `lifecycleStatus == 'published'` contract is relied on by /api/events and by
 * every other public listing, and widening it would silently change what those return.
 *
 * Gating is IDENTICAL to the published listing — same moderation, visibility and archive
 * predicate — so an event can only surface here if it would have been publicly listable while
 * it was still upcoming. A cancelled, unpublished, archived, private or taken-down event
 * cannot appear merely because its date passed.
 */
export async function listRecentlyCompletedEvents(
  opts: { take?: number; windowDays?: number; today?: string } = {},
): Promise<PublicEventCard[]> {
  const take       = Math.min(Math.max(opts.take ?? 4, 1), 12)
  const windowDays = Math.max(opts.windowDays ?? RECENT_COMPLETED_WINDOW_DAYS, 1)
  const today      = opts.today ?? new Date().toISOString().slice(0, 10)
  const since      = (() => {
    const d = new Date(`${today}T00:00:00.000Z`)
    d.setUTCDate(d.getUTCDate() - windowDays)
    return d.toISOString().slice(0, 10)
  })()

  const col  = adminDb.collection('events')
  // `in` over the three public states, ordered by the same canonical key the published
  // listing uses — served by the existing (lifecycleStatus, publishedAt) composite index, so
  // this adds no index requirement.
  const base = col.where('lifecycleStatus', 'in', [...PUBLIC_LIFECYCLE]).orderBy('publishedAt', 'desc')

  const matched: { doc: FirebaseFirestore.QueryDocumentSnapshot; done: string }[] = []
  let cursor: FirebaseFirestore.DocumentSnapshot | null = null
  let scanned = 0

  for (;;) {
    let q = base.limit(SCAN_BATCH)
    if (cursor) q = q.startAfter(cursor)
    const batch = await q.get()
    if (batch.empty) break

    for (const doc of batch.docs) {
      const raw = doc.data() as Record<string, unknown>
      if (!isPubliclyDiscoverable(raw)) continue
      const sched = rec(rec(raw, 'eventDetails'), 'schedule')
      // The completion boundary: end date, or start date for a single-day event — the same
      // boundary components/discovery/lib/collection.ts tests for "upcoming", so an event can
      // never be in both sections. Strictly BEFORE today: an event ending today may still be
      // running.
      const done = str(sched, 'endDate') ?? str(sched, 'startDate')
      if (!done || done >= today || done < since) continue
      matched.push({ doc, done })
    }

    scanned += batch.size
    if (batch.size < SCAN_BATCH || scanned >= MAX_COMPLETED_SCAN) break
    cursor = batch.docs[batch.docs.length - 1]
  }

  if (matched.length === 0) return []

  // Sort and slice BEFORE reading counters, so the registration-counter fetch costs exactly
  // the number of cards that will actually render.
  const top = matched
    .sort((a, b) => b.done.localeCompare(a.done))
    .slice(0, take)

  const counterSnaps = await adminDb.getAll(
    ...top.map(m => adminDb.collection('registrationCounters').doc(m.doc.id)),
  )
  const counts = new Map<string, number>()
  for (const cs of counterSnaps) {
    if (cs.exists) counts.set(cs.id, ((cs.data() as Record<string, unknown>).totalCount as number | undefined) ?? 0)
  }

  return top.map(m => toPublicEventCard(m.doc, counts.get(m.doc.id) ?? 0))
}
