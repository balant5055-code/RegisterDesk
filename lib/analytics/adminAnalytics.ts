// Platform analytics — server-only. Uses Firestore AGGREGATION (count()/sum()) and
// bounded orderBy-limit queries so it NEVER loads all registrations/transactions.
// Revenue comes from the materialized organizerRevenueWallets rollups; counts come
// from aggregate queries; top lists from indexed orderBy+limit.

import { AggregateField } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import { organizersQuery } from '@/lib/organizer/identity'
import { captureError } from '@/lib/monitoring/sentry'

export interface Point { label: string; value: number }

/** RD-ANALYTICS-FAILCLOSED — the licence figures that can be unavailable (null) when their query fails. */
export type LicenseSalesFigure = 'paidCount' | 'revenuePaise' | 'discountGivenPaise' | 'refundedCount'

export interface AdminAnalytics {
  platform: {
    organizers: number; publishedEvents: number; campaigns: number; totalRegistrations: number
    lifetimeGrossPaise: number; lifetimeFeesPaise: number; lifetimeNetPaise: number; pendingSettlementPaise: number
  }
  topOrganizers: { uid: string; name: string; grossPaise: number; netPaise: number }[]
  topEvents:     { eventId: string; name: string; registrations: number }[]
  licenseSales:  {
    /**
     * `null` = unavailable, never 0: its own query failed (RD-ANALYTICS-FAILCLOSED), or — for paid count
     * and revenue — the ID-badge exclusion could not be computed (RD-PRINT-BILL-P4.4), which would
     * otherwise silently include badge purchase money.
     */
    paidCount: number | null; refundedCount: number | null; revenuePaise: number | null; byTier: Point[]
    /** 'applied' — badge purchase orders were excluded; 'unavailable' — the exclusion failed (see above). */
    badgeExclusion: 'applied' | 'unavailable'
    // EA-4 S2 — license-coupon metrics
    discountGivenPaise: number | null   // revenue "lost" to coupons; null = unavailable (never 0)
    couponRedemptions:  number   // paid orders that used a coupon
    topCoupons:         Point[]   // code → redemptions
    byCampaign:         Point[]   // campaign → redemptions
    /** RD-ANALYTICS-FAILCLOSED — additive: the figures above that are null because they could not be read. */
    unavailable:        LicenseSalesFigure[]
  }
  communication: { totalSent: number; totalFailed: number }
  reminders:     { total: number; sent: number; failed: number }
  growth:        { eventsByDay: Point[] }
}

type Query = FirebaseFirestore.Query

async function countOf(q: Query): Promise<number> {
  try { return (await q.count().get()).data().count } catch { return 0 }
}
async function sumOf(q: Query, field: string): Promise<number> {
  try { return (await q.aggregate({ s: AggregateField.sum(field) }).get()).data().s ?? 0 } catch { return 0 }
}
/**
 * RD-PRINT-P8 (W7) — how a failed licence-figure query is reported. Firestore answers a query whose
 * composite index is missing with FAILED_PRECONDITION (gRPC code 9); anything else is a plain query
 * failure. Diagnostic only: either way the figure is null ("Unavailable"), never 0. Pure.
 */
export function analyticsFailureKind(e: unknown): 'missing_index' | 'query_failed' {
  const code = e && typeof e === 'object' ? (e as { code?: unknown }).code : undefined
  if (code === 9 || code === 'failed-precondition' || code === 'FAILED_PRECONDITION') return 'missing_index'
  return e instanceof Error && /FAILED_PRECONDITION|requires an index/i.test(e.message) ? 'missing_index' : 'query_failed'
}

/** Reports one unavailable licence figure: its name, the tag and the error TYPE — never the raw message (a
 *  missing-index error quotes the query and an index-creation link). */
export function reportLicenceFigureFailure(figure: string, e: unknown): void {
  const tag = analyticsFailureKind(e)
  console.error('[analytics] licence figure unavailable', { figure, tag, type: e instanceof Error ? e.name : typeof e })
  captureError(new Error(`analytics_${tag}`), { scope: 'analytics.licence_figure', figure, tag })
}

/** RD-PRINT-BILL-P4.4 — the same aggregations, but a failure THROWS (never read as 0). */
async function strictCountOf(q: Query): Promise<number> {
  return (await q.count().get()).data().count
}
async function strictSumOf(q: Query, field: string): Promise<number> {
  return (await q.aggregate({ s: AggregateField.sum(field) }).get()).data().s ?? 0
}

function lastNDays(n: number): { key: string; label: string }[] {
  const out: { key: string; label: string }[] = []
  const now = new Date()
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now); d.setDate(now.getDate() - i)
    out.push({ key: d.toISOString().slice(0, 10), label: `${d.getMonth() + 1}/${d.getDate()}` })
  }
  return out
}
const tsMs = (v: unknown): number | null =>
  v && typeof (v as { toMillis?: () => number }).toMillis === 'function' ? (v as { toMillis: () => number }).toMillis() : null

