// GET /api/organizer/dashboard
//
// Single aggregation endpoint for the organizer dashboard.
// Runs all Firestore reads in parallel and returns a structured payload.
// Called once on page load; the page derives all sections from this response.

import { NextRequest, NextResponse } from 'next/server'
import { AggregateField }            from 'firebase-admin/firestore'
import { adminDb }                   from '@/lib/firebase/admin'
import { authorizeAnyWorkspace }     from '@/lib/team/workspace'
import { ensureOrganizerProfile }    from '@/lib/organizer/ensureProfile'
import { deriveLifecycleStatus } from '@/lib/events/lifecycle'
import { isArchivedTabEvent } from '@/lib/events/listingTabs'
import { getWalletBalance }          from '@/lib/firebase/firestore/wallet'
import { getFreeEventCapacity }      from '@/lib/licensing/resolveCatalog'
import type { OrganizerRevenueWallet } from '@/lib/fees/types'
import { EVENT_STATS_VERSION }       from '@/lib/registrations/types'
import type { RegistrationDocument, RegistrationCounter } from '@/lib/registrations/types'
import { aggregateRegistrationStatusCounts } from '@/lib/firebase/firestore/registrationCounters'
import type { RegistrationStatusCounts }     from '@/lib/firebase/firestore/registrationCounters'
import { aggregateCancelledByPass, aggregateWaitlistedCount } from '@/lib/analytics/registrationPassAggregates'
import { getOrganizerCouponPerformance, EMPTY_ORGANIZER_COUPON_PERFORMANCE } from '@/lib/analytics/couponPerformance'
import type { OrganizerCouponPerformance } from '@/lib/analytics/couponPerformance'
import { buildDashboardAnalytics } from '@/lib/analytics/dashboardAnalytics'
import type { PassRow, RegistrationTotals } from '@/lib/analytics/dashboardAnalytics'

/**
 * Ceiling on per-pass cancelled aggregates for ONE dashboard load (events × passes).
 *
 * Cancelled-by-pass costs one count() per (event, pass), so an organizer with many events
 * each carrying many passes could otherwise fire hundreds of queries per render. Events with
 * zero cancellations are skipped entirely, so in practice this is rarely approached — and
 * when it is, the affected events report "unavailable" rather than a fabricated zero.
 */
const PASS_AGGREGATE_BUDGET = 120

// ─── Utilities ────────────────────────────────────────────────────────────────

function tsToDate(ts: unknown): Date | null {
  if (!ts) return null
  if (typeof (ts as { toDate?: () => Date }).toDate === 'function') {
    return (ts as { toDate: () => Date }).toDate()
  }
  return null
}

function isToday(ts: unknown): boolean {
  const d = tsToDate(ts)
  if (!d) return false
  const n = new Date()
  return d.getFullYear() === n.getFullYear() &&
         d.getMonth()    === n.getMonth()    &&
         d.getDate()     === n.getDate()
}

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// ─── Response types (exported for the page to import) ─────────────────────────

export interface DashboardAlert {
  type:      'nearly_full' | 'comm_payment_pending' | 'cert_missing' | 'reg_closing_soon'
  severity:  'critical' | 'warning'
  title:     string
  meta:      string
  eventSlug: string | null
}

export interface DashboardEvent {
  draftId:         string
  name:            string
  slug:            string | null
  registered:      number
  capacity:        number | null
  fillPct:         number
  startDate:       string | null
  lifecycleStatus: string
  reviewStatus:    'rejected' | 'changes_requested' | null
  licenseTier:     string
  bannerUrl:       string | null
  revenuePaise:    number
}

export interface DashboardTransaction {
  id:           string
  type:         string
  amountPaise:  number
  balancePaise: number
  description:  string
  createdAt:    string | null
}

export interface DashboardActionEvent {
  draftId:         string
  name:            string
  slug:            string | null
  lifecycleStatus: string
  reviewStatus:    'rejected' | 'changes_requested' | null
}

export interface DashboardActivity {
  type:          'registration' | 'checkin'
  attendeeName:  string
  attendeeEmail: string
  eventName:     string
  passName:      string
  timestamp:     string   // ISO 8601
}

export interface DashboardData {
  organizer: {
    name:    string
    orgName: string
    logoUrl: string | null
  }
  overview: {
    activeEvents:       number
    totalRegistrations: number
    totalRevenuePaise:  number
    todayRevenuePaise:  number
    todayRegistrations: number
    todayCheckins:      number
    monthRevenuePaise:  number   // current calendar month-to-date (confirmed)
    monthRegistrations: number   // current calendar month-to-date (confirmed)
  }
  alerts:     DashboardAlert[]
  settlement: {
    grossRevenuePaise:       number
    platformFeePaise:        number
    platformFeeRateBps:      number
    communicationCostPaise:  number
    netPayoutPaise:          number
  }
  activity:   DashboardActivity[]
  events:     DashboardEvent[]
  trendDays:  { date: string; count: number; revenuePaise: number }[]   // 90 entries, oldest → newest
  // Organizer-wide, ALL-TIME breakdowns — derived from the registrationCounters documents
  // this route already fetches, NOT from the 90-day recent window. No extra Firestore reads
  // in the healthy case. Empty ⇒ charts degrade.
  /** Confirmed + cancelled per pass, + Other / Unassigned / Unattributed. `count` is the
   *  CONFIRMED figure, kept under that name so the bar chart and insights are unchanged. */
  passDistribution:   PassRow[]
  registrationStatus: { label: string; count: number }[]   // organizer-wide, all-time, by status
  /** Every status total, so the card can show counts AND percentages from one source. */
  registrationTotals: RegistrationTotals
  /** True when at least one event's counts could not be read. The client must NOT render
   *  these two charts as authoritative zeros when this is set. */
  analyticsUnavailable?: boolean
  /** True when a per-pass cancelled split could not be completed for some event with
   *  cancellations. The client must hide the cancelled column rather than show zeros. */
  passCancelledUnavailable?: boolean
  /** Registered per event, SAME event scope and SAME confirmed figure as the two breakdowns
   *  above, Top-N with a real "Other" remainder. */
  eventPerformance:   { label: string; count: number }[]
  communications: {
    emailsSent:        number
    emailsSentToday:   number
    emailsFailedToday: number
    campaignsSent:     number
    recipientsReached: number
    smsSent:           number
    whatsappSent:      number
    costPaise:         number
  }
  healthScore: {
    score: number
    items: { label: string; done: boolean }[]
  }
  walletBalancePaise:  number
  recentTransactions:  DashboardTransaction[]
  licenseSummary: {
    pendingApproval:  number
    changesRequested: number
    published:        number
    rejected:         number
  }
  actionEvents:        DashboardActionEvent[]
  /**
   * Coupon performance across the organizer's events. Derived from the coupon documents
   * plus ONE sum() aggregate — never a registration scan — so it is exact regardless of how
   * many registrations exist. `partial` is true when the event budget was reached.
   */
  couponPerformance:   OrganizerCouponPerformance
}

