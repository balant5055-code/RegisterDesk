// Platform Monitoring aggregation service (GA-2 S5). Server-only.
//
// Composes EXISTING analytics/health sources into a platform-health view. It never
// recomputes business logic and never fabricates: a metric that cannot be derived
// is returned as null so the UI shows "Unavailable".
//   • getAdminAnalytics      → platform KPIs, license sales, communication rollup
//   • getAdminCommunications → email / whatsapp service health
//   • ENGINES (Ops Center)   → per-engine job rollup (print/cert/report/…)
//   • adminAuditLogs         → security + audit health
// Bounded count()/sum() aggregations only — no scans, no polling.

import { Timestamp, AggregateField } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import { getAdminAnalytics } from '@/lib/analytics/adminAnalytics'
import { getAdminCommunications } from '@/lib/analytics/adminCommunications'
import { ENGINES } from '@/lib/admin/operationsCenterService'
import type {
  PlatformOverview, PlatformKpis, ServiceHealth, ServiceLevel, PlatformSecurity,
  SecurityAuditEntry, HealthIndicator, HealthLevel,
} from '@/lib/admin/platformMonitorTypes'

const ALL_JOB_COLLECTIONS = [...new Set(ENGINES.flatMap(e => e.collections))]

function tsToISO(ts: unknown): string | null {
  if (ts && typeof (ts as { toDate?: () => Date }).toDate === 'function') {
    try { return (ts as { toDate: () => Date }).toDate().toISOString() } catch { return null }
  }
  return null
}
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null)

async function countOf(q: FirebaseFirestore.Query): Promise<number> {
  try { return (await q.count().get()).data().count } catch { return 0 }
}
// Honesty-preserving: null means "could not be derived" (→ Unavailable), not zero.
async function tryCount(q: FirebaseFirestore.Query): Promise<number | null> {
  try { return (await q.count().get()).data().count } catch { return null }
}
async function trySum(q: FirebaseFirestore.Query, field: string): Promise<number | null> {
  try { return (await q.aggregate({ s: AggregateField.sum(field) }).get()).data().s ?? 0 } catch { return null }
}

function startOfTodayTs(): Timestamp {
  const d = new Date(); d.setUTCHours(0, 0, 0, 0)
  return Timestamp.fromMillis(d.getTime())
}

// Running (processing) + failed across every job collection — lightweight rollup.
async function jobRollup(): Promise<{ running: number; failed: number }> {
  let running = 0, failed = 0
  await Promise.all(ALL_JOB_COLLECTIONS.map(async c => {
    const col = adminDb.collection(c)
    const [p, f] = await Promise.all([countOf(col.where('status', '==', 'processing')), countOf(col.where('status', '==', 'failed'))])
    running += p; failed += f
  }))
  return { running, failed }
}

// ─── Overview ──────────────────────────────────────────────────────────────

