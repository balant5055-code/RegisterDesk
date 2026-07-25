// GET /api/organizer/events
//
// Returns the authenticated organizer's event drafts, cursor-paginated and enriched
// with canonical registration/revenue data. Query params:
//   cursor  — last draftId of the previous page (forward cursor pagination)
//   limit   — page size (1..100, default 25)
//   tab     — active | published | drafts | archived (server-authoritative lifecycle filter)
//   search  — substring over title/slug/organization/location (server-authoritative)
// tab/search are applied server-side over the WHOLE dataset (RD-EVENTS-01 Phase 2 / H2),
// so results are authoritative regardless of how many events the organizer owns.

import { NextRequest, NextResponse } from 'next/server'
import { adminDb }                   from '@/lib/firebase/admin'
import { authorizeWorkspace }        from '@/lib/team/workspace'
import { deriveLifecycleStatus }     from '@/lib/events/lifecycle'
import { getEventStats, sumConfirmedRevenueFromLedger } from '@/lib/firebase/firestore/registrationCounters'
import { parseListingTab, eventInListingTab } from '@/lib/events/listingTabs'
import { LICENSE_ORDERS_COLLECTION } from '@/lib/licensing/schema'
import type { EventLifecycleStatus } from '@/types/events'

// ─── Shared types ─────────────────────────────────────────────────────────────

export interface EventPassSummary {
  id:       string
  name:     string
  price:    number       // paise; 0 = free
  capacity: number | null
  sold:     number
}

export interface EventListItem {
  draftId:            string
  status:             'draft' | 'published'
  lifecycleStatus:    EventLifecycleStatus
  name:               string
  slug:               string | null
  tagline:            string | null
  startDate:          string | null
  endDate:            string | null
  bannerUrl:          string | null
  eventType:          string | null
  campaignType:       string | null
  isFreeEvent:        boolean
  totalCapacity:      number | null
  totalRegistrations: number
  estimatedRevenue:   number         // paise — CANONICAL confirmed revenue (registrationCounters.revenuePaise / ledger fallback); field name kept for contract stability
  passes:             EventPassSummary[]
  updatedAt:          string
  publishedAt:        string | null
  // Admin review outcome (F1.2) — surfaced so the organizer can see why an event
  // was returned and resubmit it.
  reviewStatus:       'rejected' | 'changes_requested' | null
  rejectionReason:    string | null
  changesComment:     string | null
  // Phase L1 — true when a PAID license order exists for this event. Drives the
  // organizer UI to hide the permanent-delete affordance for paid events
  // (the delete API is the authoritative guard). Optional/absent ⇒ not paid.
  hasPaidLicense?:    boolean
}

export interface EventsListResponse {
  events:     EventListItem[]
  nextCursor: string | null   // pass back as ?cursor= to load the next page; null = no more
}

// ─── Helper ───────────────────────────────────────────────────────────────────

function toIso(val: unknown): string | null {
  if (!val) return null
  if (typeof val === 'object' && 'toDate' in (val as object)) {
    return (val as { toDate: () => Date }).toDate().toISOString()
  }
  return null
}

// RD-EVENTS-01 Phase 2 (H2): the server-authoritative search predicate. Builds a lowercase
// haystack from the searchable fields that ALREADY exist on an event draft — title (name),
// slug, organization and location — and tests substring containment. No full-text infra; this
// is the ONE search implementation (the client no longer filters its loaded pages).
function draftMatchesSearch(d: Record<string, unknown>, term: string): boolean {
  if (!term) return true
  const details = (d.eventDetails as Record<string, unknown>) ?? {}
  const info    = (details.info      as Record<string, unknown>) ?? {}
  const seo     = (details.seo       as Record<string, unknown>) ?? {}
  const org     = (details.organizer as Record<string, unknown>) ?? {}
  const venue   = (details.venue     as Record<string, unknown>) ?? {}
  const phys    = (venue.physical    as Record<string, unknown>) ?? {}
  const hay = [info.name, seo.urlSlug, org.name, phys.name, phys.city, phys.addressLine1]
    .filter((v): v is string => typeof v === 'string')
    .join(' ')
    .toLowerCase()
  return hay.includes(term)
}

// ─── Handler ──────────────────────────────────────────────────────────────────

const DEFAULT_PAGE_SIZE = 25