// ─── Organizer event enumeration ──────────────────────────────────────────────
// RD-DASHBOARD-01 Phase 4 (H4): enumerate the organizer's ENTIRE eventDrafts
// collection deterministically, removing the former .limit(500) correctness ceiling
// that silently dropped an organizer's 501st+ event from every derived total.
//
// It keeps the EXACT query the dashboard already used — orderBy('updatedAt','desc'),
// same single-field index — and simply pages through it with a DocumentSnapshot cursor
// (startAfter) until the collection is exhausted. Because the ordering field and its
// implicit __name__ tiebreak are unchanged, the returned sequence is byte-for-byte the
// same order the old single page produced (a draft missing updatedAt was excluded then
// and still is), so downstream ordering (alerts, event cards, the action list) and every
// derived count/sum are identical for organizers within the old 500-event window. Larger
// organizers are simply no longer truncated. No new index, no second event source; reads
// stay bounded to PAGE_SIZE per round-trip.
const DRAFTS_PAGE_SIZE = 500
async function fetchAllOrganizerDrafts(
  uid: string,
): Promise<FirebaseFirestore.QueryDocumentSnapshot[]> {
  const col = adminDb.collection(`users/${uid}/eventDrafts`)
  const docs: FirebaseFirestore.QueryDocumentSnapshot[] = []
  let cursor: FirebaseFirestore.QueryDocumentSnapshot | null = null
  for (;;) {
    let q = col.orderBy('updatedAt', 'desc').limit(DRAFTS_PAGE_SIZE)
    if (cursor) q = q.startAfter(cursor)
    const page = await q.get()
    docs.push(...page.docs)
    // A short page means the collection is exhausted (a full page continues).
    if (page.size < DRAFTS_PAGE_SIZE) break
    cursor = page.docs[page.docs.length - 1]
  }
  return docs
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest): Promise<NextResponse> {
  const authz = await authorizeAnyWorkspace(req)
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  const uid = authz.workspaceUid

  // ── Batch 1: four parallel root fetches ────────────────────────────────────
  const todayStart = new Date()
  todayStart.setHours(0, 0, 0, 0)

  // EA-2 S1: the former UNBOUNDED all-time registrations scan is gone. All-time
  // totals + revenue now come from the per-event statistics docs (batch 2). What
  // still needs per-registration rows — the 90-day trend, today's numbers and the
  // activity feed — is served by a BOUNDED recent window; the two refund-sensitive
  // / all-time scalar figures (settlement gross, emails sent, today's check-ins)
  // are served by indexed aggregates that transfer no documents.
  // RD-DASHBOARD-01 Phase 3 (H3): the last two unbounded scans — today's emailLogs
  // and all sent/partial broadcastCampaigns — are now indexed count()/sum() aggregates
  // too. Every batch-1 read is now a document lookup, an aggregate, or a bounded query.
  const cutoff90         = new Date(Date.now() - 90 * 86_400_000)
  const RECENT_WINDOW_CAP = 5000
  const regsCol          = adminDb.collection('registrations')

  const [
    draftDocs, recentRegsSnap, recentCheckinsSnap, profileSnap,
    emailsSentTodayAgg, emailsFailedTodayAgg, broadcastsAgg,
    walletBalancePaise, walletTxnsSnap, revenueWalletSnap, emailsSentAgg, todayCheckinsAgg,
  ] = await Promise.all([
    // RD-DASHBOARD-01 Phase 4 (H4): complete, deterministic enumeration of the
    // organizer's events (replaces the former .limit(500) ceiling). Same order/index
    // as before, just uncapped — see fetchAllOrganizerDrafts. Still one entry in this
    // parallel batch; internally it pages with a cursor, bounded per round-trip.
    fetchAllOrganizerDrafts(uid),
    // Bounded recent window (projected): powers trendDays (90 days), today's
    // registration/revenue numbers, and the registration activity feed. Capped at
    // RECENT_WINDOW_CAP most-recent rows so cost tracks recent velocity, never
    // lifetime volume (a full 90-day trend for an event above the cap undercounts
    // its oldest in-window days — acceptable vs. an unbounded scan; daily-bucket
    // denormalization is a follow-up).
    regsCol.where('organizerUid', '==', uid).where('registeredAt', '>=', cutoff90)
      .orderBy('registeredAt', 'desc').limit(RECENT_WINDOW_CAP)
      .select('status', 'amount', 'registeredAt', 'eventSlug', 'eventName', 'passName', 'attendee.name', 'attendee.email')
      .get(),
    // Recent check-ins for the activity feed (bounded, projected).
    regsCol.where('organizerUid', '==', uid).orderBy('checkedInAt', 'desc').limit(20)
      .select('checkedInAt', 'eventName', 'passName', 'attendee.name', 'attendee.email')
      .get(),
    adminDb.collection('users').doc(uid).get(),
    // RD-DASHBOARD-01 Phase 3 (H3): today's email counts come from indexed count()
    // aggregates — split by the SAME status partitions the scan used (sent|delivered
    // vs failed) — instead of transferring every log document for the day. Two queries
    // because Firestore cannot group two different status filters into one aggregate;
    // both are served by the existing (organizerUid, status, createdAt) index, transfer
    // no documents, and stay O(1) regardless of daily email volume.
    adminDb.collection('emailLogs')
      .where('organizerUid', '==', uid)
      .where('status', 'in', ['sent', 'delivered'])
      .where('createdAt', '>=', todayStart)
      .count().get().catch(() => null),
    adminDb.collection('emailLogs')
      .where('organizerUid', '==', uid)
      .where('status', '==', 'failed')
      .where('createdAt', '>=', todayStart)
      .count().get().catch(() => null),
    // RD-DASHBOARD-01 Phase 3 (H3): campaign count + recipients reached come from ONE
    // aggregate (count + sum) over the SAME status in [sent,partial] filter the scan
    // used — no longer transferring every campaign ever sent. successCount is always
    // written (0 at creation, actual at finalize) for these statuses, so
    // sum('successCount') equals the former Σ(successCount ?? recipientCount ?? 0)
    // exactly. Served by the existing (organizerUid, status) index; transfers no docs.
    adminDb.collection('broadcastCampaigns')
      .where('organizerUid', '==', uid)
      .where('status', 'in', ['sent', 'partial'])
      .aggregate({ campaigns: AggregateField.count(), reached: AggregateField.sum('successCount') })
      .get().catch(() => null),
    getWalletBalance(uid),
    adminDb.collection('walletTransactions')
      .where('organizerUid', '==', uid)
      .orderBy('createdAt', 'desc')
      .limit(12)
      .get(),
    // RD-DASHBOARD-01 Phase 1 (H1): the settlement summary sources GROSS / FEES / NET from
    // the canonical revenue wallet (organizerRevenueWallets) — the SAME single source of
    // truth /dashboard/finance uses — replacing the inline Σamount + rate×gross estimate.
    // One O(1) doc read replaces the sum aggregate + the fee-plan fetch.
    adminDb.doc(`organizerRevenueWallets/${uid}`).get(),
    // All-time emails sent (was derived from the full scan) — one indexed count.
    regsCol.where('organizerUid', '==', uid).where('emailStatus', '==', 'sent')
      .count().get().catch(() => null),
    // Today's check-ins — one indexed count (accurate regardless of volume).
    regsCol.where('organizerUid', '==', uid).where('checkedInAt', '>=', todayStart)
      .count().get().catch(() => null),
  ])

  // RD-AUTH-02: the single organizer-session boot endpoint is the safest place to
  // guarantee the canonical /users/{uid} profile exists. Idempotent + piggybacks the
  // read above, so the self-heal write fires ONLY when the profile is genuinely missing
  // (an orphaned/legacy account whose profile write never completed).
  let profile: Record<string, unknown> = profileSnap.exists ? (profileSnap.data() ?? {}) : {}
  if (!profileSnap.exists) {
    const healed = await ensureOrganizerProfile(uid)
    if (healed) profile = healed
  }
  const drafts     = draftDocs.map(d => ({ id: d.id, ...d.data() }) as Record<string, unknown>)
  // Bounded, projected recent registrations (NOT the full history).
  // Raw window: organizerUid + registeredAt ≥ 90d, with NO event filter. Scoped to the
  // canonical dashboard event set below, once that set exists.
  const recentRegsRaw = recentRegsSnap.docs.map(d => d.data() as RegistrationDocument)

  // ── Collect slugs + draft IDs for batch 2 ─────────────────────────────────
  // Also archive-guarded: an event archived before the current writer existed can still
  // carry the legacy status 'published', which would put it back into the alerts, the
  // Active-events KPI and the event-health list.
  const publishedDrafts = drafts.filter(d => d.status === 'published' && !isArchivedTabEvent(d))
  // Certificate-template alerts are scoped to currently-published events.
  const draftIdList: string[] = publishedDrafts.map(d => d.id as string)

  const slugOfDraft = (d: Record<string, unknown>): string | null => {
    const details = (d.eventDetails as Record<string, unknown>) ?? {}
    const seo     = (details.seo    as Record<string, unknown>) ?? {}
    return typeof seo.urlSlug === 'string' && seo.urlSlug ? seo.urlSlug : null
  }

  // ══ THE CANONICAL DASHBOARD EVENT SET ════════════════════════════════════════
  //
  // ONE definition, used by EVERY figure on this dashboard: the KPI cards, revenue, both
  // trend charts, pass distribution, registration status, event performance, insights and
  // the activity feed. No card may filter events for itself — that is exactly how they
  // drifted apart before.
  //
  //   ever published (has publishedAt)  AND  NOT shown under the Archived tab
  //
  // THE INVARIANT: if the Events page files an event under "Archived", it contributes
  // nothing here. That tab is a bucket for FOUR terminal states — completed, cancelled,
  // archived and unpublished — and `isArchivedTabEvent` derives its answer from the very
  // same `listingTabsForEvent` mapping the tab uses, so the two can never disagree.
  //
  // Re-listing those states here instead would be a second copy destined to drift: that is
  // precisely how an UNPUBLISHED event kept feeding Pass Distribution and Event Performance
  // while the operator was looking at it under the Archived tab.
  //
  // NOT the same question as `isArchivedEvent`, which means the genuine permanent archived
  // state and gates permanent DELETION. An unpublished event is excluded from the dashboard
  // yet stays editable, restorable, and NOT permanently deletable.
  const dashboardDrafts = drafts.filter(d => d.publishedAt && !isArchivedTabEvent(d))
  const slugList = Array.from(new Set(
    dashboardDrafts.map(slugOfDraft).filter((s): s is string => !!s),
  ))
  // The same set as a lookup. The recent-registration scan below is organizerUid-scoped with
  // NO event filter, so without this an archived event's registrations would flow straight
  // into both trend charts, today's figures and the activity feed.
  const dashboardSlugs = new Set(slugList)

  // Every per-registration figure on this screen — both trends, today's count and revenue,
  // this month's, and the activity feed — is derived from THIS array, so the archived
  // exclusion applies to all of them from one place. A registration whose event was never
  // published (no slug in the set) is excluded for the same reason it has no counter.
  const recentRegs = recentRegsRaw.filter(r =>
    typeof r.eventSlug === 'string' && dashboardSlugs.has(r.eventSlug))

  // ── Batch 2: counters + cert templates ────────────────────────────────────
  // D.1: read each set with a single getAll() multi-get instead of N individual
  // doc().get() calls. Same documents and billed reads, but the round trips drop
  // from 2·(published events) to 2. getAll preserves argument order, so the
  // snapshot arrays still align 1:1 with slugList / draftIdList below.
  // (getAll throws with zero refs, so guard the empty case.)
  const counterRefs = slugList.map(s     => adminDb.collection('registrationCounters').doc(s))
  const certRefs    = draftIdList.map(id => adminDb.collection('certificateTemplates').doc(id))
  const [counterSnaps, certSnaps] = await Promise.all([
    counterRefs.length ? adminDb.getAll(...counterRefs) : Promise.resolve([]),
    certRefs.length    ? adminDb.getAll(...certRefs)    : Promise.resolve([]),
  ])

  // counterMap = confirmed registered per event (totalCount is ALWAYS maintained,
  // so reliable even for not-yet-backfilled events). revBySlug = confirmed revenue
  // per event, from the denormalized stats doc when complete, else deferred to a
  // self-healing per-event aggregate below.
  const counterMap = new Map<string, number>()
  const revBySlug  = new Map<string, number>()
  const revenueFallbackSlugs: string[] = []
  // RD-DASHBOARD-ANALYTICS — the raw counter per slug, kept so the organizer-wide
  // Registration Status and Pass Distribution can be derived from these ALREADY-LOADED
  // documents instead of the 90-day/5000-capped registration scan. Absent ⇒ no counter doc.
  const counterBySlug = new Map<string, RegistrationCounter | null>()
  counterSnaps.forEach((snap, i) => {
    const slug = slugList[i]
    if (!snap.exists) { counterMap.set(slug, 0); revBySlug.set(slug, 0); counterBySlug.set(slug, null); return }
    const d = snap.data() as RegistrationCounter
    counterBySlug.set(slug, d)
    counterMap.set(slug, d.totalCount ?? 0)
    if ((d.statsVersion ?? 0) >= EVENT_STATS_VERSION) revBySlug.set(slug, d.revenuePaise ?? 0)
    else revenueFallbackSlugs.push(slug)
  })
  // Self-healing fallback: confirmed-revenue aggregate for any event whose stats
  // doc predates the backfill. One indexed sum per event, no document transfer;
  // empty in steady state (after reconciliation stamps statsVersion).
  if (revenueFallbackSlugs.length) {
    const sums = await Promise.all(revenueFallbackSlugs.map(slug =>
      adminDb.collection('registrations').where('eventSlug', '==', slug).where('status', '==', 'confirmed')
        .aggregate({ s: AggregateField.sum('amount') }).get()
        .then(r => r.data().s ?? 0).catch(() => 0)))
    revenueFallbackSlugs.forEach((slug, i) => revBySlug.set(slug, sums[i]))
  }

  const certTemplateSet = new Set<string>()
  certSnaps.forEach((snap, i) => {
    if (snap.exists) certTemplateSet.add(draftIdList[i])
  })

  // ── Overview ───────────────────────────────────────────────────────────────

  const activeLifecycles = new Set(['published', 'registration_closed'])
  const activeEvents = publishedDrafts.filter(d =>
    activeLifecycles.has(deriveLifecycleStatus(d)),
  ).length

  // All-time totals from the per-event statistics docs (O(events), no scan).
  const totalRegs     = slugList.reduce((s, slug) => s + (counterMap.get(slug) ?? 0), 0)
  const totalRevPaise = slugList.reduce((s, slug) => s + (revBySlug.get(slug) ?? 0), 0)

  // Today's registration numbers from the bounded recent window; today's
  // check-ins from the indexed count aggregate (revBySlug is built in batch 2).
  const confirmedRecent = recentRegs.filter(r => r.status === 'confirmed')
  const todayConfirmed  = confirmedRecent.filter(r => isToday(r.registeredAt))
  const todayRegs       = todayConfirmed.length
  const todayRevPaise   = todayConfirmed.reduce((s, r) => s + (r.amount ?? 0), 0)
  const todayCheckins   = todayCheckinsAgg?.data().count ?? 0

  // Month-to-date (current calendar month) from the SAME bounded window. Because the
  // current month is always the newest slice, it is fully covered by the recent-window
  // cap unless a single month exceeds RECENT_WINDOW_CAP — the same fidelity contract the
  // today/trend numbers already carry. No extra read.
  const monthStart = new Date()
  monthStart.setDate(1)
  monthStart.setHours(0, 0, 0, 0)
  const monthConfirmed  = confirmedRecent.filter(r => {
    const d = tsToDate(r.registeredAt)
    return d !== null && d >= monthStart
  })
  const monthRegs     = monthConfirmed.length
  const monthRevPaise = monthConfirmed.reduce((s, r) => s + (r.amount ?? 0), 0)

  // ── Alerts ─────────────────────────────────────────────────────────────────

  // Free-event capacity = the effective Starter registration limit (SSOT), resolved
  // once from the license catalog rather than a hardcoded literal.
  const freeCapacity = await getFreeEventCapacity()

  const alerts: DashboardAlert[] = []

  publishedDrafts.forEach(d => {
    if (deriveLifecycleStatus(d) !== 'published') return

    const details   = (d.eventDetails as Record<string, unknown>) ?? {}
    const info      = (details.info     as Record<string, unknown>) ?? {}
    const seo       = (details.seo      as Record<string, unknown>) ?? {}
    const sched     = (details.schedule as Record<string, unknown>) ?? {}
    const name      = typeof info.name    === 'string' ? info.name    : 'Untitled Event'
    const slug      = typeof seo.urlSlug  === 'string' ? seo.urlSlug  : null
    const draftId   = d.id as string

    const isFree   = (d.pricing as Record<string, unknown>)?.eventType === 'free'
    const capacity = isFree ? freeCapacity : null
    const regCount = slug ? (counterMap.get(slug) ?? 0) : 0

    // Nearly full
    if (capacity !== null && capacity > 0) {
      const pct = regCount / capacity
      if (pct >= 0.9) {
        alerts.push({
          type: 'nearly_full', severity: 'critical',
          title: `${name} is almost full`,
          meta:  `${regCount}/${capacity} seats · ${Math.round(pct * 100)}% filled`,
          eventSlug: slug,
        })
      } else if (pct >= 0.8) {
        alerts.push({
          type: 'nearly_full', severity: 'warning',
          title: `${name} is filling fast`,
          meta:  `${regCount}/${capacity} seats · ${Math.round(pct * 100)}% filled`,
          eventSlug: slug,
        })
      }
    }

    // Certificate template missing
    if (!certTemplateSet.has(draftId)) {
      alerts.push({
        type: 'cert_missing', severity: 'warning',
        title: 'Certificate template missing',
        meta:  `Set up certificates for ${name}`,
        eventSlug: slug,
      })
    }

    // Registration closing soon (event starts within 48 h)
    const startStr = typeof sched.startDate === 'string' ? sched.startDate : null
    if (startStr) {
      const hoursUntil = (new Date(startStr).getTime() - Date.now()) / 3_600_000
      if (hoursUntil > 0 && hoursUntil <= 48) {
        alerts.push({
          type:     'reg_closing_soon',
          severity: hoursUntil <= 24 ? 'critical' : 'warning',
          title:    'Registration closing soon',
          meta:     `${name} starts in ${Math.round(hoursUntil)}h`,
          eventSlug: slug,
        })
      }
    }
  })

  // Communication payment pending
  // Canonical set: an archived event needs no action, so it must not raise an alert.
  dashboardDrafts.forEach(d => {
    const billing = d.communicationBilling as Record<string, unknown> | null | undefined
    if (billing?.status !== 'pending') return
    const details = (d.eventDetails as Record<string, unknown>) ?? {}
    const info    = (details.info    as Record<string, unknown>) ?? {}
    const name    = typeof info.name === 'string' ? info.name : 'an event'
    alerts.push({
      type: 'comm_payment_pending', severity: 'warning',
      title: 'Communication payment required',
      meta:  `Complete payment to publish ${name}`,
      eventSlug: null,
    })
  })

  // ── Settlement — CANONICAL (RD-DASHBOARD-01 Phase 1 / H1) ────────────────────
  // Gross / fees / net come straight from the organizer's revenue wallet
  // (organizerRevenueWallets) — the same materialized rollups /dashboard/finance reads —
  // so the dashboard and the finance page can never diverge. No inline Σamount, no
  // rate×gross estimate, no gross−fees derivation: gateway fees + GST are already folded
  // into lifetimeFeesPaise, and refunds are already netted into the stored rollups.
  const rw = revenueWalletSnap.exists ? (revenueWalletSnap.data() as OrganizerRevenueWallet) : null
  const grossPaise       = rw?.lifetimeGrossPaise ?? 0
  const platformFeePaise = rw?.lifetimeFeesPaise  ?? 0   // platform + gateway + GST (canonical)
  const netPayoutPaise   = rw?.lifetimeNetPaise    ?? 0
  // Effective total-fee rate derived FROM the canonical figures (not an estimate).
  const platformFeeRateBps = grossPaise > 0 ? Math.round((platformFeePaise / grossPaise) * 10_000) : 0

  // Communication billing is a SEPARATE concern (comms wallet), surfaced on the
  // Communication usage card — never mixed into the revenue settlement figures above.
  // Canonical set: this is a dashboard money figure, so an archived event's communication
  // spend must not keep appearing in the settlement card after the event is off the books.
  const communicationCostPaise = dashboardDrafts.reduce((s, d) => {
    const b = d.communicationBilling as Record<string, unknown> | null | undefined
    return (b?.status === 'paid' && typeof b.amount === 'number') ? s + b.amount : s
  }, 0)

  // ── Activity Feed ──────────────────────────────────────────────────────────

  type ActivityWithTs = DashboardActivity & { _ms: number }
  const activityRaw: ActivityWithTs[] = []

  // Recent registrations (newest 15) — from the bounded recent window, already
  // ordered registeredAt desc by the query.
  recentRegs.slice(0, 15).forEach(r => {
    const d = tsToDate(r.registeredAt)
    if (!d) return
    activityRaw.push({
      type: 'registration',
      attendeeName:  r.attendee.name,
      attendeeEmail: r.attendee.email,
      eventName:     r.eventName ?? '',
      passName:      r.passName  ?? '',
      timestamp:     d.toISOString(),
      _ms:           d.getTime(),
    })
  })

  // Recent check-ins (newest 10) — from the dedicated bounded checkedInAt query.
  recentCheckinsSnap.docs.slice(0, 10).forEach(doc => {
    const r = doc.data() as RegistrationDocument
    const d = tsToDate(r.checkedInAt)
    if (!d) return
    activityRaw.push({
      type: 'checkin',
      attendeeName:  r.attendee?.name  ?? '',
      attendeeEmail: r.attendee?.email ?? '',
      eventName:     r.eventName ?? '',
      passName:      r.passName  ?? '',
      timestamp:     d.toISOString(),
      _ms:           d.getTime(),
    })
  })

  const activity: DashboardActivity[] = activityRaw
    .sort((a, b) => b._ms - a._ms)
    .slice(0, 20)
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    .map(({ _ms, ...rest }) => rest)

  // ── Event Health (published + registration_closed + completed) ─────────────

  const visibleStatuses = new Set(['published', 'registration_closed', 'completed'])
  const events: DashboardEvent[] = drafts
    .filter(d => visibleStatuses.has(deriveLifecycleStatus(d)) && !isArchivedTabEvent(d))
    .map(d => {
      const details  = (d.eventDetails as Record<string, unknown>) ?? {}
      const info     = (details.info    as Record<string, unknown>) ?? {}
      const seo      = (details.seo     as Record<string, unknown>) ?? {}
      const sched    = (details.schedule as Record<string, unknown>) ?? {}
      const media    = (details.media   as Record<string, unknown>) ?? {}
      const banner   = (media.coverBanner as Record<string, unknown>) ?? {}
      const slug     = typeof seo.urlSlug === 'string' ? seo.urlSlug : null
      const isFree   = (d.pricing as Record<string, unknown>)?.eventType === 'free'
      const capacity = isFree ? freeCapacity : null
      const regCount = slug ? (counterMap.get(slug) ?? 0) : 0
      const fillPct  = capacity ? Math.round((regCount / capacity) * 100) : 0

      return {
        draftId:         d.id as string,
        name:            typeof info.name      === 'string' ? info.name      : 'Untitled Event',
        slug,
        registered:      regCount,
        capacity,
        fillPct,
        startDate:       typeof sched.startDate === 'string' ? sched.startDate : null,
        lifecycleStatus: deriveLifecycleStatus(d),
        reviewStatus:    d.reviewStatus === 'rejected' || d.reviewStatus === 'changes_requested' ? d.reviewStatus : null,
        licenseTier:     typeof d.licenseTier === 'string' ? d.licenseTier : 'starter',
        bannerUrl:       typeof banner.value === 'string' ? banner.value : null,
        revenuePaise:    slug ? (revBySlug.get(slug) ?? 0) : 0,
      }
    })

  // ── Trend Data (90-day daily buckets) ──────────────────────────────────────

  const trendCount = new Map<string, number>()
  const trendRev   = new Map<string, number>()

  // Seed all 90 days with 0 (oldest → newest)
  for (let i = 89; i >= 0; i--) {
    const k = ymd(new Date(Date.now() - i * 86_400_000))
    trendCount.set(k, 0)
    trendRev.set(k, 0)
  }

  // Bucketed from the bounded recent window (cutoff90 declared in batch 1). Count AND
  // confirmed revenue per day come from the same pass — powers both trend charts.
  confirmedRecent.forEach(r => {
    const d = tsToDate(r.registeredAt)
    if (!d || d < cutoff90) return
    const k = ymd(d)
    if (trendCount.has(k)) {
      trendCount.set(k, (trendCount.get(k) ?? 0) + 1)
      trendRev.set(k,   (trendRev.get(k)   ?? 0) + (r.amount ?? 0))
    }
  })

  const trendDays = Array.from(trendCount.entries())
    .map(([date, count]) => ({ date, count, revenuePaise: trendRev.get(date) ?? 0 }))

  // ── passId → pass name, from the drafts ALREADY loaded above (no extra reads) ──
  // `passCounts` is keyed by passId; the chart shows names. Passes live at
  // `draft.pricing.passes`, the same shape the attendance and event routes read.
  //
  // A pass whose configured name is genuinely "free" therefore DISPLAYS as "free" — that is
  // real configured data, not a fallback. An unresolvable passId becomes "Unassigned"
  // downstream; the two are never confused.
  const passNamesBySlug = new Map<string, Record<string, string>>()
  const eventNameBySlug = new Map<string, string>()
  // Canonical set. These are only ever read for a slug already in `slugList`, so an archived
  // entry could not leak — but building them from the same source keeps the invariant true
  // by construction rather than by luck, and lets a test assert it.
  dashboardDrafts.forEach(d => {
    const slug = slugOfDraft(d)
    if (!slug) return
    const details = (d.eventDetails as Record<string, unknown>) ?? {}
    const info    = (details.info as Record<string, unknown>) ?? {}
    eventNameBySlug.set(slug, typeof info.name === 'string' && info.name ? info.name : 'Untitled Event')

    const raw = (d.pricing as Record<string, unknown> | undefined)?.passes
    if (!Array.isArray(raw)) return
    const names: Record<string, string> = {}
    for (const p of raw as Array<Record<string, unknown>>) {
      const id   = typeof p.id === 'string' ? p.id : ''
      const name = typeof p.name === 'string' ? p.name.trim() : ''
      if (id) names[id] = name
    }
    passNamesBySlug.set(slug, names)
  })

  // ── Organizer-wide, ALL-TIME status + pass distribution ───────────────────────
  //
  // WHY NOT THE RECENT SCAN. These two charts used to be derived from `recentRegs`, which is
  // organizerUid + registeredAt ≥ 90d + limit(5000) and carries NO event filter. That made
  // them silently window-limited and cap-limited, and inconsistent with Event Performance on
  // the same screen (which is all-time, from the counters). They now come from the counter
  // documents that this route already fetches, so they are all-time, uncapped, and cheaper.
  //
  // The recent scan REMAINS — trendDays, today's figures and the activity feed genuinely need
  // recent per-registration rows.
  // ── ONE authoritative status source per event ─────────────────────────────────
  // C: every event resolves its status breakdown the same way, so Waitlisted stops being a
  // confident zero. `registrationCounters` carries pending/cancelled/rejected but has NO
  // waitlistedCount field — the counter path could therefore never report a waitlist. Events
  // with current stats reuse the counter (free, already fetched) plus ONE extra aggregate for
  // waitlisted; events with stale stats fall back to the full shared aggregate as before.
  // Every query is a count(): zero documents transferred, existing indexes.
  const eventStatus = new Map<string, RegistrationStatusCounts | null>()

  const staleSet    = new Set(slugList.filter(slug => {
    const c = counterBySlug.get(slug)
    return !c || (c.statsVersion ?? 0) < EVENT_STATS_VERSION
  }))
  const staleSlugs  = slugList.filter(s => staleSet.has(s))
  const freshSlugs  = slugList.filter(s => !staleSet.has(s))

  const [staleRows, waitRows] = await Promise.all([
    Promise.all(staleSlugs.map(slug => aggregateRegistrationStatusCounts(uid, slug).catch(() => null))),
    Promise.all(freshSlugs.map(slug => aggregateWaitlistedCount(uid, slug))),
  ])

  staleSlugs.forEach((slug, i) => eventStatus.set(slug, staleRows[i]))
  freshSlugs.forEach((slug, i) => {
    const c = counterBySlug.get(slug)!
    const waitlisted = waitRows[i]
    // A failed waitlist read makes the whole event's breakdown unavailable rather than
    // contributing a zero that cannot be distinguished from a genuinely empty waitlist.
    if (waitlisted === null) { eventStatus.set(slug, null); return }
    const confirmed = c.totalCount     ?? 0
    const pending   = c.pendingCount   ?? 0
    const cancelled = c.cancelledCount ?? 0
    const rejected  = c.rejectedCount  ?? 0
    eventStatus.set(slug, {
      // `total` is SUMMED from the parts, never read as an independent figure — the counter
      // has no all-status total, and inventing one by another route could disagree with them.
      total: confirmed + pending + cancelled + rejected + waitlisted,
      confirmed, pending, cancelled, rejected, waitlisted,
      checkedIn: c.checkedInCount ?? 0,
    })
  })

  // ── A: cancelled split by pass, count()-only and budgeted ─────────────────────
  // Runs ONLY for events that actually have cancellations, so a clean event costs nothing.
  // The budget caps events × passes; once spent, the remaining events report `null` (→
  // "unavailable"), never zeros.
  const passIdsBySlug = new Map<string, string[]>()
  dashboardDrafts.forEach(d => {   // canonical set — see eventNameBySlug above
    const slug = slugOfDraft(d)
    if (!slug) return
    const raw = (d.pricing as Record<string, unknown> | undefined)?.passes
    if (!Array.isArray(raw)) return
    passIdsBySlug.set(slug, (raw as Array<Record<string, unknown>>)
      .map(p => (typeof p.id === 'string' ? p.id : ''))
      .filter(Boolean))
  })

  const passBudget = { remaining: PASS_AGGREGATE_BUDGET }
  const cancelledByPass = new Map<string, Record<string, number> | null>()
  for (const slug of slugList) {
    const st = eventStatus.get(slug)
    if (!st || st.cancelled === 0) continue
    const r = await aggregateCancelledByPass(uid, slug, passIdsBySlug.get(slug) ?? [], passBudget)
    cancelledByPass.set(slug, r.complete ? r.counts : null)
  }

  // ── Coupon performance (organizer-wide) ──────────────────────────────────
  // Reuses the SAME bounded event set the rest of this route already established, so it
  // cannot widen the dashboard's scope. Cost is one coupons-subcollection read per event
  // (capped inside the helper) plus ONE sum() aggregate for the whole organizer — never a
  // registration scan, never a query per coupon. A failure degrades to an empty card rather
  // than taking the dashboard down.
  const couponPerformance = await getOrganizerCouponPerformance(
    uid,
    slugList.map(slug => ({ slug, name: eventNameBySlug.get(slug) ?? 'Untitled Event' })),
  ).catch(() => EMPTY_ORGANIZER_COUPON_PERFORMANCE)

  const analytics = buildDashboardAnalytics(slugList.map(slug => ({
    slug,
    eventName:     eventNameBySlug.get(slug) ?? 'Untitled Event',
    status:        eventStatus.get(slug) ?? null,
    passConfirmed: (counterBySlug.get(slug)?.passCounts ?? {}) as Record<string, number>,
    // Absent from the map ⇒ nothing to attribute (no cancellations); present ⇒ the computed
    // split, or null when it could not be completed.
    passCancelled: cancelledByPass.has(slug) ? cancelledByPass.get(slug)! : {},
    passNames:     passNamesBySlug.get(slug) ?? {},
  })))

  const registrationStatus = analytics.registrationStatus
  const passDistribution   = analytics.passDistribution

  // ── Communications ─────────────────────────────────────────────────────────

  const emailsSent        = emailsSentAgg?.data().count ?? 0
  // Today's email counts: indexed count() aggregates (H3) — identical status partitions
  // to the former per-doc scan (sent|delivered vs failed), now O(1) in daily volume.
  const emailsSentToday   = emailsSentTodayAgg?.data().count   ?? 0
  const emailsFailedToday = emailsFailedTodayAgg?.data().count ?? 0

  // Campaign totals: one count+sum aggregate (H3). sum('successCount') equals the former
  // Σ(successCount ?? recipientCount ?? 0) because successCount is always written (0 at
  // creation, actual at finalize) for sent/partial campaigns.
  const campaignsSent     = broadcastsAgg?.data().campaigns ?? 0
  const recipientsReached = broadcastsAgg?.data().reached   ?? 0

  const communications = {
    emailsSent,
    emailsSentToday,
    emailsFailedToday,
    campaignsSent,
    recipientsReached,
    smsSent:      0,   // not tracked in current schema
    whatsappSent: 0,
    costPaise:    communicationCostPaise,
  }

  // ── Organizer Health Score ─────────────────────────────────────────────────

  const branding    = (profile.branding            as Record<string, unknown>) ?? {}
  const orgProfile  = (profile.organizationProfile as Record<string, unknown>) ?? {}
  const commsConfig = (profile.communications       as Record<string, boolean>) ?? {}

  const healthItems: { label: string; done: boolean }[] = [
    {
      label: 'Organization name',
      done:  typeof profile.organizationName === 'string' &&
             (profile.organizationName as string).trim().length > 0,
    },
    {
      label: 'Support email address',
      done:  typeof orgProfile.supportEmail === 'string' &&
             (orgProfile.supportEmail as string).trim().length > 0,
    },
    {
      label: 'Organization logo',
      done:  typeof branding.logoUrl === 'string' && (branding.logoUrl as string).length > 0,
    },
    {
      label: 'Certificate signature',
      done:  typeof branding.certSignatureUrl === 'string' &&
             (branding.certSignatureUrl as string).length > 0,
    },
    {
      label: 'Event published',
      done:  publishedDrafts.length > 0,
    },
    {
      label: 'Email communications on',
      done:  commsConfig.sendRegistrationConfirmation ?? false,
    },
  ]

  const doneCount = healthItems.filter(i => i.done).length
  const healthScore = {
    score: Math.round((doneCount / healthItems.length) * 100),
    items: healthItems,
  }

  // ── Assemble and return ────────────────────────────────────────────────────

  // License summary + events needing attention (pending / changes-requested /
  // rejected) — derived from the drafts already loaded (no extra reads).
  const licenseSummary = {
    pendingApproval:  drafts.filter(d => deriveLifecycleStatus(d) === 'pending_review').length,
    changesRequested: drafts.filter(d => deriveLifecycleStatus(d) === 'changes_requested' || d.reviewStatus === 'changes_requested').length,
    published:        drafts.filter(d => deriveLifecycleStatus(d) === 'published').length,
    rejected:         drafts.filter(d => d.reviewStatus === 'rejected').length,
  }

  const actionEvents: DashboardActionEvent[] = drafts
    .filter(d => {
      const ls = deriveLifecycleStatus(d)
      return ls === 'pending_review' || ls === 'changes_requested' || d.reviewStatus === 'rejected'
    })
    .map(d => {
      const det  = (d.eventDetails as Record<string, unknown>) ?? {}
      const info = (det.info as Record<string, unknown>) ?? {}
      const seo  = (det.seo  as Record<string, unknown>) ?? {}
      return {
        draftId:         d.id as string,
        name:            typeof info.name === 'string' ? info.name : 'Untitled Event',
        slug:            typeof seo.urlSlug === 'string' ? seo.urlSlug : null,
        lifecycleStatus: deriveLifecycleStatus(d),
        reviewStatus:    d.reviewStatus === 'rejected' ? 'rejected' as const
          : d.reviewStatus === 'changes_requested' ? 'changes_requested' as const : null,
      }
    })
    .slice(0, 10)

  const recentTransactions: DashboardTransaction[] = walletTxnsSnap.docs.map(doc => {
    const d = doc.data() as { type?: string; amountPaise?: number; balancePaise?: number; description?: string; createdAt?: unknown }
    return {
      id:           doc.id,
      type:         typeof d.type === 'string' ? d.type : 'adjustment',
      amountPaise:  typeof d.amountPaise  === 'number' ? d.amountPaise  : 0,
      balancePaise: typeof d.balancePaise === 'number' ? d.balancePaise : 0,
      description:  typeof d.description === 'string' ? d.description : '',
      createdAt:    tsToDate(d.createdAt)?.toISOString() ?? null,
    }
  })

  const data: DashboardData = {
    organizer: {
      name:    typeof profile.name             === 'string' ? (profile.name             as string) : '',
      orgName: typeof profile.organizationName === 'string' ? (profile.organizationName as string) : '',
      logoUrl: typeof branding.logoUrl         === 'string' ? (branding.logoUrl         as string) : null,
    },
    overview: {
      activeEvents:       activeEvents,
      totalRegistrations: totalRegs,
      totalRevenuePaise:  totalRevPaise,
      todayRevenuePaise:  todayRevPaise,
      todayRegistrations: todayRegs,
      todayCheckins:      todayCheckins,
      monthRevenuePaise:  monthRevPaise,
      monthRegistrations: monthRegs,
    },
    alerts,
    settlement: {
      grossRevenuePaise:      grossPaise,
      platformFeePaise,
      platformFeeRateBps,
      communicationCostPaise,
      netPayoutPaise,
    },
    activity,
    events,
    trendDays,
    passDistribution,
    registrationStatus,
    registrationTotals:       analytics.totals,
    eventPerformance:         analytics.eventPerformance,
    analyticsUnavailable:     analytics.statusUnavailable,
    passCancelledUnavailable: analytics.passCancelledUnavailable,
    communications,
    healthScore,
    walletBalancePaise,
    recentTransactions,
    licenseSummary,
    actionEvents,
    couponPerformance,
  }

  return NextResponse.json(data)
}
