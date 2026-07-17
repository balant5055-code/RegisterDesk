// GET /api/organizer/dashboard
//
// Single aggregation endpoint for the organizer dashboard.
// Runs all Firestore reads in parallel and returns a structured payload.
// Called once on page load; the page derives all sections from this response.

import { NextRequest, NextResponse } from 'next/server'
import { AggregateField }            from 'firebase-admin/firestore'
import { adminDb }                   from '@/lib/firebase/admin'
import { authorizeAnyWorkspace }     from '@/lib/team/workspace'
import { deriveLifecycleStatus }     from '@/lib/events/lifecycle'
import { getWalletBalance }          from '@/lib/firebase/firestore/wallet'
import { getFeePlanForOrganizer }    from '@/lib/billing/feeEngine'
import { getFreeEventCapacity }      from '@/lib/licensing/resolveCatalog'
import { EVENT_STATS_VERSION }       from '@/lib/registrations/types'
import type { RegistrationDocument, RegistrationCounter } from '@/lib/registrations/types'

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
  trendDays:  { date: string; count: number }[]   // 90 entries, oldest → newest
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
  const cutoff90         = new Date(Date.now() - 90 * 86_400_000)
  const RECENT_WINDOW_CAP = 5000
  const regsCol          = adminDb.collection('registrations')

  const [
    draftsSnap, recentRegsSnap, recentCheckinsSnap, profileSnap, emailLogsSnap, broadcastsSnap,
    walletBalancePaise, walletTxnsSnap, feePlan, grossAgg, emailsSentAgg, todayCheckinsAgg,
  ] = await Promise.all([
    // LS1: bound the drafts scan (an organizer's own events are naturally few;
    // 500 covers any realistic account without changing the computed output).
    adminDb.collection(`users/${uid}/eventDrafts`).orderBy('updatedAt', 'desc').limit(500).get(),
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
    adminDb.collection('emailLogs')
      .where('organizerUid', '==', uid)
      .where('createdAt', '>=', todayStart)
      .get(),
    adminDb.collection('broadcastCampaigns')
      .where('organizerUid', '==', uid)
      .where('status', 'in', ['sent', 'partial'])
      .select('recipientCount', 'successCount')
      .get(),
    getWalletBalance(uid),
    adminDb.collection('walletTransactions')
      .where('organizerUid', '==', uid)
      .orderBy('createdAt', 'desc')
      .limit(12)
      .get(),
    // D.1: fee plan joins batch 1 so it runs in parallel instead of blocking
    // sequentially after the batch (same result, one fewer serial round trip).
    getFeePlanForOrganizer(uid),
    // Settlement gross = Σ amount over CONFIRMED + PAID (refund-sensitive, so not
    // denormalized). One indexed sum aggregate — no document transfer.
    regsCol.where('organizerUid', '==', uid).where('status', '==', 'confirmed').where('paymentStatus', '==', 'paid')
      .aggregate({ s: AggregateField.sum('amount') }).get().catch(() => null),
    // All-time emails sent (was derived from the full scan) — one indexed count.
    regsCol.where('organizerUid', '==', uid).where('emailStatus', '==', 'sent')
      .count().get().catch(() => null),
    // Today's check-ins — one indexed count (accurate regardless of volume).
    regsCol.where('organizerUid', '==', uid).where('checkedInAt', '>=', todayStart)
      .count().get().catch(() => null),
  ])

  const profile    = profileSnap.exists ? (profileSnap.data() ?? {}) : {}
  const drafts     = draftsSnap.docs.map(d => ({ id: d.id, ...d.data() }) as Record<string, unknown>)
  // Bounded, projected recent registrations (NOT the full history).
  const recentRegs = recentRegsSnap.docs.map(d => d.data() as RegistrationDocument)

  // ── Collect slugs + draft IDs for batch 2 ─────────────────────────────────
  const publishedDrafts = drafts.filter(d => d.status === 'published')
  // Certificate-template alerts are scoped to currently-published events.
  const draftIdList: string[] = publishedDrafts.map(d => d.id as string)

  // Per-event statistics (counts + revenue) are summed over EVERY event that was
  // ever published — including ones since archived/cancelled/completed — so the
  // overview totals match the previous all-events scan rather than only the
  // currently-published set. Resolved by slug from publishedAt-stamped drafts.
  const slugOfDraft = (d: Record<string, unknown>): string | null => {
    const details = (d.eventDetails as Record<string, unknown>) ?? {}
    const seo     = (details.seo    as Record<string, unknown>) ?? {}
    return typeof seo.urlSlug === 'string' && seo.urlSlug ? seo.urlSlug : null
  }
  const slugList = Array.from(new Set(
    drafts.filter(d => d.publishedAt).map(slugOfDraft).filter((s): s is string => !!s),
  ))

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
  counterSnaps.forEach((snap, i) => {
    const slug = slugList[i]
    if (!snap.exists) { counterMap.set(slug, 0); revBySlug.set(slug, 0); return }
    const d = snap.data() as RegistrationCounter
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
  drafts.forEach(d => {
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

  // ── Settlement ─────────────────────────────────────────────────────────────

  const grossPaise = grossAgg?.data().s ?? 0

  // F.5: derive the platform fee rate from the organizer's ACTIVE plan (single
  // source of truth) rather than the wallet's denormalized tier. Estimate only —
  // the actual per-transaction fee (with fixed/min/cap) is computed at charge time.
  // `feePlan` is fetched in batch 1 above (parallelized).
  const platformFeeRateBps   = Math.round(feePlan.transactionFeePercent * 100)
  const platformFeePaise     = Math.round(grossPaise * platformFeeRateBps / 10_000)

  const communicationCostPaise = drafts.reduce((s, d) => {
    const b = d.communicationBilling as Record<string, unknown> | null | undefined
    return (b?.status === 'paid' && typeof b.amount === 'number') ? s + b.amount : s
  }, 0)
  const netPayoutPaise = Math.max(0, grossPaise - platformFeePaise - communicationCostPaise)

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
    .filter(d => visibleStatuses.has(deriveLifecycleStatus(d)))
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

  const trendMap = new Map<string, number>()

  // Seed all 90 days with 0 (oldest → newest)
  for (let i = 89; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86_400_000)
    trendMap.set(ymd(d), 0)
  }

  // Bucketed from the bounded recent window (cutoff90 declared in batch 1).
  confirmedRecent.forEach(r => {
    const d = tsToDate(r.registeredAt)
    if (!d || d < cutoff90) return
    const k = ymd(d)
    if (trendMap.has(k)) trendMap.set(k, (trendMap.get(k) ?? 0) + 1)
  })

  const trendDays = Array.from(trendMap.entries()).map(([date, count]) => ({ date, count }))

  // ── Communications ─────────────────────────────────────────────────────────

  const emailsSent        = emailsSentAgg?.data().count ?? 0
  const todayLogs         = emailLogsSnap.docs.map(d => d.data() as { status?: string })
  const emailsSentToday   = todayLogs.filter(l => l.status === 'sent' || l.status === 'delivered').length
  const emailsFailedToday = todayLogs.filter(l => l.status === 'failed').length

  let campaignsSent     = 0
  let recipientsReached = 0
  broadcastsSnap.docs.forEach(doc => {
    const d = doc.data() as { recipientCount?: number; successCount?: number }
    campaignsSent++
    recipientsReached += d.successCount ?? d.recipientCount ?? 0
  })

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
    communications,
    healthScore,
    walletBalancePaise,
    recentTransactions,
    licenseSummary,
    actionEvents,
  }

  return NextResponse.json(data)
}