export async function getPlatformOverview(): Promise<PlatformOverview> {
  const today = startOfTodayTs()

  const [analytics, rollup, regsToday, txToday, revToday] = await Promise.all([
    getAdminAnalytics().catch(() => null),
    jobRollup(),
    tryCount(adminDb.collection('registrations').where('registeredAt', '>=', today)),
    tryCount(adminDb.collection('platformTransactions').where('createdAt', '>=', today)),
    trySum(adminDb.collection('platformTransactions').where('createdAt', '>=', today), 'grossAmountPaise'),
  ])

  const kpis: PlatformKpis = {
    activeOrganizers:  analytics?.platform.organizers ?? 0,
    activeEvents:      analytics?.platform.publishedEvents ?? 0,
    registrationsToday: regsToday,
    paymentsToday:      txToday,
    revenueTodayPaise:  revToday,
    lifetimeRevenuePaise: analytics?.platform.lifetimeGrossPaise ?? 0,
    runningJobs:       rollup.running,
    failedJobs:        rollup.failed,
  }

  const comm = analytics?.communication
  const ls   = analytics?.licenseSales

  const health: HealthIndicator[] = []
  const push = (key: HealthIndicator['key'], label: string, level: HealthLevel, detail: string) => health.push({ key, label, level, detail })

  push('platform', 'Platform', kpis.activeEvents > 0 && kpis.activeOrganizers > 0 ? 'green' : kpis.activeOrganizers > 0 ? 'yellow' : 'neutral',
    `${kpis.activeOrganizers} organizers · ${kpis.activeEvents} events`)

  push('payments', 'Payments', kpis.lifetimeRevenuePaise > 0 ? 'green' : 'neutral',
    `₹${Math.round(kpis.lifetimeRevenuePaise / 100).toLocaleString('en-IN')} lifetime`)

  const commFailRate = comm && (comm.totalSent + comm.totalFailed) > 0 ? comm.totalFailed / (comm.totalSent + comm.totalFailed) : 0
  push('communications', 'Communications', !comm || (comm.totalSent + comm.totalFailed) === 0 ? 'neutral' : commFailRate > 0.15 ? 'yellow' : 'green',
    comm ? `${comm.totalSent} sent · ${comm.totalFailed} failed` : 'Unavailable')

  push('operations', 'Operations', rollup.failed > 10 ? 'red' : rollup.failed > 0 ? 'yellow' : 'green',
    `${rollup.running} running · ${rollup.failed} failed`)

  const audit24h = await tryCount(adminDb.collection('adminAuditLogs').where('createdAt', '>=', Timestamp.fromMillis(Date.now() - 24 * 3600 * 1000)))
  push('security', 'Security', audit24h == null ? 'neutral' : 'green', audit24h == null ? 'Unavailable' : `${audit24h} admin actions / 24h`)

  push('licensing', 'Licensing', ls && ls.paidCount > 0 ? 'green' : 'neutral', ls ? `${ls.paidCount} paid licenses` : 'Unavailable')

  // Honest: no Firestore/Storage metrics source exists → Unavailable (neutral).
  push('storage', 'Storage', 'neutral', 'Unavailable')
  // Infrastructure (cron health) is evaluated in its own workspace (getOperationsHealth).
  push('infrastructure', 'Infrastructure', 'neutral', 'Open Infrastructure')

  const version = str(process.env.APP_VERSION)
    ?? str(process.env.npm_package_version)
    ?? (process.env.VERCEL_GIT_COMMIT_SHA ? process.env.VERCEL_GIT_COMMIT_SHA.slice(0, 7) : null)

  return { kpis, health, version }
}

// ─── Services ──────────────────────────────────────────────────────────────

async function engineJobHealth(engineKey: string): Promise<{ completed: number; failed: number; total: number }> {
  const engine = ENGINES.find(e => e.key === engineKey)
  if (!engine) return { completed: 0, failed: 0, total: 0 }
  let completed = 0, failed = 0, total = 0
  await Promise.all(engine.collections.map(async c => {
    const col = adminDb.collection(c)
    const [cDone, cFail, cTot] = await Promise.all([countOf(col.where('status', '==', 'completed')), countOf(col.where('status', '==', 'failed')), countOf(col)])
    completed += cDone; failed += cFail; total += cTot
  }))
  return { completed, failed, total }
}

function jobService(key: string, label: string, r: { completed: number; failed: number; total: number }): ServiceHealth {
  const level: ServiceLevel = r.total === 0 ? 'unavailable' : r.failed > 0 ? 'warning' : 'healthy'
  const metric = r.total === 0 ? null : `${r.completed} ok · ${r.failed} failed`
  return { key, label, level, detail: r.total === 0 ? 'No jobs yet' : `${r.total} jobs`, metric }
}

