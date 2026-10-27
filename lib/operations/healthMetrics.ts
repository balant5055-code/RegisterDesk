// Operations health aggregation (Phase G.4). Server-only, READ-ONLY.
//
// Builds the admin Operations dashboard snapshot. Uses Firestore count()
// aggregation queries (one cheap aggregation read each, no document reads) for
// every counter, plus a handful of tiny limit-1 / small-scan reads for "oldest"
// and "stuck" figures. Does not touch any business logic.

import { FieldPath, Timestamp } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import { PRINT_BADGE_ROUNDS, STALE_ROUND_MS } from '@/lib/printAssets/badgeBilling/decisions'
import { OPERATIONS_METRICS, type CronMetricDoc } from '@/lib/monitoring/cronMetrics'
import { REFUND_HOLD_MIN_RELEASE_AGE_MS } from '@/lib/licensing/licenceRefundHold'

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
  /** walletTopupReconciliation 'pending' — a captured top-up whose credit the cron is retrying (auto-drains). */
  pendingWalletTopups: number
  // RD-WALLET-W2.g (G10) — HELD top-up records: never retried, waiting for a Super Admin (Admin ›
  // Wallet Top-ups), and each one blocks its organizer's next top-up. One status each — a record has
  // exactly one — so these never overlap each other or `pendingWalletTopups`. Order-level holds are
  // not counted separately: every held order carries its own per-payment records (no double count).
  walletTopupsNeedsReview:      number   // 'needs_review'
  walletTopupsExhausted:        number   // 'exhausted' (W2.a retry limit reached)
  walletTopupDuplicatePayments: number   // 'duplicate_payment'
  pendingRegistrationReconciliation: number
  pendingDonationReconciliation: number
  outstandingClawbacks: number
  /** RD-PRINT-P8 (W6) — badge purchase payments recorded as suspicious and not yet reviewed (-1 = query failed). */
  badgeSuspiciousUnreviewed: number
  /** RD-PRINT-P8 (W6) — open badge billing rounds older than 24 h, from a bounded scan (a lower bound; -1 = failed). */
  badgeRoundsStale: number
  /** RD-SA-COMMERCE-P1 (P1-5) — licence refund holds older than 15 min: an unfinished refund that is blocking
   *  ALL sales of its event (-1 = query failed). Never auto-released — a Super Admin resolves each one. */
  licenceRefundHoldsStale: number
  /** Licence orders in `refunding` (an unfinished refund; includes ones the pre-hold code left; -1 = failed). */
  licenceOrdersRefunding: number
  /** M2 — licences whose refund the gateway accepted then reported FAILED, not yet acknowledged (-1 = failed). */
  licenceRefundFailuresOpen: number
  /** M1 — settlement refund-hold closures that failed and wait in refundHoldClosureReconciliation (-1 = failed). */
  refundHoldClosuresPending: number
  /** Phase 2 — donation refunds the gateway PROCESSED whose accounting failed and is being retried (-1 = failed). */
  donationRefundAccountingRetrying: number
  /** Phase 2 — donation refund accounting that exhausted retries or failed permanently: manual (-1 = failed). */
  donationRefundAccountingNeedsReview: number
  /** Phase 2 — donation refunds accepted but not reported processed by the gateway for > 24 h (-1 = failed; bounded scan). */
  donationRefundsAwaitingGatewayStale: number
  /** Phase 2.2 — donations with a refund REQUEST whose gateway outcome is unresolved (held; -1 = failed). */
  donationRefundAttemptsUnresolved: number
  /** Phase 3.3 — registration refund ledger reversals queued for retry (refundLedgerReconciliation 'pending'; -1 = failed). */
  refundLedgerReversalsPending: number
  /** Phase 3.3 — ledger reversals that exhausted their retries or failed permanently: manual (-1 = failed). */
  refundLedgerReversalsNeedsReview: number
  /** Phase 3.3 — hold closures the evidence REFUSED (an open contradiction; the hold stays; -1 = failed). */
  refundHoldClosuresRefused: number
  /** Phase 3.3 — hold closures that exhausted their retries or failed permanently: manual (-1 = failed). */
  refundHoldClosuresNeedsReview: number
  /** F1 — settlement transactions held because a refund of their payment is open for review (-1 = failed). */
  settlementsHeldForRefundReview: number
  /** F2 — registration refunds carrying a review reason (partial / contradictory / failed-after; -1 = failed). */
  registrationRefundsNeedingReview: number
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
  /** RD-NOTIFY-01 outbox — notification emails that gave up after every retry / ended without a
   *  confirmed send (suppressed or no definite provider answer). Optional: older fixtures omit it. */
  notificationEmailsFailed?: number
  notificationEmailsUnconfirmed?: number
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
  /** Phase 3.6A — per-donation refund integrity mismatches (report-only). */
  donationMismatches: number
  /** Phase 3.6A — wallets / donations whose checks could NOT complete (never counted as clean). */
  walletUnverifiable:   number
  donationUnverifiable: number
  /** Phase 3.8 — registration refund integrity mismatches / unverifiable checks (report-only). */
  registrationMismatches:   number
  registrationUnverifiable: number
  /** Phase 3.8 — settlement releases confirmed STUCK (a deterministic blocker) / overdue but unverifiable. */
  stuckReleases:            number
  releaseUnverifiable:      number
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
  // MC-05 — Media Credits financial reconciliation (grants + refund payouts).
  'media-credit-reconciliation',
  // MC-06D — upload-session reclamation (seal → settle → reservation cleanup).
  'media-credit-sessions',
]