export async function getAdminAnalytics(): Promise<AdminAnalytics> {
  const events        = adminDb.collection('events')
  const revenueWallets = adminDb.collection('organizerRevenueWallets')

  // ── Platform totals (aggregation only) ──
  const [organizers, publishedEvents, campaigns, totalRegistrations,
    lifetimeGrossPaise, lifetimeFeesPaise, lifetimeNetPaise, pendingSettlementPaise] = await Promise.all([
    // Organizers = accounts with role 'organizer' (canonical: lib/organizer/identity).
    countOf(organizersQuery(adminDb)),
    countOf(events.where('lifecycleStatus', '==', 'published')),
    countOf(adminDb.collection('donationCampaigns')),
    countOf(adminDb.collection('registrations')),
    sumOf(revenueWallets, 'lifetimeGrossPaise'),
    sumOf(revenueWallets, 'lifetimeFeesPaise'),
    sumOf(revenueWallets, 'lifetimeNetPaise'),
    sumOf(revenueWallets, 'pendingPaise'),
  ])

  // ── Top organizers by lifetime revenue (bounded) ──
  let topOrganizers: AdminAnalytics['topOrganizers'] = []
  try {
    const snap = await revenueWallets.orderBy('lifetimeGrossPaise', 'desc').limit(10).get()
    const uids = snap.docs.map(d => d.id)
    const users = uids.length ? await adminDb.getAll(...uids.map(u => adminDb.doc(`users/${u}`))) : []
    const nameMap = new Map<string, string>()
    users.forEach((u, i) => { if (u.exists) nameMap.set(uids[i], (u.data() as { name?: string; organizationName?: string }).name || (u.data() as { organizationName?: string }).organizationName || uids[i]) })
    topOrganizers = snap.docs.map(d => {
      const x = d.data() as Record<string, number>
      return { uid: d.id, name: nameMap.get(d.id) || d.id, grossPaise: x.lifetimeGrossPaise ?? 0, netPaise: x.lifetimeNetPaise ?? 0 }
    })
  } catch { /* index */ }

  // ── Top events by registrations (bounded — from counters) ──
  let topEvents: AdminAnalytics['topEvents'] = []
  try {
    const snap = await adminDb.collection('registrationCounters').orderBy('totalCount', 'desc').limit(10).get()
    const ids = snap.docs.map(d => d.id)
    const evs = ids.length ? await adminDb.getAll(...ids.map(id => adminDb.doc(`events/${id}`))) : []
    const nameMap = new Map<string, string>()
    evs.forEach((e, i) => { if (e.exists) nameMap.set(ids[i], (((e.data() as Record<string, unknown>).eventDetails as Record<string, unknown> | undefined)?.info as Record<string, unknown> | undefined)?.name as string || ids[i]) })
    topEvents = snap.docs.map(d => ({ eventId: d.id, name: nameMap.get(d.id) || d.id, registrations: (d.data() as { totalCount?: number }).totalCount ?? 0 }))
  } catch { /* index */ }

  // ── License sales ──
  const licenseOrders = adminDb.collection('licenseOrders')
  // RD-PRINT-BILL-P4 — ID-badge purchase orders (purpose 'print_badges') live in licenseOrders too but
  // are NOT licence sales: their count and money are subtracted here, and they are skipped in the
  // tier/coupon breakdown below. They carry no top-level discountPaise.
  // Indexes: the equality-only counts are served by Firestore's automatic single-field indexes; the
  // filtered sums need composites that carry the summed field — licenseOrders (status, amountPaise),
  // (status, discountPaise) and (purpose, status, amountPaise), deployed to production 2026-10-11.
  // RD-ANALYTICS-FAILCLOSED (2026-10-11) — every licence figure is read STRICTLY and independently: a
  // failed query makes ONLY its own figure null (listed in `unavailable`), never a fabricated 0. The
  // badge figures are strict too (RD-PRINT-BILL-P4.4): if they cannot be read, paid count and revenue
  // are null rather than totals that silently include badge purchase money.
  // RD-PRINT-P8 (W7) — each failure is reported with a missing_index / query_failed tag (diagnostic only).
  const settled = <T,>(figure: string, p: Promise<T>): Promise<{ ok: true; v: T } | { ok: false }> =>
    p.then(v => ({ ok: true as const, v }), e => { reportLicenceFigureFailure(figure, e); return { ok: false as const } })
  const paidOrders = licenseOrders.where('status', '==', 'paid')
  const badgePaid = licenseOrders.where('purpose', '==', 'print_badges').where('status', '==', 'paid')
  const [allPaid, refunded, allRevenue, discount, badge] = await Promise.all([
    settled('paidCount', strictCountOf(paidOrders)),
    settled('refundedCount', strictCountOf(licenseOrders.where('status', '==', 'refunded'))),
    settled('revenuePaise', strictSumOf(paidOrders, 'amountPaise')),
    settled('discountGivenPaise', strictSumOf(paidOrders, 'discountPaise')),   // EA-4 S2 revenue lost
    Promise.all([strictCountOf(badgePaid), strictSumOf(badgePaid, 'amountPaise')])
      .then(([count, revenue]) => ({ ok: true as const, count, revenue }))
      .catch(e => { reportLicenceFigureFailure('badgeExclusion', e); return { ok: false as const } }),
  ])
  const paidCount          = allPaid.ok && badge.ok ? Math.max(0, allPaid.v - badge.count) : null
  const revenuePaise       = allRevenue.ok && badge.ok ? Math.max(0, allRevenue.v - badge.revenue) : null
  const discountGivenPaise = discount.ok ? discount.v : null
  const refundedCount      = refunded.ok ? refunded.v : null
  const unavailable: LicenseSalesFigure[] = []
  if (paidCount === null) unavailable.push('paidCount')
  if (revenuePaise === null) unavailable.push('revenuePaise')
  if (discountGivenPaise === null) unavailable.push('discountGivenPaise')
  if (refundedCount === null) unavailable.push('refundedCount')
  const byTier    = new Map<string, number>()
  const byCoupon  = new Map<string, number>()
  const byCampaign = new Map<string, number>()
  let couponRedemptions = 0
  try {
    const paid = await licenseOrders.where('status', '==', 'paid').limit(2000).get()
    for (const d of paid.docs) {
      const o = d.data() as { tier?: string; couponCode?: string | null; campaign?: string | null; commercialModel?: string; purpose?: string }
      if (o.purpose === 'print_badges') continue        // RD-PRINT-BILL-P4 — not a licence sale
      // RD-CAPACITY-01 · a capacity-priced order has no tier. It carries the version's free
      // tier purely as a compatibility stamp, so counting it here would report real
      // activation revenue as Free-tier sales. It is bucketed as 'capacity' instead, which
      // is what it is.
      const bucket = o.commercialModel === 'capacity' ? 'capacity' : String(o.tier ?? 'unknown')
      byTier.set(bucket, (byTier.get(bucket) ?? 0) + 1)
      if (o.couponCode) {
        couponRedemptions++
        byCoupon.set(o.couponCode, (byCoupon.get(o.couponCode) ?? 0) + 1)
        const camp = o.campaign || 'none'
        byCampaign.set(camp, (byCampaign.get(camp) ?? 0) + 1)
      }
    }
  } catch { /* index */ }
  const toPoints = (m: Map<string, number>): Point[] =>
    [...m.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value)

  // ── Communication + reminder usage (counts only) ──
  const emailLogs = adminDb.collection('emailLogs')
  const reminders = adminDb.collection('scheduledReminders')
  const [totalSent, totalFailed, remTotal, remSent, remFailed] = await Promise.all([
    countOf(emailLogs.where('status', '==', 'sent')),
    countOf(emailLogs.where('status', '==', 'failed')),
    countOf(reminders),
    countOf(reminders.where('status', '==', 'sent')),
    countOf(reminders.where('status', '==', 'failed')),
  ])

  // ── Growth: published events per day (bounded) ──
  const days = lastNDays(30)
  const byDay = new Map<string, number>(days.map(d => [d.key, 0]))
  try {
    const snap = await events.where('lifecycleStatus', '==', 'published').orderBy('publishedAt', 'desc').limit(500).get()
    for (const d of snap.docs) {
      const ms = tsMs((d.data() as Record<string, unknown>).publishedAt)
      if (ms == null) continue
      const key = new Date(ms).toISOString().slice(0, 10)
      if (byDay.has(key)) byDay.set(key, (byDay.get(key) ?? 0) + 1)
    }
  } catch { /* index */ }

  return {
    platform: { organizers, publishedEvents, campaigns, totalRegistrations, lifetimeGrossPaise, lifetimeFeesPaise, lifetimeNetPaise, pendingSettlementPaise },
    topOrganizers, topEvents,
    licenseSales: {
      paidCount, refundedCount, revenuePaise, byTier: toPoints(byTier), badgeExclusion: badge.ok ? 'applied' : 'unavailable', unavailable,
      discountGivenPaise, couponRedemptions,
      topCoupons: toPoints(byCoupon).slice(0, 10), byCampaign: toPoints(byCampaign),
    },
    communication: { totalSent, totalFailed },
    reminders: { total: remTotal, sent: remSent, failed: remFailed },
    growth: { eventsByDay: days.map(d => ({ label: d.label, value: byDay.get(d.key) ?? 0 })) },
  }
}