export async function getPlatformServices(): Promise<ServiceHealth[]> {
  const [analytics, comm, cert, print, report] = await Promise.all([
    getAdminAnalytics().catch(() => null),
    getAdminCommunications().catch(() => null),
    engineJobHealth('certificate'),
    engineJobHealth('print'),
    engineJobHealth('export'),
  ])

  const services: ServiceHealth[] = []
  const ls = analytics?.licenseSales

  // Payments
  services.push(ls == null
    ? { key: 'payments', label: 'Payments', level: 'unavailable', detail: 'Unavailable', metric: null }
    : {
        key: 'payments', label: 'Payments',
        level: ls.revenuePaise > 0 ? (ls.refundedCount > ls.paidCount ? 'warning' : 'healthy') : 'unavailable',
        detail: `${ls.paidCount} paid · ${ls.refundedCount} refunded`,
        metric: `₹${Math.round(ls.revenuePaise / 100).toLocaleString('en-IN')}`,
      })

  // Email + WhatsApp
  if (!comm) {
    services.push({ key: 'email', label: 'Email', level: 'unavailable', detail: 'Unavailable', metric: null })
    services.push({ key: 'whatsapp', label: 'WhatsApp', level: 'unavailable', detail: 'Unavailable', metric: null })
  } else {
    const m = comm.messages
    const emailTotal = m.sent + m.delivered + m.failed + m.skipped + m.queued
    const emailFailRate = emailTotal > 0 ? m.failed / emailTotal : 0
    services.push({ key: 'email', label: 'Email', level: emailTotal === 0 ? 'unavailable' : emailFailRate > 0.15 ? 'warning' : 'healthy', detail: `${m.sent + m.delivered} delivered · ${m.failed} failed`, metric: emailTotal === 0 ? null : `${emailTotal} messages` })
    services.push({ key: 'whatsapp', label: 'WhatsApp', level: m.whatsapp > 0 ? 'healthy' : 'unavailable', detail: m.whatsapp > 0 ? 'Active' : 'No WhatsApp activity', metric: m.whatsapp > 0 ? `${m.whatsapp} messages` : null })
  }

  // Job-backed services
  services.push(jobService('certificates', 'Certificates', cert))
  services.push(jobService('print', 'Print', print))
  services.push(jobService('reports', 'Reports & Exports', report))

  // Licensing + Coupons (from license sales)
  services.push(ls == null
    ? { key: 'licensing', label: 'Licensing', level: 'unavailable', detail: 'Unavailable', metric: null }
    : { key: 'licensing', label: 'Licensing', level: ls.paidCount > 0 ? 'healthy' : 'unavailable', detail: `${ls.paidCount} paid licenses`, metric: ls.paidCount > 0 ? `${ls.paidCount}` : null })
  services.push(ls == null
    ? { key: 'coupons', label: 'Coupons', level: 'unavailable', detail: 'Unavailable', metric: null }
    : { key: 'coupons', label: 'Coupons', level: ls.couponRedemptions > 0 ? 'healthy' : 'unavailable', detail: ls.couponRedemptions > 0 ? `${ls.couponRedemptions} redemptions` : 'No redemptions', metric: ls.couponRedemptions > 0 ? `${ls.couponRedemptions}` : null })

  return services
}

// ─── Security ──────────────────────────────────────────────────────────────

const OVERRIDE_HINTS = ['override', 'plan.', 'governance_override', 'force_consumed', 'reset', 'feature_override', 'limit_override', 'price_override']
const MODERATION_HINTS = ['taken_down', 'restored', 'under_review', 'suspended', 'banned', 'report.']
const FINANCE_ENTITIES = new Set(['settlement', 'finance', 'payout_profile', 'failed_refund', 'clawback', 'donation'])

function mapAudit(id: string, x: Record<string, unknown>): SecurityAuditEntry {
  const meta = x.metadata && typeof x.metadata === 'object' ? (x.metadata as Record<string, unknown>) : {}
  return {
    id, action: String(x.action ?? 'admin.action'), entityType: String(x.entityType ?? ''),
    entityId: str(x.entityId), actor: str(x.adminUid),
    reason: str(meta.reason) ?? str(meta.note),
    at: tsToISO(x.createdAt),
  }
}

export async function getPlatformSecurity(): Promise<PlatformSecurity> {
  const dayAgo = Timestamp.fromMillis(Date.now() - 24 * 3600 * 1000)
  const [snap, last24h] = await Promise.all([
    adminDb.collection('adminAuditLogs').orderBy('createdAt', 'desc').limit(120).get().catch(() => null),
    tryCount(adminDb.collection('adminAuditLogs').where('createdAt', '>=', dayAgo)),
  ])

  const entries = (snap?.docs ?? []).map(d => mapAudit(d.id, d.data() as Record<string, unknown>))
  const isOverride = (e: SecurityAuditEntry) => OVERRIDE_HINTS.some(h => e.action.includes(h)) || e.entityType === 'license_coupon' || e.entityType === 'billing'
  const isModeration = (e: SecurityAuditEntry) => MODERATION_HINTS.some(h => e.action.includes(h))
  const isFinance = (e: SecurityAuditEntry) => FINANCE_ENTITIES.has(e.entityType)

  return {
    auditHealth: { last24h: last24h ?? 0, lastEntryAt: entries[0]?.at ?? null, writing: (last24h ?? 0) > 0 },
    counts: {
      total: entries.length,
      overrides: entries.filter(isOverride).length,
      moderation: entries.filter(isModeration).length,
      finance: entries.filter(isFinance).length,
    },
    recentActivity: entries.slice(0, 60),
    overrides: entries.filter(isOverride).slice(0, 40),
  }
}
