// Global reconciliation orchestrator (Phase G.5). Server-only.
//
// Runs all reconcilers, persists one reconciliationReports doc per mismatch, and
// returns a summary. Auto-repair applies to events/passes/campaigns/sessions only;
// wallets are verified and REPORTED ONLY (financial safety).

import { FieldValue } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import { captureError } from '@/lib/monitoring/sentry'
import { reconcileEventsAndPasses } from '@/lib/reconciliation/events'
import { reconcileCampaigns } from '@/lib/reconciliation/campaigns'
import { reconcileSessions } from '@/lib/reconciliation/sessions'
import { reconcileWallets } from '@/lib/reconciliation/wallets'
import { reconcileDonationRefunds } from '@/lib/reconciliation/donationRefunds'
import { reconcileDonationLedgerRows, reconcileDonationRefundRecords } from '@/lib/reconciliation/donationLedgerRows'
import { reconcileRegistrationRefunds } from '@/lib/reconciliation/registrationRefunds'
import { reconcileStuckReleases } from '@/lib/reconciliation/stuckReleases'
import { REPORTS_COLLECTION, unverifiable, type CounterMismatch, type ReconcileEntityType, type ReconcileOptions, type ReconcileResult, type ReconcileUnverifiable } from '@/lib/reconciliation/types'

/** Phase 3.9 — one document per global run with its EXACT counts (the report collection is append-only and can
 *  flood; operations health reads the latest run summary instead of a bounded window of reports). */
export const RUNS_COLLECTION = 'reconciliationRuns'

export {
  reconcileEvents, reconcilePasses, reconcileEventsAndPasses,
} from '@/lib/reconciliation/events'
export { reconcileCampaigns } from '@/lib/reconciliation/campaigns'
export { reconcileSessions } from '@/lib/reconciliation/sessions'
export { reconcileWallets } from '@/lib/reconciliation/wallets'
export { reconcileDonationRefunds } from '@/lib/reconciliation/donationRefunds'
export { reconcileDonationLedgerRows, reconcileDonationRefundRecords } from '@/lib/reconciliation/donationLedgerRows'
export { reconcileRegistrationRefunds } from '@/lib/reconciliation/registrationRefunds'
export { reconcileStuckReleases, reportStuckReleases } from '@/lib/reconciliation/stuckReleases'

export interface GlobalReconResult {
  scanned:        {
    events: number; campaigns: number; sessions: number; wallets: number; donations: number
    donationLedgerRows: number; donationRefundRecords: number; registrationRefunds: number; eligibleReleases: number
  }
  totalMismatches: number
  totalRepaired:   number
  byType:          Record<string, number>   // mismatch counts by entityType
  /** Phase 3.6A — checks that could NOT complete (never counted as clean), and their counts by entityType. */
  totalUnverifiable:  number
  unverifiableByType: Record<string, number>
  /** Phase 3.9 — scans that did NOT complete this run (a pass failed, or stopped early): their remainder is unchecked. */
  incompleteScans:    string[]
}

// Phase 3.6A — every report carries its kind. A document without `kind` (written before) is a mismatch.
type ReportRow = ({ kind: 'mismatch' } & CounterMismatch) | ({ kind: 'unverifiable' } & ReconcileUnverifiable)

async function writeReports(rows: ReportRow[]): Promise<void> {
  for (let i = 0; i < rows.length; i += 400) {
    const batch = adminDb.batch()
    for (const r of rows.slice(i, i + 400)) {
      batch.set(adminDb.collection(REPORTS_COLLECTION).doc(), r.kind === 'mismatch' ? {
        kind:       'mismatch',
        entityType: r.entityType,
        entityId:   r.entityId,
        field:      r.field,
        expected:   r.expected,
        actual:     r.actual,
        repaired:   r.repaired,
        createdAt:  FieldValue.serverTimestamp(),
      } : {
        kind:       'unverifiable',
        entityType: r.entityType,
        entityId:   r.entityId,
        field:      r.check,
        reason:     r.reason,
        repaired:   false,
        createdAt:  FieldValue.serverTimestamp(),
      })
    }
    await batch.commit()
  }
}

