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
import { authorizeAnyWorkspace }     from '@/lib/team/workspace'

import { getEventStats, sumConfirmedRevenueFromLedgerChecked } from '@/lib/firebase/firestore/registrationCounters'
import { parseListingTab, eventInListingTab, effectiveLifecycleStatus } from '@/lib/events/listingTabs'
import { LICENSE_ORDERS_COLLECTION } from '@/lib/licensing/schema'
import { revenueStateFrom, toConfirmedRevenueFields } from '@/lib/finance/revenueState'
import type { EventLifecycleStatus } from '@/types/events'
import { resolveOwnedEvents } from '@/lib/events/liveEventRef'
import { resolveEventCapacitySummary } from '@/lib/registrations/capacity'

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
  /** RD-MEDIA-02: already stored on the draft; projected so consumers can resolve an
   *  event-type template (e.g. gallery suggestions) without a second read. Additive. */
  eventSubtype:       string | null
  campaignType:       string | null
  isFreeEvent:        boolean
  totalCapacity:      number | null
  totalRegistrations: number
  /**
   * RD-ANALYTICS-12-19 · THE CANONICAL NAME for this figure.
   *
   * Canonical confirmed ticket revenue in integer PAISE: Σ `amount` over registrations
   * with `status === 'confirmed'`. Refund-stable — a refund changes neither the status
   * nor the amount — so this answers "what did this event sell", never "what did it keep".
   *
   * ═══ THE SAME NAME EXISTS IN ANALYTICS, AND IT IS NOT THE SAME SHAPE ═══════
   * `EventAnalytics.financial.confirmedRevenuePaise` is the same QUANTITY under the same
   * definition, permission and unit — but it is a `MaybeMoney` (`{ok,paise}｜{ok,reason}`),
   * and it is ABSENT entirely for a caller without `transactions` rather than null.
   *
   * They also differ in SOURCE on the common path, which is worth knowing before treating
   * a mismatch as a bug: Analytics always issues the live ledger aggregate, while this
   * route prefers the denormalized `registrationCounters.revenuePaise` and falls back to
   * that same aggregate only when the counter is not current (`statsVersion`). The two
   * reconcile by construction — the counter is a maintained cache of exactly that sum —
   * and `complete` is what refuses the cache when it cannot be trusted.
   *
   * Three states, none collapsible (RD-ANALYTICS-12-17):
   *   number  · measured. `0` means the event earned nothing.
   *   number + `revenueUnavailable: true` · the read failed; do not believe the 0.
   *   null    · the caller lacks `transactions`. NOT zero, NOT unavailable.
   */
  confirmedRevenuePaise: number | null
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

  // ── RD-EVENT-02 (H1/H2) · availability flags — ADDITIVE, never load-bearing ──
  // The numeric fields above keep their types and their existing values so all eight
  // consumers of this endpoint are unaffected. These flags say whether those numbers
  // were actually READ or merely defaulted, so a surface that cares can render "—"
  // instead of asserting a zero it does not know. Absent/false ⇒ the number is real.
  /** `totalRegistrations` and `passes[].sold` could not be read for this event. */
  statsUnavailable?:   boolean
  /** `confirmedRevenuePaise` could not be resolved for this event. */
  revenueUnavailable?: boolean
  /** The licence-order read failed, so `hasPaidLicense` is UNKNOWN (not "false").
   *  A client must withhold paid-gated affordances; the delete API stays authoritative. */
  licenseUnavailable?: boolean
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
  /**
   * RD-ANALYTICS-12-15 · was `authorizeWorkspace(req, 'events')`.
   *
   * ═══ WHY THIS ONE HAD TO MOVE TOO ════════════════════════════════════════════
   * This is the ONLY source of the workspace event list: `EventContextProvider` makes
   * exactly one call to it and every event-scoped surface reads the selection from there.
   * So a role that cannot call this route has no event to select — and Analytics is
   * event-scoped. Reconciling the analytics routes alone would have given `finance` a
   * working API and an empty selector, which is worse than an honest refusal.
   *
   * ═══ WHY THIS IS SAFE, STATED IN FULL ════════════════════════════════════════
   * This is the one genuinely debatable change in RD-ANALYTICS-12-15, because unlike the
   * analytics routes this endpoint is shared by a dozen surfaces. Each claim below was
   * checked rather than assumed:
   *
   *   • GET is the only exported method here. There is no mutation to widen — every
   *     `.set(`/`.add(` in this file is a Map or Set, not a write.
   *   • Reads are scoped to `users/{authz.workspaceUid}/eventDrafts`. Tenancy is proven by
   *     the PATH and comes from the session, so no caller can widen the result set.
   *   • NOT used by Admin. Repository search finds zero references under app/(admin), so
   *     Admin authorization is untouched by construction.
   *   • The delta is exactly ONE role. `authorizeAnyWorkspace` admits non-gate members:
   *     owner, admin and manager already held `events`; gate-only roles are still refused,
   *     now by `isCheckinOnlyRole`. Only `finance` is added.
   *   • `finance` gains no new CLASS of data. The payload's one money field,
   *     `confirmedRevenuePaise`, is exactly what `transactions` protects elsewhere — and finance
   *     holds `transactions`. The counts are aggregates it already receives from
   *     /api/organizer/dashboard today.
   *   • Every consumer keeps its own guard. Reaching this list has never been permission to
   *     act on an event: publish, edit, cancel, pricing and waitlist all still require
   *     `events` on their own routes, and none of them changed.
   *
   * ═══ WHAT THIS DID NOT FIX (SUPERSEDED — fixed by RD-ANALYTICS-12-17, below) ═══
   * As written in 12-15, the money field was returned unconditionally, so `admin` and `manager` — who hold no
   * `transactions` — receive a per-event money figure here while being refused money
   * everywhere else. That is PRE-EXISTING, is not made worse by this change (both roles
   * already reached this route), and is the same defect class as the legacy dashboard's
   * ungated `attendeeName`. It belongs with RD-ANALYTICS-12-16, not here: fixing a money
   * boundary inside an authorization-reconciliation diff would mix two changes that need
   * separate review.
   */
  const authz = await authorizeAnyWorkspace(req)
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  const uid = authz.workspaceUid

  /**
   * RD-ANALYTICS-12-17 · the financial boundary, declared before the reads it gates.
   *
   * This figure is canonical confirmed revenue, and this route
   * returned it to every workspace member — so `admin` and `manager`, neither of whom holds
   * `transactions`, read a per-event money figure that /api/organizer/finance refuses them
   * and that Analytics withholds. The SAME figure has been gated on
   * /api/organizer/dashboard since RD-DASH-12: two endpoints, one data class, two answers.
   *
   * This is the same permission that endpoint uses, so the two now agree.
   */
  const financeAllowed = authz.permissions.includes('transactions')

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
        if (eventInListingTab(effectiveLifecycleStatus(d), tab) && draftMatchesSearch(d, searchTerm)) {
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
  // RD-CE-FIX C1 · only slugs the live documents prove belong to THIS workspace's drafts (one getAll):
  // the draft pointer is client-writable, and the counters/revenue below are keyed by slug alone.
  // RD-FIN-02 · the same one getAll, keeping the live event data it read (enforced capacity).
  const ownedEvents = await resolveOwnedEvents(uid, pageDocs.map(doc => ({ id: doc.id, data: doc.data() as Record<string, unknown> })))
  const ownedSlugs  = new Map([...ownedEvents].map(([id, v]) => [id, v.slug] as [string, string]))
  const slugList: string[] = []
  pageDocs.forEach(doc => {
    const d    = doc.data() as Record<string, unknown>
    const slug = ownedSlugs.get(doc.id)
    if (d.status === 'published' && slug) slugList.push(slug)
  })

  // Counts AND revenue come from registrationCounters via getEventStats — the SAME
  // canonical resolver the Dashboard uses (RD-EVENTS-01 Phase 1 / H1). Revenue is the
  // refund-stable confirmed revenuePaise when the counter is complete, else the
  // source-of-truth ledger sum (sumConfirmedRevenueFromLedger). The former
  // Σ(pass.price × pass.sold) estimate is gone, so Events, Event Details, Dashboard
  // and Finance report one revenue truth.
  const counterMap = new Map<string, { totalCount: number; passCounts: Record<string, number> }>()
  const revBySlug  = new Map<string, number>()
  // RD-EVENT-02 (H1/H2) · which slugs could NOT be read. A slug in one of these sets
  // has no trustworthy number, which is a different fact from "its number is zero".
  const statsFailed = new Set<string>()
  const revFailed   = new Set<string>()

  // RD-EVENT-02 (H2) · per-event failure isolation. Previously a single unreadable
  // counter rejected this `Promise.all` and 500'd the WHOLE list, taking every healthy
  // event down with it. Each read now settles independently: one bad event costs that
  // event's metrics and nothing else. The reads are NOT retried, so isolation cannot
  // multiply the read count — it is the same one read per event either way.
  const loadCounters = async () => {
    if (slugList.length === 0) return
    const statsList = await Promise.all(
      slugList.map(s => getEventStats(s).then(
        value => ({ ok: true as const, value }),
        ()    => ({ ok: false as const, value: null }),
      )),
    )
    const incompleteSlugs: string[] = []
    statsList.forEach((res, i) => {
      const slug = slugList[i]
      if (!res.ok || !res.value) {
        // Unknown, not zero. `counterMap` stays unset so the response builder below
        // falls back to 0 for wire compatibility while the flag tells the truth.
        statsFailed.add(slug)
        revFailed.add(slug)
        return
      }
      const st = res.value
      const c  = st.counter
      counterMap.set(slug, { totalCount: c?.totalCount ?? 0, passCounts: c?.passCounts ?? {} })
      if (st.complete) revBySlug.set(slug, c?.revenuePaise ?? 0)
      else             incompleteSlugs.push(slug)
    })
    // Legacy / not-yet-backfilled counters: recompute revenue from the ledger (one
    // indexed aggregate each, empty in steady state after reconciliation). The
    // `Checked` variant is the SAME aggregate and the SAME revenue definition — it
    // just distinguishes "the sum is 0" from "the sum could not be taken".
    /**
     * RD-ANALYTICS-12-17 · `financeAllowed &&` — an unauthorized caller does not pay for
     * these reads either.
     *
     * `getEventStats` above cannot be skipped: it returns the registration COUNTS in the
     * same read, and those are not financial. This aggregate is purely the money fallback,
     * so for a caller who may not see money it is not issued at all — the dashboard's rule
     * ("an unauthorized caller must not cost the workspace those queries") applied to the
     * one read here that is exclusively financial.
     */
    if (financeAllowed && incompleteSlugs.length > 0) {
      const sums = await Promise.all(
        incompleteSlugs.map(s => sumConfirmedRevenueFromLedgerChecked(s).catch(
          () => ({ value: 0, ok: false }),
        )),
      )
      incompleteSlugs.forEach((s, i) => {
        if (sums[i].ok) revBySlug.set(s, sums[i].value)
        else            revFailed.add(s)
      })
    }
  }

  // ── Paid-license flags (Phase L1) ──────────────────────────────────────────
  // A draft backed by a PAID license order must not offer permanent delete.
  // The order id is deterministic (`lic_{draftId}`) so this is a batched read
  // of existing licensing records — no new collection, no write.
  //
  // RD-EVENT-02 (§23) · N individual `.get()` round trips became ONE `getAll`, the
  // same batching the dashboard uses (app/api/organizer/dashboard/route.ts). Identical
  // documents, identical semantics, one round trip instead of N.
  const paidDraftIds = new Set<string>()
  let licenseReadFailed = false
  const loadLicenses = async () => {
    if (pageDocs.length === 0) return
    const refs = pageDocs.map(doc =>
      adminDb.collection(LICENSE_ORDERS_COLLECTION).doc(`lic_${doc.id}`))
    const orderSnaps = await adminDb.getAll(...refs).catch(() => null)
    if (!orderSnaps) {
      // getAll is all-or-nothing, so this is a page-level unknown rather than a
      // per-event one. Reported honestly instead of silently reading as "not paid".
      licenseReadFailed = true
      return
    }
    orderSnaps.forEach((snap, i) => {
      if (snap.exists && (snap.data() as { status?: unknown }).status === 'paid') {
        paidDraftIds.add(pageDocs[i].id)
      }
    })
  }

  // The counter wave and the licence wave read disjoint collections and neither
  // depends on the other, so they share one round trip instead of queueing.
  await Promise.all([loadCounters(), loadLicenses()])

  // ── Build response ─────────────────────────────────────────────────────────
  const events: EventListItem[] = pageDocs.map(doc => {
    const d       = doc.data() as Record<string, unknown>
    const details = (d.eventDetails as Record<string, unknown>) ?? {}
    const info    = (details.info     as Record<string, unknown>) ?? {}
    const sched   = (details.schedule as Record<string, unknown>) ?? {}
    const media   = (details.media    as Record<string, unknown>) ?? {}

    const slug      = ownedSlugs.get(doc.id) ?? null
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
    // NOT the former Σ(pass.price × pass.sold) estimate. The name now says what it is.
    //
    // RD-ANALYTICS-12-17 · null for a caller without `transactions`. The CALCULATION is
    // untouched — this gates who is told the answer, it does not compute a different one.
    /**
     * RD-ANALYTICS-12-22 · ONE state, serialized once.
     *
     * This used to be two hand-built expressions — a ternary for the figure and another for
     * the flag — which is the shape that let the dashboard publish an unmeasured figure as a
     * confident ₹0 (RD-12-20 F1). Both fields now come from a single `RevenueState`, so
     * "unavailable with the flag false" is not something this route can express.
     *
     * The inputs are unchanged: entitlement first, then the failure Set, then the figure.
     * An UNPUBLISHED event has no slug and therefore no counter to read — its zero is a real
     * zero, never a failed read (RD-EVENT-02 H1).
     */
    const revenueState = revenueStateFrom({
      financeAllowed,
      unavailable: slug ? revFailed.has(slug) : false,
      paise:       slug ? (revBySlug.get(slug) ?? 0) : 0,
    })

    const statsUnavailable   = slug ? statsFailed.has(slug) : false

    return {
      draftId:            doc.id,
      status:             (d.status as 'draft' | 'published') ?? 'draft',
      // ARCHIVE-ACCURATE. `deriveLifecycleStatus` alone cannot report 'archived' for an event
      // archived before `lifecycleStatus` existed: archiving also writes the legacy
      // `status: 'draft'`, so the derivation returns THAT and the event reads as a draft
      // forever. Every consumer of this payload — the Registrations picker, the Reports
      // picker, the events tabs — then treats a legacy archived event as live. Correcting it
      // HERE fixes all of them at the data boundary rather than repeating the predicate in
      // each client, which could not run it anyway: `archivedAt` is not part of this payload.
      lifecycleStatus:    effectiveLifecycleStatus(d),
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
      eventSubtype:       typeof d.eventSubtype === 'string' ? d.eventSubtype : null,
      campaignType:       typeof d.campaignType === 'string' ? d.campaignType : null,
      isFreeEvent:        isFree,
      // RD-FIN-02 · the ENFORCED capacity of the live event (the gate's own value) — never the
      // client-writable draft pass sums. An unpublished draft shows its intended capacity.
      totalCapacity:      resolveEventCapacitySummary({
        eventDoc:    ownedEvents.get(doc.id)?.data ?? null,
        counter:     counter ?? null,
        draftIntent: d.status === 'published' ? undefined : d.registrationCapacity,
      }).total,
      totalRegistrations: counter?.totalCount ?? 0,
      ...toConfirmedRevenueFields(revenueState),
      passes,
      updatedAt:          toIso(d.updatedAt)   ?? new Date().toISOString(),
      publishedAt:        toIso(d.publishedAt),
      reviewStatus:       d.reviewStatus === 'rejected' || d.reviewStatus === 'changes_requested' ? d.reviewStatus : null,
      rejectionReason:    typeof d.rejectionReason === 'string' && d.rejectionReason ? d.rejectionReason : null,
      changesComment:     typeof d.changesComment  === 'string' && d.changesComment  ? d.changesComment  : null,
      hasPaidLicense:     paidDraftIds.has(doc.id),
      statsUnavailable,
      licenseUnavailable: licenseReadFailed,
    }
  })

  return NextResponse.json({ events, nextCursor } satisfies EventsListResponse)
}
