// License & Coupon Command Center aggregation service (GA-2 S3). Server-only.
//
// READ aggregation that REUSES existing engines/analytics — it never recomputes
// licensing or coupon logic:
//   • getAdminAnalytics    → revenue / license-sales / coupon metrics / by-tier
//   • listCoupons          → coupon lifecycle rollup + client-safe views
//   • eventLicenses counts → status + expiry rollup (bounded count() aggregations)
//   • adminAuditLogs + licenseHistory → merged governance timeline
// Every best-effort read is guarded so a missing index degrades to 0, never a 500.

import { Timestamp } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import { getAdminAnalytics } from '@/lib/analytics/adminAnalytics'
import { listCoupons } from '@/lib/admin/licenseCouponService'
import { deriveCouponLifecycle } from '@/lib/licensing/coupons/validate'
import { LICENSE_HISTORY_COLLECTION } from '@/lib/licensing/schema'
import type {
  LicenseCenterOverview, LicenseCenterTimelineEntry,
  HealthIndicator, HealthLevel, CenterTimelineSource,
} from '@/lib/admin/licenseCenterTypes'

const LICENSES = () => adminDb.collection('eventLicenses')

function tsToISO(ts: unknown): string | null {
  if (ts && typeof (ts as { toDate?: () => Date }).toDate === 'function') {
    try { return (ts as { toDate: () => Date }).toDate().toISOString() } catch { return null }
  }
  if (typeof ts === 'string' && ts) return ts
  return null
}
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null)

async function countOf(q: FirebaseFirestore.Query): Promise<number> {
  try { return (await q.count().get()).data().count } catch { return 0 }
}

// ─── Overview ────────────────────────────────────────────────────────────────

export async function getLicenseCenterOverview(): Promise<LicenseCenterOverview> {
  const now = Timestamp.now()

  const [analytics, coupons, total, active, pending, suspended, cancelled, consumed, expired] = await Promise.all([
    getAdminAnalytics().catch(() => null),
    listCoupons({ includeArchived: true }).catch(() => []),
    countOf(LICENSES()),
    countOf(LICENSES().where('status', '==', 'active')),
    countOf(LICENSES().where('status', '==', 'pending')),
    countOf(LICENSES().where('admin.lifecycle', '==', 'suspended')),
    countOf(LICENSES().where('admin.lifecycle', '==', 'cancelled')),
    countOf(LICENSES().where('consumed', '==', true)),
    countOf(LICENSES().where('expiresAt', '<', now)),
  ])

  // Coupon lifecycle rollup (single bounded read, in-memory tally).
  const nowMs = Date.now()
  const couponCounts = { total: 0, active: 0, paused: 0, scheduled: 0, expired: 0, archived: 0 }
  const campaignSet = new Set<string>()
  for (const c of coupons) {
    couponCounts.total++
    const lc = c.lifecycle ?? deriveCouponLifecycle(c, nowMs)
    if (lc === 'active') couponCounts.active++
    else if (lc === 'paused') couponCounts.paused++
    else if (lc === 'scheduled') couponCounts.scheduled++
    else if (lc === 'expired') couponCounts.expired++
    else if (lc === 'archived') couponCounts.archived++
    if (c.campaign) campaignSet.add(c.campaign)
  }

  const sales = analytics?.licenseSales
  const revenue = {
    licenseRevenuePaise: sales?.revenuePaise ?? 0,
    paidCount:           sales?.paidCount ?? 0,
    refundedCount:       sales?.refundedCount ?? 0,
    discountGivenPaise:  sales?.discountGivenPaise ?? 0,
    couponRedemptions:   sales?.couponRedemptions ?? 0,
  }

  // ── Health ──
  const health: HealthIndicator[] = []
  const push = (key: HealthIndicator['key'], label: string, level: HealthLevel, detail: string) => health.push({ key, label, level, detail })

  push('license_engine', 'License Engine', active > 0 ? 'green' : total > 0 ? 'yellow' : 'neutral', `${active} active / ${total}`)
  push('coupon_engine', 'Coupon Engine', couponCounts.active > 0 ? 'green' : couponCounts.total > 0 ? 'yellow' : 'neutral', `${couponCounts.active} active / ${couponCounts.total}`)
  push('payments', 'Payments', revenue.paidCount > 0 ? 'green' : 'neutral', `${revenue.paidCount} paid · ${revenue.refundedCount} refunded`)
  push('revenue', 'Revenue', revenue.licenseRevenuePaise > 0 ? 'green' : 'neutral', `₹${Math.round(revenue.licenseRevenuePaise / 100).toLocaleString('en-IN')}`)
  push('expiry', 'Expiry', expired > 0 ? 'yellow' : 'green', expired > 0 ? `${expired} expired windows` : 'None expired')
  push('campaigns', 'Campaigns', campaignSet.size > 0 ? 'green' : 'neutral', `${campaignSet.size} campaigns`)
  const discountRatio = revenue.licenseRevenuePaise > 0 ? revenue.discountGivenPaise / (revenue.licenseRevenuePaise + revenue.discountGivenPaise) : 0
  push('discount_budget', 'Discount Budget', discountRatio > 0.4 ? 'yellow' : 'green',
    `₹${Math.round(revenue.discountGivenPaise / 100).toLocaleString('en-IN')} given (${Math.round(discountRatio * 100)}%)`)

  return {
    licenses: { total, active, pending, suspended, cancelled, consumed, expired },
    coupons: { ...couponCounts, campaigns: campaignSet.size },
    revenue,
    topCoupons: sales?.topCoupons ?? [],
    byCampaign: sales?.byCampaign ?? [],
    byTier:     sales?.byTier ?? [],
    health,
  }
}