// GA-7E S1: expected execution interval per cron, used to detect a cron that has STOPPED FIRING —
// the audit's dead-cron blind spot. evaluateAlerts only flagged RECORDED failures; a cron that
// silently stops (scheduler drop, 401, boot crash) records nothing and was invisible.
//
// RD-CRON-ALERT-01 — these MUST be the intervals of the scheduler that actually runs the routes:
// the GitHub Actions workflows (.github/workflows/cron-*.yml; vercel.json has no crons). They were
// copied from an earlier all-Vercel plan and never updated when scheduling moved, so `release-funds`
// was expected HOURLY while it runs DAILY at 02:00 UTC — every healthy run tripped the critical
// "Cron(s) have stopped running: release-funds" alert ~2 hours later. `webhooks` (1 min expected vs
// every 10 min) had the same defect. tests/unit/cronAlertIntervals.test.ts now pins every entry to
// its workflow's schedule.
const MIN = 60 * 1000
export const CRON_INTERVAL_MS: Record<string, number> = {
  // Group A — cron-runners.yml, every 5 minutes
  'certificate-jobs': 5 * MIN, 'registration-import': 5 * MIN, 'registration-bulk': 5 * MIN,
  'broadcasts': 5 * MIN, 'whatsapp-broadcasts': 5 * MIN, 'email-broadcasts': 5 * MIN,
  'report-exports': 5 * MIN, 'print-generation': 5 * MIN, 'print-packaging': 5 * MIN,
  // Group B — cron-recovery.yml, every 10 minutes
  'webhooks': 10 * MIN,
  'registration-reconciliation': 10 * MIN, 'wallet-reconciliation': 10 * MIN, 'donation-reconciliation': 10 * MIN,
  'reminders': 10 * MIN, 'ops-alerts': 10 * MIN,
  'media-credit-reconciliation': 10 * MIN,
  'media-credit-sessions': 10 * MIN,
  // RD-PRINT-P8 (W6) — ID-badge purchase and billing-round recovery.
  'badge-orders-reconcile': 10 * MIN, 'badge-rounds-reconcile': 10 * MIN,
  // Group C — cron-cleanup.yml, hourly
  'certificate-claims': 60 * MIN,
  // Group D — cron-maintenance.yml, daily at 02:00 UTC
  'release-funds': 24 * 60 * MIN,
  'session-reconciliation': 24 * 60 * MIN, 'global-reconciliation': 24 * 60 * MIN, 'storage-cleanup': 24 * 60 * MIN,
}
// A cron is STALE when its last success is older than 2× its interval + a 5-min grace
// (tolerates an occasional skipped run without false-positiving). A never-recorded cron is
// left to the dashboard (lastSuccessAt null) to avoid false alerts right after a deploy.
function staleThresholdMs(interval: number): number { return interval * 2 + 5 * MIN }
export function isStale(name: string, lastSuccessMs: number, now: number): boolean {
  const interval = CRON_INTERVAL_MS[name]
  return interval != null && lastSuccessMs > 0 && now - lastSuccessMs > staleThresholdMs(interval)
}
// Staleness on these financial/integrity crons is a CRITICAL page; others are a warning.
const CRITICAL_STALE_CRONS = new Set([
  'wallet-reconciliation', 'registration-reconciliation', 'donation-reconciliation',
  'session-reconciliation', 'global-reconciliation', 'release-funds', 'webhooks',
  // Staleness here means organizers are owed credits or payouts that nothing is retrying.
  'media-credit-reconciliation',
  // Staleness here means upload sessions are holding credits nothing will ever release.
  'media-credit-sessions',
  // RD-PRINT-P8 (W6) — staleness here means captured badge payments go unsettled, or badge units stay
  // reserved by rounds nothing is settling.
  'badge-orders-reconcile', 'badge-rounds-reconcile',
])