export async function GET(req: NextRequest): Promise<NextResponse> {
  const authz = await authorizeWorkspace(req, 'events')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  const uid = authz.workspaceUid

  // ── Cursor pagination (cursor = the last draftId from the previous page) ────
  const url        = new URL(req.url)
  const cursorId   = url.searchParams.get('cursor')
  const limitParam = Number(url.searchParams.get('limit'))
  const pageSize   = Number.isFinite(limitParam) && limitParam > 0 && limitParam <= 100
    ? Math.floor(limitParam)
    : DEFAULT_PAGE_SIZE

  // ── Server-authoritative tab + search (RD-EVENTS-01 Phase 2 / H2) ──────────
  const tab        = parseListingTab(url.searchParams.get('tab'))
  const searchTerm = (url.searchParams.get('search') ?? '').trim().toLowerCase()
  const hasFilter  = tab !== null || searchTerm.length > 0

  const draftsCol = adminDb.collection(`users/${uid}/eventDrafts`)

  // Cursor = the last returned draftId (same contract for both paths). Resolve it once.
  let cursorSnap: FirebaseFirestore.DocumentSnapshot | null = null
  if (cursorId) {
    const cs = await draftsCol.doc(cursorId).get()
    if (cs.exists) cursorSnap = cs
  }

  let pageDocs:   FirebaseFirestore.QueryDocumentSnapshot[]
  let nextCursor: string | null

  if (!hasFilter) {
    // Fast path (no tab/search): unchanged — one bounded page, +1 to detect more.
    let query = draftsCol.orderBy('updatedAt', 'desc')
    if (cursorSnap) query = query.startAfter(cursorSnap)
    const pageSnap = await query.limit(pageSize + 1).get()
    if (pageSnap.empty) {
      return NextResponse.json({ events: [], nextCursor: null } satisfies EventsListResponse)
    }
    const more = pageSnap.docs.length > pageSize
    pageDocs   = more ? pageSnap.docs.slice(0, pageSize) : pageSnap.docs
    nextCursor = more ? pageDocs[pageDocs.length - 1].id : null
  } else {
    // Filter path: scan the organizer's OWN drafts (updatedAt desc, bounded internal
    // batches), post-filtering by tab (deriveLifecycleStatus → listing tab) AND search,
    // until a full page of MATCHES is collected — or the collection is exhausted. Only the
    // matched page is enriched + returned, so the BROWSER never loads the whole dataset even
    // at 50k events; the cursor (last matched draftId) resumes the scan exactly where it left
    // off, so matches (a subsequence of updatedAt-desc order) stay gap-free and duplicate-free.
    const SCAN_BATCH = 300
    const wanted     = pageSize + 1   // one extra match to detect a further page
    const matched: FirebaseFirestore.QueryDocumentSnapshot[] = []
    let scanCursor: FirebaseFirestore.DocumentSnapshot | null = cursorSnap
    for (;;) {
      let q = draftsCol.orderBy('updatedAt', 'desc').limit(SCAN_BATCH)
      if (scanCursor) q = q.startAfter(scanCursor)
      const batch = await q.get()
      if (batch.empty) break
      let filled = false
      for (const doc of batch.docs) {
        const d = doc.data() as Record<string, unknown>
        if (eventInListingTab(deriveLifecycleStatus(d), tab) && draftMatchesSearch(d, searchTerm)) {
          matched.push(doc)
          if (matched.length >= wanted) { filled = true; break }
        }
      }
      if (filled) break
      if (batch.size < SCAN_BATCH) break          // collection exhausted
      scanCursor = batch.docs[batch.docs.length - 1]
    }
    if (matched.length === 0) {
      return NextResponse.json({ events: [], nextCursor: null } satisfies EventsListResponse)
    }
    const more = matched.length > pageSize
    pageDocs   = more ? matched.slice(0, pageSize) : matched
    nextCursor = more ? pageDocs[pageDocs.length - 1].id : null
  }

  // ── Collect slugs for published events, then batch-fetch counters ──────────
  const slugList: string[] = []
  pageDocs.forEach(doc => {
    const d    = doc.data() as Record<string, unknown>
    const slug = ((d.eventDetails as Record<string, unknown>)?.seo as Record<string, unknown>)?.urlSlug
    if (d.status === 'published' && typeof slug === 'string') slugList.push(slug)
  })

  // Counts AND revenue come from registrationCounters via getEventStats — the SAME
  // canonical resolver the Dashboard uses (RD-EVENTS-01 Phase 1 / H1). Revenue is the
  // refund-stable confirmed revenuePaise when the counter is complete, else the
  // source-of-truth ledger sum (sumConfirmedRevenueFromLedger). The former
  // Σ(pass.price × pass.sold) estimate is gone, so Events, Event Details, Dashboard
  // and Finance report one revenue truth.
  const counterMap = new Map<string, { totalCount: number; passCounts: Record<string, number> }>()
  const revBySlug  = new Map<string, number>()
  if (slugList.length > 0) {
    const statsList = await Promise.all(slugList.map(s => getEventStats(s)))
    const incompleteSlugs: string[] = []
    statsList.forEach((st, i) => {
      const slug = slugList[i]
      const c    = st.counter
      counterMap.set(slug, { totalCount: c?.totalCount ?? 0, passCounts: c?.passCounts ?? {} })
      if (st.complete) revBySlug.set(slug, c?.revenuePaise ?? 0)
      else             incompleteSlugs.push(slug)
    })
    // Legacy / not-yet-backfilled counters: recompute revenue from the ledger (one
    // indexed aggregate each, empty in steady state after reconciliation).
    if (incompleteSlugs.length > 0) {
      const sums = await Promise.all(incompleteSlugs.map(s => sumConfirmedRevenueFromLedger(s)))
      incompleteSlugs.forEach((s, i) => revBySlug.set(s, sums[i]))
    }
  }

  // ── Paid-license flags (Phase L1) ──────────────────────────────────────────
  // A draft backed by a PAID license order must not offer permanent delete.
  // The order id is deterministic (`lic_{draftId}`) so this is a batched read
  // of existing licensing records — no new collection, no write.
  const paidDraftIds = new Set<string>()
  const orderSnaps = await Promise.all(
    pageDocs.map(doc => adminDb.collection(LICENSE_ORDERS_COLLECTION).doc(`lic_${doc.id}`).get()),
  )
  orderSnaps.forEach((snap, i) => {
    if (snap.exists && (snap.data() as { status?: unknown }).status === 'paid') {
      paidDraftIds.add(pageDocs[i].id)
    }
  })

  // ── Build response ─────────────────────────────────────────────────────────
  const events: EventListItem[] = pageDocs.map(doc => {
    const d       = doc.data() as Record<string, unknown>
    const details = (d.eventDetails as Record<string, unknown>) ?? {}
    const info    = (details.info     as Record<string, unknown>) ?? {}
    const seo     = (details.seo      as Record<string, unknown>) ?? {}
    const sched   = (details.schedule as Record<string, unknown>) ?? {}
    const media   = (details.media    as Record<string, unknown>) ?? {}

    const slug      = typeof seo.urlSlug === 'string' ? seo.urlSlug : null
    const counter   = slug ? counterMap.get(slug) : undefined
    const isFree    = (d.pricing as Record<string, unknown>)?.eventType === 'free'
    const rawPasses = ((d.pricing as Record<string, unknown>)?.passes as unknown[]) ?? []

    const passes: EventPassSummary[] = rawPasses.map((p: unknown) => {
      const pass = p as Record<string, unknown>
      const id   = typeof pass.id   === 'string' ? pass.id   : ''
      return {
        id,
        name:     typeof pass.name     === 'string'  ? pass.name     : 'Pass',
        price:    typeof pass.price    === 'number'  ? pass.price    : 0,
        capacity: pass.unlimited ? null : (typeof pass.quantity === 'number' ? pass.quantity : null),
        sold:     counter?.passCounts?.[id] ?? 0,
      }
    })

    // Canonical confirmed revenue (registrationCounters.revenuePaise / ledger fallback),
    // NOT the former Σ(pass.price × pass.sold) estimate. Field name kept for contract
    // stability; the value is now the platform's one revenue truth.
    const estimatedRevenue = slug ? (revBySlug.get(slug) ?? 0) : 0

    return {
      draftId:            doc.id,
      status:             (d.status as 'draft' | 'published') ?? 'draft',
      lifecycleStatus:    deriveLifecycleStatus(d),
      name:               typeof info.name     === 'string' ? info.name    : 'Untitled Event',
      slug,
      tagline:            typeof info.tagline  === 'string' ? info.tagline : null,
      startDate:          typeof sched.startDate === 'string' ? sched.startDate : null,
      endDate:            typeof sched.endDate   === 'string' ? sched.endDate   : null,
      // coverBanner is a MediaAsset { source, value } — read .value like the
      // dashboard + single-event routes do (a bare-string read is always null).
      bannerUrl:          typeof (media.coverBanner as Record<string, unknown> | undefined)?.value === 'string'
        ? ((media.coverBanner as Record<string, unknown>).value as string)
        : null,
      eventType:          typeof d.eventType    === 'string' ? d.eventType    : null,
      campaignType:       typeof d.campaignType === 'string' ? d.campaignType : null,
      isFreeEvent:        isFree,
      // Real capacity: sum of pass capacities; null when any pass is unlimited
      // (or there are no passes) — never a hardcoded number.
      totalCapacity:      passes.length > 0 && passes.every(p => p.capacity !== null)
        ? passes.reduce((sum, p) => sum + (p.capacity ?? 0), 0)
        : null,
      totalRegistrations: counter?.totalCount ?? 0,
      estimatedRevenue,
      passes,
      updatedAt:          toIso(d.updatedAt)   ?? new Date().toISOString(),
      publishedAt:        toIso(d.publishedAt),
      reviewStatus:       d.reviewStatus === 'rejected' || d.reviewStatus === 'changes_requested' ? d.reviewStatus : null,
      rejectionReason:    typeof d.rejectionReason === 'string' && d.rejectionReason ? d.rejectionReason : null,
      changesComment:     typeof d.changesComment  === 'string' && d.changesComment  ? d.changesComment  : null,
      hasPaidLicense:     paidDraftIds.has(doc.id),
    }
  })

  return NextResponse.json({ events, nextCursor } satisfies EventsListResponse)
}
