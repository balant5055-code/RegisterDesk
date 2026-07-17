// Session-count reconciliation (P1-1 → unified in Phase G.5). Server-only.
//
// The canonical logic now lives in lib/reconciliation/sessions.ts (the unified
// global-reconciliation framework). This module delegates to it so the standalone
// /api/cron/session-reconciliation keeps its existing result shape while sharing a
// single implementation with the global reconciliation cron.

import { reconcileSessions } from '@/lib/reconciliation/sessions'

export interface SessionReconResult {
  eventsScanned:     number
  sessionsScanned:   number
  sessionsCorrected: number
  driftCorrected:    number
  failures:          number
}

export async function reconcileSessionCounts(options?: { limitEvents?: number }): Promise<SessionReconResult> {
  const r = await reconcileSessions({ limit: options?.limitEvents })
  const correctedSessions = new Set(r.mismatches.filter(m => m.repaired).map(m => m.entityId))
  const driftCorrected = r.mismatches.reduce((s, m) => s + Math.abs(m.expected - m.actual), 0)
  return {
    eventsScanned:     0,                      // tracked internally by the unified reconciler
    sessionsScanned:   r.scanned,
    sessionsCorrected: correctedSessions.size,
    driftCorrected,
    failures:          0,
  }
}
