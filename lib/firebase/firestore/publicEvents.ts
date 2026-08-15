// Server-only — uses Firebase Admin SDK. Never import this directly from client components.
// Use `import type { PublicEventCard, PlatformStats }` for type-only imports in client code.

import { adminDb } from '@/lib/firebase/admin'
import { organizersQuery } from '@/lib/organizer/identity'
import { isContentTakenDown } from '@/lib/admin/moderation'
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
  free?:     boolean | null
  online?:   boolean | null
  date?:     'today' | 'week' | 'month' | '' | null
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

// Server-side date-range predicate — MIRRORS the client matchesDate (DiscoveryClient) so a
// date filter behaves identically now that it runs on the server over the whole dataset.
function matchesDateRange(startDate: string | null, range: string): boolean {
  if (!range) return true
  if (!startDate) return false
  const now = new Date(); now.setHours(0, 0, 0, 0)
  const [y, m, d] = startDate.split('-').map(Number)
  const ev = new Date(y, (m ?? 1) - 1, d ?? 1)
  if (ev < now) return false
  if (range === 'today') return ev.getTime() === now.getTime()
  if (range === 'week')  { const end = new Date(now); end.setDate(end.getDate() + 7); return ev <= end }
  if (range === 'month') return ev.getFullYear() === now.getFullYear() && ev.getMonth() === now.getMonth()
  return true
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
  search: string; category: string; city: string; free: boolean | null; online: boolean | null; date: string
}): boolean {
  const ed = rec(raw, 'eventDetails'); const info = rec(ed, 'info'); const sched = rec(ed, 'schedule')
  const venue = rec(ed, 'venue');      const org  = rec(ed, 'organizer'); const physical = rec(venue, 'physical')
  const pricing = raw.pricing && typeof raw.pricing === 'object' ? raw.pricing as Record<string, unknown> : null

  const name      = str(info, 'name') ?? ''
  const tagline   = str(info, 'tagline') ?? ''
  const cityVal   = str(physical, 'city')
  const orgName   = str(org, 'name')
  const eventType = str(raw, 'eventType')
  const venueType = str(venue, 'type') ?? 'physical'
  const isFree    = pricing?.eventType === 'free'
  const startDate = str(sched, 'startDate')

  if (f.search) {
    const hay = [name, tagline, cityVal, orgName, eventType].filter(Boolean).join(' ').toLowerCase()
    if (!hay.includes(f.search)) return false
  }
  if (f.category && (eventType ?? '').toLowerCase() !== f.category) return false
  if (f.city && cityVal !== f.city) return false
  if (f.free !== null)   { const fr = isFree || minPriceOf(pricing, isFree) === 0; if (f.free !== fr) return false }
  if (f.online !== null) { const on = venueType === 'online'; if (f.online !== on) return false }
  if (f.date && !matchesDateRange(startDate, f.date)) return false
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
    free:     o.free ?? null,
    online:   o.online ?? null,
    date:     (o.date ?? '') || '',
  }
  const hasFilter = !!filters.search || !!filters.category || !!filters.city ||
    filters.free !== null || filters.online !== null || !!filters.date

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
  const stats = o.cursor ? EMPTY_PLATFORM_STATS : await getPlatformStats()

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
    const raw     = doc.data() as Record<string, unknown>
    // Exclude admin-taken-down events from public discovery (lifecycleStatus
    // stays 'published'; moderation is a separate axis).
    if (isContentTakenDown(raw.moderationStatus as ModerationStatus | undefined)) continue
    // A PRIVATE event is published but not DISCOVERABLE — the organizer is told it is
    // "reachable only by direct link / invite", and /events/[slug] deliberately still
    // serves it (marked noindex). Visibility is therefore a third axis, independent of
    // lifecycle and moderation, and it was the one this listing never applied.
    //
    // Filtered HERE rather than in the query, for the same reason sitemap.ts filters it in
    // memory: only an EXPLICIT 'private' is withheld. Events published before the field
    // existed store `null`, and `where('visibility','==','public')` would hide every one of
    // them — a regression far worse than the leak. Keeping one equality filter also leaves
    // the (lifecycleStatus, publishedAt) index and the cursor strategy untouched.
    if (raw.visibility === 'private') continue
    const ed      = rec(raw, 'eventDetails')
    const info    = rec(ed,  'info')
    const sched   = rec(ed,  'schedule')
    const venue   = rec(ed,  'venue')
    const media   = rec(ed,  'media')
    const org     = rec(ed,  'organizer')
    const pricing = raw.pricing && typeof raw.pricing === 'object' ? raw.pricing as Record<string, unknown> : null
    const physical = rec(venue, 'physical')

    const slug       = doc.id
    const totalCount = counterMap.get(slug) ?? 0
    const city       = str(physical, 'city')

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

    events.push({
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
    })
  }

  // No in-memory re-sort: events are already in the ONE canonical order (publishedAt desc)
  // that the cursor paginates by, so display order and page boundaries stay consistent. Stats
  // are the platform-wide values resolved above (D-H1), not derived from this page.
  return { events, stats, nextCursor }
}