/** RD-PRINT-P8 (W6) — bounded scan for open badge rounds older than STALE_ROUND_MS (age checked in memory, no index). */
const STALE_ROUND_SCAN = 500
async function staleOpenBadgeRounds(now: number): Promise<number> {
  try {
    const snap = await adminDb.collection(PRINT_BADGE_ROUNDS).where('status', '==', 'reserved')
      .orderBy(FieldPath.documentId()).select('createdAt').limit(STALE_ROUND_SCAN).get()
    return snap.docs.filter(d => { const c = tsToMillis(d.get('createdAt')); return c > 0 && now - c > STALE_ROUND_MS }).length
  } catch {
    return -1
  }
}

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
    // RD-WALLET-W2.g — held top-up records, one status per count (single-field, no index).
    countOf(col('walletTopupReconciliation').where('status', '==', 'needs_review')),
    countOf(col('walletTopupReconciliation').where('status', '==', 'exhausted')),
    countOf(col('walletTopupReconciliation').where('status', '==', 'duplicate_payment')),
    // RD-PRINT-P8 (W6) — badge billing: unreviewed suspicious payments (equality only), stale open rounds.
    countOf(col('suspiciousPayments').where('purpose', '==', 'print_badges').where('reviewed', '==', false)),
    staleOpenBadgeRounds(now),
    // RD-SA-COMMERCE-P1 (P1-5) — single-field range / equality: no composite index.
    countOf(col('eventLicenses').where('refundHold.at', '<', Timestamp.fromMillis(now - REFUND_HOLD_MIN_RELEASE_AGE_MS))),
    countOf(col('licenseOrders').where('status', '==', 'refunding')),
    // F1 / F2 — single-field equality / inequality: no composite index.
    countOf(col('platformTransactions').where('releaseStatus', '==', 'held')),
    // M1 — OPEN reviews only: a review closed with evidence (reviewClosed) no longer alerts.
    countOf(col('registrationRefunds').where('reviewOpen', '==', true)),
    // M2 — index 15 (appended last so no earlier index moves).
    countOf(col('eventLicenses').where('refundFailure.status', '==', 'open')),
    // M1 — index 16: hold closures queued for retry (failed, or waiting for a deferred ledger reversal).
    countOf(col('refundHoldClosureReconciliation').where('status', '==', 'pending')),
    // Phase 2 — indices 17 / 18 / 19: donation refund ACCOUNTING recovery (single-field equality on a
    // nested field: automatic index). Awaiting-gateway age is checked in memory over a bounded read.
    countOf(col('donationRefunds').where('accountingRecovery.state', '==', 'retry')),
    countOf(col('donationRefunds').where('accountingRecovery.state', '==', 'needs_review')),
    col('donationRefunds').where('accountingRecovery.state', '==', 'awaiting_gateway').limit(500).get().then(snap => {
      const cutoff = Date.now() - 24 * 60 * 60_000
      return snap.docs.filter(d => {
        const t = d.get('createdAt') as { toMillis?: () => number } | undefined
        return typeof t?.toMillis === 'function' && t.toMillis() < cutoff
      }).length
    }).catch(() => -1),
    // Phase 2.2 — index 20.
    countOf(col('donations').where('hasOpenRefundAttempt', '==', true)),
    // Phase 3.3 — indices 21–24: the registration refund queues (equality only).
    countOf(col('refundLedgerReconciliation').where('status', '==', 'pending')),
    countOf(col('refundLedgerReconciliation').where('status', '==', 'needs_review')),
    countOf(col('refundHoldClosureReconciliation').where('status', '==', 'refused')),
    countOf(col('refundHoldClosureReconciliation').where('status', '==', 'needs_review')),
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
    // RD-NOTIFY-01 — terminal outbox outcomes (single-field equality: no composite index).
    countOf(col('notificationOutbox').where('status', '==', 'failed')),
    countOf(col('notificationOutbox').where('status', '==', 'unconfirmed')),
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
      const t = { event: 0, pass: 0, campaign: 0, session: 0, wallet: 0, donation: 0, registration: 0, release: 0, walletUnverifiable: 0, donationUnverifiable: 0, registrationUnverifiable: 0, releaseUnverifiable: 0 }
      for (const d of snap.docs) {
        const r = d.data() as { entityType?: string; kind?: string; createdAt?: unknown }
        if (tsToMillis(r.createdAt) < cutoff) break   // desc order → rest are older
        const key = r.entityType
        if (r.kind === 'unverifiable') {   // Phase 3.6A — a check that could not complete is never a mismatch count
          if (key === 'wallet') t.walletUnverifiable++
          else if (key === 'donation') t.donationUnverifiable++
          else if (key === 'registration') t.registrationUnverifiable++
          else if (key === 'release') t.releaseUnverifiable++
          continue
        }
        if (key === 'event' || key === 'pass' || key === 'campaign' || key === 'session' || key === 'wallet' || key === 'donation' || key === 'registration' || key === 'release') t[key]++
      }
      return t
    })
    .catch(() => ({ event: -1, pass: -1, campaign: -1, session: -1, wallet: -1, donation: -1, registration: -1, release: -1, walletUnverifiable: -1, donationUnverifiable: -1, registrationUnverifiable: -1, releaseUnverifiable: -1 }))
  // Phase 3.9 — the window above holds at most 1,000 reports, so a flood (a first run over legacy data writes
  // thousands) pushes older findings — including urgent ones — out of it. The global run now records its EXACT
  // counts (reconciliationRuns); when the latest run is inside the window, its counts are used instead.
  const runP = col('reconciliationRuns').orderBy('finishedAt', 'desc').limit(1).get()
    .then(s => (s.empty ? null : s.docs[0].data() as { finishedAt?: unknown; mismatchesByType?: Record<string, number>; unverifiableByType?: Record<string, number> }))
    .catch(() => null)

  const [fin, wh, bc, tally, crons, run] = await Promise.all([financialP, webhookP, broadcastP, integrityP, cronP, runP])
  const integrity = run && tsToMillis(run.finishedAt) >= now - DATA_INTEGRITY_WINDOW_MS
    ? (() => {
      const m = run.mismatchesByType ?? {}, u = run.unverifiableByType ?? {}
      const c = (o: Record<string, number>, k: string) => (typeof o[k] === 'number' ? o[k] : 0)
      return {
        // events and passes share one reconciler; its mismatches carry their own entity types
        event: c(m, 'event'), pass: c(m, 'pass'), campaign: c(m, 'campaign'), session: c(m, 'session'), wallet: c(m, 'wallet'),
        donation: c(m, 'donation'), registration: c(m, 'registration'), release: c(m, 'release'),
        walletUnverifiable: c(u, 'wallet'), donationUnverifiable: c(u, 'donation'), registrationUnverifiable: c(u, 'registration'), releaseUnverifiable: c(u, 'release'),
      }
    })()
    : tally

  return {
    financial: {
      pendingSettlements: fin[0], failedRefunds: fin[1], pendingWalletTopups: fin[2],
      walletTopupsNeedsReview: fin[6], walletTopupsExhausted: fin[7], walletTopupDuplicatePayments: fin[8],
      pendingRegistrationReconciliation: fin[3], pendingDonationReconciliation: fin[4], outstandingClawbacks: fin[5],
      badgeSuspiciousUnreviewed: fin[9], badgeRoundsStale: fin[10],
      licenceRefundHoldsStale: fin[11], licenceOrdersRefunding: fin[12], licenceRefundFailuresOpen: fin[15], refundHoldClosuresPending: fin[16],
      donationRefundAccountingRetrying: fin[17], donationRefundAccountingNeedsReview: fin[18], donationRefundsAwaitingGatewayStale: fin[19], donationRefundAttemptsUnresolved: fin[20],
      refundLedgerReversalsPending: fin[21], refundLedgerReversalsNeedsReview: fin[22], refundHoldClosuresRefused: fin[23], refundHoldClosuresNeedsReview: fin[24],
      settlementsHeldForRefundReview: fin[13], registrationRefundsNeedingReview: fin[14],
    },
    webhook: { pendingDeliveries: wh[0], failedDeliveries: wh[1], exhaustedRetries: wh[1], oldestPendingAt: wh[2] },
    broadcast: { scheduled: bc[0], sending: bc[1], failed: bc[2], stuckSending: bc[3], notificationEmailsFailed: bc[4], notificationEmailsUnconfirmed: bc[5] },
    dataIntegrity: {
      eventMismatches: integrity.event, passMismatches: integrity.pass,
      campaignMismatches: integrity.campaign, sessionMismatches: integrity.session,
      walletMismatches: integrity.wallet,
      donationMismatches: integrity.donation, walletUnverifiable: integrity.walletUnverifiable, donationUnverifiable: integrity.donationUnverifiable,
      registrationMismatches: integrity.registration, registrationUnverifiable: integrity.registrationUnverifiable,
      stuckReleases: integrity.release, releaseUnverifiable: integrity.releaseUnverifiable,
    },
    crons,
    generatedAt: new Date(now).toISOString(),
  }
}

