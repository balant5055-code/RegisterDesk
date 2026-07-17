// Operations health aggregation (Phase G.4). Server-only, READ-ONLY.
//
// Builds the admin Operations dashboard snapshot. Uses Firestore count()
// aggregation queries (one cheap aggregation read each, no document reads) for
// every counter, plus a handful of tiny limit-1 / small-scan reads for "oldest"
// and "stuck" figures. Does not touch any business logic.

import { adminDb } from '@/lib/firebase/admin'
import { OPERATIONS_METRICS, type CronMetricDoc } from '@/lib/monitoring/cronMetrics'

type Query = FirebaseFirestore.Query

async function countOf(q: Query): Promise<number> {
  try { return (await q.count().get()).data().count } catch { return -1 }   // -1 = query failed
}

function tsToISO(v: unknown): string | null {
  if (v && typeof (v as { toDate?: () => Date }).toDate === 'function') return (v as { toDate: () => Date }).toDate().toISOString()
  return null
}
function tsToMillis(v: unknown): number {
  if (v && typeof (v as { toMillis?: () => number }).toMillis === 'function') return (v as { toMillis: () => number }).toMillis()
  if (typeof v === 'string') { const t = Date.parse(v); return Number.isNaN(t) ? 0 : t }
  return 0
}

export interface FinancialHealth {
  pendingSettlements: number
  failedRefunds: number
  pendingWalletTopups: number
  pendingRegistrationReconciliation: number
  pendingDonationReconciliation: number
  outstandingClawbacks: number
}
export interface WebhookHealth {
  pendingDeliveries: number
  failedDeliveries: number
  exhaustedRetries: number
  oldestPendingAt: string | null
}
export interface BroadcastHealth {
  scheduled: number
  sending: number
  failed: number
  stuckSending: number
}
export interface CronHealthEntry {
  cronName: string
  lastSuccessAt: string | null
  lastFailureAt: string | null
  runCount: number
  failureCount: number
  lastOk: boolean | null
  failedWithin24h: boolean
  stale: boolean   // GA-7E S1: last success older than its expected interval (stopped firing)
}
export interface DataIntegrity {
  eventMismatches:    number   // counter mismatches in the last 48h
  passMismatches:     number
  campaignMismatches: number
  sessionMismatches:  number
  walletMismatches:   number   // report-only — financial, never auto-repaired
}
export interface OperationsHealth {
  financial:    FinancialHealth
  webhook:      WebhookHealth
  broadcast:    BroadcastHealth
  dataIntegrity: DataIntegrity
  crons:        CronHealthEntry[]
  generatedAt:  string
}

const STUCK_SENDING_MS = 30 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

// Every scheduled cron that records execution metrics (GA-7E S1: completed to the
// full set of 20 — added storage-cleanup — so the health panel has no blind spots).
const CRON_NAMES = [
  'broadcasts', 'webhooks', 'release-funds', 'reminders',
  'wallet-reconciliation', 'registration-reconciliation',
  'donation-reconciliation', 'session-reconciliation',
  'global-reconciliation',
  'certificate-jobs', 'certificate-claims',
  'registration-import', 'registration-bulk',
  'whatsapp-broadcasts', 'email-broadcasts', 'report-exports',
  'print-generation', 'print-packaging', 'ops-alerts', 'storage-cleanup',
]

// GA-7E S1: expected execution interval per cron (from vercel.json schedules), used to
// detect a cron that has STOPPED FIRING — the audit's dead-cron blind spot. evaluateAlerts
// only flagged RECORDED failures; a cron that silently stops (scheduler drop, 401, boot
// crash) records nothing and was invisible.
const MIN = 60 * 1000
const CRON_INTERVAL_MS: Record<string, number> = {
  'certificate-jobs': MIN, 'registration-import': MIN, 'registration-bulk': MIN,
  'broadcasts': MIN, 'whatsapp-broadcasts': MIN, 'email-broadcasts': MIN,
  'report-exports': MIN, 'print-generation': MIN, 'print-packaging': MIN, 'webhooks': MIN,
  'registration-reconciliation': 10 * MIN, 'wallet-reconciliation': 10 * MIN, 'donation-reconciliation': 10 * MIN,
  'certificate-claims': 15 * MIN, 'reminders': 15 * MIN, 'ops-alerts': 15 * MIN,
  'release-funds': 60 * MIN,
  'session-reconciliation': 24 * 60 * MIN, 'global-reconciliation': 24 * 60 * MIN, 'storage-cleanup': 24 * 60 * MIN,
}
// A cron is STALE when its last success is older than 2× its interval + a 5-min grace
// (tolerates an occasional skipped run without false-positiving). A never-recorded cron is
// left to the dashboard (lastSuccessAt null) to avoid false alerts right after a deploy.
function staleThresholdMs(interval: number): number { return interval * 2 + 5 * MIN }
function isStale(name: string, lastSuccessMs: number, now: number): boolean {
  const interval = CRON_INTERVAL_MS[name]
  return interval != null && lastSuccessMs > 0 && now - lastSuccessMs > staleThresholdMs(interval)
}
// Staleness on these financial/integrity crons is a CRITICAL page; others are a warning.
const CRITICAL_STALE_CRONS = new Set([
  'wallet-reconciliation', 'registration-reconciliation', 'donation-reconciliation',
  'session-reconciliation', 'global-reconciliation', 'release-funds', 'webhooks',
])