export async function runGlobalReconciliation(opts?: ReconcileOptions): Promise<GlobalReconResult> {
  // Phase 3.9 — each pass is ISOLATED: one that throws no longer discards every other pass's findings (they used
  // to be lost with the whole run); it becomes an explicit unverifiable 'pass_failed' for its entity type.
  const passes: Array<[string, ReconcileEntityType, () => Promise<ReconcileResult>]> = [
    ['events-and-passes', 'event', () => reconcileEventsAndPasses(opts)],
    ['campaigns', 'campaign', () => reconcileCampaigns(opts)],
    ['sessions', 'session', () => reconcileSessions(opts)],
    ['wallets', 'wallet', () => reconcileWallets(opts)],                                  // report-only
    ['donation-refunds', 'donation', () => reconcileDonationRefunds(opts)],               // Phase 3.6A — report-only, read-only
    ['donation-ledger-rows', 'donation', () => reconcileDonationLedgerRows(opts)],        // Phase 3.8 — row-driven, report-only
    ['donation-refund-records', 'donation', () => reconcileDonationRefundRecords(opts)],  // Phase 3.8 — record-driven, report-only
    ['registration-refunds', 'registration', () => reconcileRegistrationRefunds(opts)],   // Phase 3.8 — report-only
    ['stuck-releases', 'release', () => reconcileStuckReleases()],                        // Phase 3.8 — report-only (never retries a release)
  ]
  const settled = await Promise.allSettled(passes.map(([, , run]) => run()))
  const results: ReconcileResult[] = settled.map((s, i) => {
    if (s.status === 'fulfilled') return s.value
    const [name, entityType] = passes[i]
    captureError(s.reason, { scope: 'global_reconciliation', pass: name })
    return { entityType, scanned: 0, mismatches: [], repaired: 0,
      unverifiable: [unverifiable(entityType, `pass:${name}`, `scan:${name}`, `pass_failed:${s.reason instanceof Error ? s.reason.message.slice(0, 120) : 'unknown'}`)] }
  })
  const [ep, campaigns, sessions, wallets, donations, ledgerRows, refundRecords, registrations, releases] = results
  const allMismatches = results.flatMap(r => r.mismatches)
  const allUnverifiable = results.flatMap(r => r.unverifiable ?? [])
  const rows: ReportRow[] = [
    ...allMismatches.map(m => ({ kind: 'mismatch' as const, ...m })),
    ...allUnverifiable.map(u => ({ kind: 'unverifiable' as const, ...u })),
  ]
  if (rows.length > 0) await writeReports(rows)
  const incompleteScans = allUnverifiable.filter(u => u.check.startsWith('scan:') || (u.reason.startsWith('scan_capped'))).map(u => `${u.check}:${u.reason}`)

  const byType: Record<string, number> = {}
  for (const m of allMismatches) byType[m.entityType] = (byType[m.entityType] ?? 0) + 1
  const unverifiableByType: Record<string, number> = {}
  for (const u of allUnverifiable) unverifiableByType[u.entityType] = (unverifiableByType[u.entityType] ?? 0) + 1

  // Phase 3.9 — the run's exact counts, one document (append-only; never overwrites an earlier run).
  await adminDb.collection(RUNS_COLLECTION).add({
    finishedAt: FieldValue.serverTimestamp(), mismatchesByType: byType, unverifiableByType, incompleteScans,
    totalMismatches: allMismatches.length, totalUnverifiable: allUnverifiable.length,
  }).catch(err => captureError(err, { scope: 'global_reconciliation', detail: 'run summary not written' }))

  return {
    scanned: {
      events: ep.scanned, campaigns: campaigns.scanned, sessions: sessions.scanned, wallets: wallets.scanned, donations: donations.scanned,
      donationLedgerRows: ledgerRows.scanned, donationRefundRecords: refundRecords.scanned, registrationRefunds: registrations.scanned, eligibleReleases: releases.scanned,
    },
    totalMismatches: allMismatches.length,
    totalRepaired: ep.repaired + campaigns.repaired + sessions.repaired,   // wallets and donations never repaired
    byType,
    totalUnverifiable: allUnverifiable.length,
    unverifiableByType,
    incompleteScans,
  }
}