// ─── Alert rules (Phase G.4 requirement 4) ─────────────────────────────────────

/** RD-WALLET-W2.g — held top-up records (the three disjoint statuses); a failed count (-1) adds 0. */
export function heldWalletTopupCount(f: Pick<FinancialHealth, 'walletTopupsNeedsReview' | 'walletTopupsExhausted' | 'walletTopupDuplicatePayments'>): number {
  return Math.max(0, f.walletTopupsNeedsReview) + Math.max(0, f.walletTopupsExhausted) + Math.max(0, f.walletTopupDuplicatePayments)
}

export type AlertSeverity = 'critical' | 'warning'
export interface OperationalAlert { id: string; severity: AlertSeverity; message: string }

export function evaluateAlerts(h: OperationsHealth): OperationalAlert[] {
  const alerts: OperationalAlert[] = []
  const push = (id: string, severity: AlertSeverity, message: string) => alerts.push({ id, severity, message })

  if (h.financial.failedRefunds > 0) push('failed_refunds', 'critical', `${h.financial.failedRefunds} failed refund(s) need manual action.`)
  // RD-SA-COMMERCE-P1 (P1-5) — an unfinished licence refund stops every sale of its event. Critical, with the
  // count in the message (a new hold changes it). Never auto-released: Admin › Licenses › "Refund hold".
  if (h.financial.licenceRefundHoldsStale > 0) push('licence_refund_holds_stale', 'critical', `${h.financial.licenceRefundHoldsStale} licence refund hold(s) older than 15 minutes are blocking sales (Admin › Licenses › Refund hold).`)
  // M2 — money the organizer was told was refunded may not have left: critical until a Super Admin decides.
  if (h.financial.donationRefundAccountingNeedsReview > 0) push('donation_refund_accounting_needs_review', 'critical', `${h.financial.donationRefundAccountingNeedsReview} donation refund(s) were PROCESSED by the gateway but their accounting failed permanently or exhausted its retries — the donation stays held; manual intervention required (donationRefunds.accountingRecovery.state 'needs_review').`)
  if (h.financial.donationRefundAccountingRetrying > 0) push('donation_refund_accounting_retrying', 'warning', `${h.financial.donationRefundAccountingRetrying} donation refund(s) processed by the gateway are awaiting an accounting retry by the donation-reconciliation cron — the affected donations stay held.`)
  if (h.financial.donationRefundAttemptsUnresolved > 0) push('donation_refund_attempts_unresolved', 'warning', `${h.financial.donationRefundAttemptsUnresolved} donation(s) have a refund request whose gateway outcome is UNKNOWN — held; matched automatically when Razorpay shows the refund, otherwise resolved by a Super Admin (Refund holds) after 15 minutes.`)
  if (h.financial.donationRefundsAwaitingGatewayStale > 0) push('donation_refunds_awaiting_gateway', 'warning', `${h.financial.donationRefundsAwaitingGatewayStale} donation refund(s) accepted by the gateway more than 24 h ago were never reported processed — reconcile against Razorpay (nothing is accounted speculatively).`)
  if (h.financial.refundLedgerReversalsNeedsReview > 0) push('refund_ledger_reversals_needs_review', 'critical', `${h.financial.refundLedgerReversalsNeedsReview} registration refund ledger reversal(s) exhausted their retries or failed permanently — the refund left but the ledger/wallet were not debited; manual intervention required (refundLedgerReconciliation 'needs_review').`)
  if (h.financial.refundLedgerReversalsPending > 0) push('refund_ledger_reversals_pending', 'warning', `${h.financial.refundLedgerReversalsPending} registration refund ledger reversal(s) are queued for retry by the registration-reconciliation cron (refundLedgerReconciliation).`)
  if (h.financial.refundHoldClosuresNeedsReview > 0) push('refund_hold_closures_needs_review', 'critical', `${h.financial.refundHoldClosuresNeedsReview} settlement refund-hold closure(s) exhausted their retries or failed permanently — the holds stay; manual intervention required (refundHoldClosureReconciliation 'needs_review').`)
  if (h.financial.refundHoldClosuresRefused > 0) push('refund_hold_closures_refused', 'warning', `${h.financial.refundHoldClosuresRefused} settlement refund-hold closure(s) were refused by the evidence (an open contradiction) — the holds stay for the Super Admin refund-hold review.`)
  if (h.financial.refundHoldClosuresPending > 0) push('refund_hold_closures_pending', 'warning', `${h.financial.refundHoldClosuresPending} settlement refund-hold closure(s) failed and are queued for retry by the registration-reconciliation cron (refundHoldClosureReconciliation) — the holds stay in place.`)
  if (h.financial.licenceRefundFailuresOpen > 0) push('licence_refund_failures', 'critical', `${h.financial.licenceRefundFailuresOpen} licence refund(s) FAILED at the gateway after being accepted — the licence stays refunded; a Super Admin must decide (Admin › Licenses).`)
  // F1 / F2 — never resolve on their own; a Super Admin decides each one (funds stay unreleased meanwhile).
  if (h.financial.settlementsHeldForRefundReview > 0) push('settlements_held_refund_review', 'warning', `${h.financial.settlementsHeldForRefundReview} settlement transaction(s) held: a refund of the payment is open for review (platformTransactions releaseStatus 'held').`)
  if (h.financial.registrationRefundsNeedingReview > 0) push('registration_refunds_review', 'warning', `${h.financial.registrationRefundsNeedingReview} registration refund(s) need review (registrationRefunds.reviewOpen).`)
  if (h.financial.licenceOrdersRefunding > 0) push('licence_orders_refunding', 'warning', `${h.financial.licenceOrdersRefunding} licence order(s) in "refunding" — an unfinished refund (Admin › License Center).`)
  if (h.financial.outstandingClawbacks > 0) push('clawbacks', 'warning', `${h.financial.outstandingClawbacks} outstanding clawback(s).`)
  // RD-WALLET-W2.g — held top-ups never resolve on their own (guard -1 = query failed). A warning:
  // the dashboard shows it; only critical alerts page.
  const heldTopups = heldWalletTopupCount(h.financial)
  if (heldTopups > 0) push('wallet_topups_held', 'warning', `${heldTopups} wallet top-up(s) held for Super Admin review (Admin › Wallet Top-ups).`)
  // RD-PRINT-P8 (W6) — a suspicious badge payment is real money nothing applied. A WARNING (dashboard):
  // there is no "mark reviewed" action yet, so a page could never clear — its money is also covered by
  // the open-hold (failedRefunds) critical alert where a hold exists. A stale open round holds units
  // (the recovery cron settles ended jobs; a stale one belongs to a job still running).
  if (h.financial.badgeSuspiciousUnreviewed > 0) push('badge_suspicious_payments', 'warning', `${h.financial.badgeSuspiciousUnreviewed} ID-badge payment(s) recorded as suspicious and not reviewed (License Center › ID badges).`)
  if (h.financial.badgeRoundsStale > 0) push('badge_rounds_stale', 'warning', `${h.financial.badgeRoundsStale} ID-badge billing round(s) open for more than 24 hours (License Center › ID badges › Generation reconciliation).`)
  // RD-NOTIFY-01 — a notification email (Super Admin alert / organizer decision) that never reached
  // its recipient. A warning: the in-app item exists; the outbox doc's lastError names who and why.
  if ((h.broadcast.notificationEmailsFailed ?? 0) > 0) push('notification_emails_failed', 'warning', `${h.broadcast.notificationEmailsFailed} notification email(s) failed after every retry (notificationOutbox status 'failed' — see lastError).`)
  if ((h.broadcast.notificationEmailsUnconfirmed ?? 0) > 0) push('notification_emails_unconfirmed', 'warning', `${h.broadcast.notificationEmailsUnconfirmed} notification email(s) were suppressed or got no definite answer from the email provider and were not re-sent (notificationOutbox status 'unconfirmed').`)
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
  // Phase 3.6A — a wallet that could not be verified is NOT clean: surfaced, never silent (legacy data or a failed
  // read). Report-only; the reasons are in reconciliationReports (kind 'unverifiable').
  if ((h.dataIntegrity.walletUnverifiable ?? 0) > 0) push('wallet_unverifiable', 'warning', `${h.dataIntegrity.walletUnverifiable} wallet check(s) could not complete in the last 48h (unreadable or legacy records) — those balances are unverified, not clean.`)
  if ((h.dataIntegrity.donationMismatches ?? 0) > 0) push('donation_refund_mismatch', 'critical', `${h.dataIntegrity.donationMismatches} donation refund integrity mismatch(es) detected (report-only) — manual review required.`)
  if ((h.dataIntegrity.registrationMismatches ?? 0) > 0) push('registration_refund_mismatch', 'critical', `${h.dataIntegrity.registrationMismatches} registration refund integrity finding(s) in the last 48h (report-only; includes the known M4 partial-refund-on-released-funds gap) — manual review required.`)
  if ((h.dataIntegrity.registrationUnverifiable ?? 0) > 0) push('registration_refund_unverifiable', 'warning', `${h.dataIntegrity.registrationUnverifiable} registration refund check(s) could not complete in the last 48h — unverified, not clean.`)
  if ((h.dataIntegrity.stuckReleases ?? 0) > 0) push('settlement_release_stuck', 'critical', `${h.dataIntegrity.stuckReleases} settlement release(s) are STUCK: the organizer's pending balance cannot cover them, so every daily run refuses them again (report-only; nothing was retried).`)
  if ((h.dataIntegrity.releaseUnverifiable ?? 0) > 0) push('settlement_release_unverifiable', 'warning', `${h.dataIntegrity.releaseUnverifiable} overdue settlement release(s) whose cause cannot be established (paused, backlog, unreadable, or no persisted failure evidence).`)
  if ((h.dataIntegrity.donationUnverifiable ?? 0) > 0) push('donation_refund_unverifiable', 'warning', `${h.dataIntegrity.donationUnverifiable} donation refund check(s) could not complete in the last 48h — unverified, not clean.`)
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