const DATA_INTEGRITY_WINDOW_MS = 48 * 60 * 60 * 1000

export async function getOperationsHealth(): Promise<OperationsHealth> {
  const col = (name: string) => adminDb.collection(name)
  const now = Date.now()

  // ── Financial ──
  const financialP = Promise.all([
    countOf(col('settlementRequests').where('status', '==', 'pending')),
    countOf(col('failedRefunds').where('status', '==', 'open')),
    countOf(col('walletTopupReconciliation').where('status', '==', 'pending')),
    countOf(col('registrationFinancialReconciliation').where('status', '==', 'pending')),
    countOf(col('donationFinancialReconciliation').where('status', '==', 'pending')),
    countOf(col('walletClawbacks').where('status', 'in', ['open', 'partially_recovered'])),
  ])

  // ── Webhook ──
  const webhookP = Promise.all([
    countOf(col('webhookDeliveries').where('status', '==', 'pending')),
    countOf(col('webhookDeliveries').where('status', '==', 'failed')),
    // oldest pending — tiny query using the existing (status, nextRetryAt) index.
    col('webhookDeliveries').where('status', '==', 'pending').orderBy('nextRetryAt', 'asc').limit(1).get()
      .then(s => (s.empty ? null : tsToISO((s.docs[0].data() as { createdAt?: unknown }).createdAt) ?? tsToISO((s.docs[0].data() as { nextRetryAt?: unknown }).nextRetryAt)))
      .catch(() => null),
  ])

  // ── Broadcast ── (stuck = sending older than 30 min; small scan, sending set is tiny)
  const broadcastP = Promise.all([
    countOf(col('broadcastCampaigns').where('status', '==', 'scheduled')),
    countOf(col('broadcastCampaigns').where('status', '==', 'sending')),
    countOf(col('broadcastCampaigns').where('status', '==', 'failed')),
    col('broadcastCampaigns').where('status', '==', 'sending').limit(200).get()
      .then(s => s.docs.filter(d => {
        const data = d.data() as { updatedAt?: unknown; createdAt?: unknown }
        const started = tsToMillis(data.updatedAt) || tsToMillis(data.createdAt)
        return started > 0 && now - started > STUCK_SENDING_MS
      }).length)
      .catch(() => -1),
  ])

  // ── Cron metrics ──
  const cronP = col(OPERATIONS_METRICS).get().then(snap => {
    const byName = new Map<string, CronMetricDoc>()
    for (const d of snap.docs) byName.set(d.id, d.data() as CronMetricDoc)
    return CRON_NAMES.map<CronHealthEntry>(name => {
      const m = byName.get(name)
      const lastFailureMs = m ? tsToMillis(m.lastFailureAt) : 0
      const lastSuccessMs = m ? tsToMillis(m.lastSuccessAt) : 0
      return {
        cronName: name,
        lastSuccessAt: m ? tsToISO(m.lastSuccessAt) : null,
        lastFailureAt: m ? tsToISO(m.lastFailureAt) : null,
        runCount: m?.runCount ?? 0,
        failureCount: m?.failureCount ?? 0,
        lastOk: m ? m.lastOk : null,
        // A genuine recent failure: failed in the last 24h and not since recovered.
        failedWithin24h: lastFailureMs > 0 && now - lastFailureMs < DAY_MS && lastFailureMs >= lastSuccessMs,
        stale: isStale(name, lastSuccessMs, now),
      }
    })
  }).catch(() => CRON_NAMES.map<CronHealthEntry>(name => ({
    cronName: name, lastSuccessAt: null, lastFailureAt: null, runCount: 0, failureCount: 0, lastOk: null, failedWithin24h: false, stale: false,
  })))

  // ── Data integrity ── tally recent reconciliationReports (last 48h) by type.
  const integrityP = col('reconciliationReports').orderBy('createdAt', 'desc').limit(1000).get()
    .then(snap => {
      const cutoff = now - DATA_INTEGRITY_WINDOW_MS
      const t = { event: 0, pass: 0, campaign: 0, session: 0, wallet: 0 }
      for (const d of snap.docs) {
        const r = d.data() as { entityType?: string; createdAt?: unknown }
        if (tsToMillis(r.createdAt) < cutoff) break   // desc order → rest are older
        const key = r.entityType
        if (key === 'event' || key === 'pass' || key === 'campaign' || key === 'session' || key === 'wallet') t[key]++
      }
      return t
    })
    .catch(() => ({ event: -1, pass: -1, campaign: -1, session: -1, wallet: -1 }))

  const [fin, wh, bc, integrity, crons] = await Promise.all([financialP, webhookP, broadcastP, integrityP, cronP])

  return {
    financial: {
      pendingSettlements: fin[0], failedRefunds: fin[1], pendingWalletTopups: fin[2],
      pendingRegistrationReconciliation: fin[3], pendingDonationReconciliation: fin[4], outstandingClawbacks: fin[5],
    },
    webhook: { pendingDeliveries: wh[0], failedDeliveries: wh[1], exhaustedRetries: wh[1], oldestPendingAt: wh[2] },
    broadcast: { scheduled: bc[0], sending: bc[1], failed: bc[2], stuckSending: bc[3] },
    dataIntegrity: {
      eventMismatches: integrity.event, passMismatches: integrity.pass,
      campaignMismatches: integrity.campaign, sessionMismatches: integrity.session,
      walletMismatches: integrity.wallet,
    },
    crons,
    generatedAt: new Date(now).toISOString(),
  }
}