// ─── Timeline (merged license history + coupon/license audit) ────────────────

export async function getLicenseCenterTimeline(): Promise<LicenseCenterTimelineEntry[]> {
  const [auditSnap, historySnap] = await Promise.all([
    adminDb.collection('adminAuditLogs').orderBy('createdAt', 'desc').limit(300).get().catch(() => null),
    adminDb.collection(LICENSE_HISTORY_COLLECTION).orderBy('createdAt', 'desc').limit(150).get().catch(() => null),
  ])

  const entries: LicenseCenterTimelineEntry[] = []

  // License history (immutable purchase/consumption/expiry/override records).
  for (const d of historySnap?.docs ?? []) {
    const x = d.data() as Record<string, unknown>
    const from = str(x.fromTier)
    const to   = str(x.toTier)
    entries.push({
      id:     `history:${d.id}`,
      source: 'license',
      action: str(x.action) ?? 'license_change',
      detail: str(x.note) ?? str(x.reason) ?? `${from ? `${from} → ` : ''}${to ?? ''}`.trim(),
      actor:  str(x.actorUid),
      entity: str(x.eventId),
      at:     tsToISO(x.createdAt),
    })
  }

  // Admin audit — only license / coupon / billing entities belong here.
  for (const d of auditSnap?.docs ?? []) {
    const x = d.data() as Record<string, unknown>
    const entityType = String(x.entityType ?? '')
    let source: CenterTimelineSource | null = null
    if (entityType === 'license') source = 'license'
    else if (entityType === 'license_coupon') source = 'coupon'
    else if (entityType === 'billing') source = 'billing'
    if (!source) continue
    const meta = x.metadata && typeof x.metadata === 'object' ? (x.metadata as Record<string, unknown>) : {}
    entries.push({
      id:     `audit:${d.id}`,
      source,
      action: str(x.action) ?? 'admin.action',
      detail: str(meta.reason) ?? str(meta.note) ?? String(x.action ?? '').replace(/[._]/g, ' '),
      actor:  str(x.adminUid),
      entity: str(x.entityId),
      at:     tsToISO(x.createdAt),
    })
  }

  entries.sort((a, b) => (b.at ? Date.parse(b.at) : -Infinity) - (a.at ? Date.parse(a.at) : -Infinity))
  return entries.slice(0, 300)
}
