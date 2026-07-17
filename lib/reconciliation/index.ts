// Global reconciliation orchestrator (Phase G.5). Server-only.
//
// Runs all reconcilers, persists one reconciliationReports doc per mismatch, and
// returns a summary. Auto-repair applies to events/passes/campaigns/sessions only;
// wallets are verified and REPORTED ONLY (financial safety).

import { FieldValue } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import { reconcileEventsAndPasses } from '@/lib/reconciliation/events'
import { reconcileCampaigns } from '@/lib/reconciliation/campaigns'
import { reconcileSessions } from '@/lib/reconciliation/sessions'
import { reconcileWallets } from '@/lib/reconciliation/wallets'
import { REPORTS_COLLECTION, type CounterMismatch, type ReconcileOptions } from '@/lib/reconciliation/types'

export {
  reconcileEvents, reconcilePasses, reconcileEventsAndPasses,
} from '@/lib/reconciliation/events'
export { reconcileCampaigns } from '@/lib/reconciliation/campaigns'
export { reconcileSessions } from '@/lib/reconciliation/sessions'
export { reconcileWallets } from '@/lib/reconciliation/wallets'

export interface GlobalReconResult {
  scanned:        { events: number; campaigns: number; sessions: number; wallets: number }
  totalMismatches: number
  totalRepaired:   number
  byType:          Record<string, number>   // mismatch counts by entityType
}

async function writeReports(mismatches: CounterMismatch[]): Promise<void> {
  for (let i = 0; i < mismatches.length; i += 400) {
    const batch = adminDb.batch()
    for (const m of mismatches.slice(i, i + 400)) {
      batch.set(adminDb.collection(REPORTS_COLLECTION).doc(), {
        entityType: m.entityType,
        entityId:   m.entityId,
        field:      m.field,
        expected:   m.expected,
        actual:     m.actual,
        repaired:   m.repaired,
        createdAt:  FieldValue.serverTimestamp(),
      })
    }
    await batch.commit()
  }
}

export async function runGlobalReconciliation(opts?: ReconcileOptions): Promise<GlobalReconResult> {
  const [ep, campaigns, sessions, wallets] = await Promise.all([
    reconcileEventsAndPasses(opts),
    reconcileCampaigns(opts),
    reconcileSessions(opts),
    reconcileWallets(opts),     // report-only
  ])

  const allMismatches = [...ep.mismatches, ...campaigns.mismatches, ...sessions.mismatches, ...wallets.mismatches]
  if (allMismatches.length > 0) await writeReports(allMismatches)

  const byType: Record<string, number> = {}
  for (const m of allMismatches) byType[m.entityType] = (byType[m.entityType] ?? 0) + 1

  return {
    scanned: { events: ep.scanned, campaigns: campaigns.scanned, sessions: sessions.scanned, wallets: wallets.scanned },
    totalMismatches: allMismatches.length,
    totalRepaired: ep.repaired + campaigns.repaired + sessions.repaired,   // wallets never repaired
    byType,
  }
}