// ─── Alert rules (Phase G.4 requirement 4) ─────────────────────────────────────

export type AlertSeverity = 'critical' | 'warning'
export interface OperationalAlert { id: string; severity: AlertSeverity; message: string }

export function evaluateAlerts(h: OperationsHealth): OperationalAlert[] {
  const alerts: OperationalAlert[] = []
  const push = (id: string, severity: AlertSeverity, message: string) => alerts.push({ id, severity, message })

  if (h.financial.failedRefunds > 0) push('failed_refunds', 'critical', `${h.financial.failedRefunds} failed refund(s) need manual action.`)
  if (h.financial.outstandingClawbacks > 0) push('clawbacks', 'warning', `${h.financial.outstandingClawbacks} outstanding clawback(s).`)
  if (h.webhook.failedDeliveries > 10) push('webhook_failures', 'warning', `${h.webhook.failedDeliveries} webhook deliveries have failed (>10).`)
  const failedCrons = h.crons.filter(c => c.failedWithin24h)
  if (failedCrons.length > 0) push('cron_failure', 'critical', `Cron failure in the last 24h: ${failedCrons.map(c => c.cronName).join(', ')}.`)

  // GA-7E S1 — dead-cron staleness: a cron that has stopped firing (last success too old).
  const staleCrons = h.crons.filter(c => c.stale)
  const staleCritical = staleCrons.filter(c => CRITICAL_STALE_CRONS.has(c.cronName))
  const staleWarn     = staleCrons.filter(c => !CRITICAL_STALE_CRONS.has(c.cronName))
  if (staleCritical.length > 0) push('cron_stale_critical', 'critical', `Cron(s) have stopped running: ${staleCritical.map(c => c.cronName).join(', ')}.`)
  if (staleWarn.length > 0)     push('cron_stale', 'warning', `Cron(s) may have stopped running: ${staleWarn.map(c => c.cronName).join(', ')}.`)

  // GA-7E S1 — financial integrity: wallet mismatches are report-only (never auto-repaired),
  // so a mismatch requires manual review and must PAGE, not sit on a dashboard.
  if (h.dataIntegrity.walletMismatches > 0) push('wallet_mismatch', 'critical', `${h.dataIntegrity.walletMismatches} wallet balance mismatch(es) detected (report-only) — manual review required.`)
  // Other counter drift auto-repairs, but persistent drift is worth surfacing (guard -1 = query failed).
  const drift = Math.max(0, h.dataIntegrity.eventMismatches) + Math.max(0, h.dataIntegrity.passMismatches)
    + Math.max(0, h.dataIntegrity.campaignMismatches) + Math.max(0, h.dataIntegrity.sessionMismatches)
  if (drift > 0) push('counter_drift', 'warning', `${drift} counter mismatch(es) detected in the last 48h.`)

  return alerts
}

// GA-7E S1 — lightweight cron-health summary for the /api/health probe. Reads ONLY the
// operationsMetrics collection (one small doc per cron), NOT the financial/webhook/broadcast
// aggregations, so an uptime probe stays cheap.
export interface CronHealthSummary { tracked: number; failing: number; stale: number; staleNames: string[] }

export async function getCronHealthSummary(): Promise<CronHealthSummary> {
  const now = Date.now()
  const snap = await adminDb.collection(OPERATIONS_METRICS).get()
  const byName = new Map<string, CronMetricDoc>()
  for (const d of snap.docs) byName.set(d.id, d.data() as CronMetricDoc)
  let failing = 0, stale = 0
  const staleNames: string[] = []
  for (const name of CRON_NAMES) {
    const m = byName.get(name)
    const lastFailureMs = m ? tsToMillis(m.lastFailureAt) : 0
    const lastSuccessMs = m ? tsToMillis(m.lastSuccessAt) : 0
    if (lastFailureMs > 0 && now - lastFailureMs < DAY_MS && lastFailureMs >= lastSuccessMs) failing++
    if (isStale(name, lastSuccessMs, now)) { stale++; staleNames.push(name) }
  }
  return { tracked: CRON_NAMES.length, failing, stale, staleNames }
}
