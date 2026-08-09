// GET/POST /api/cron/media-credit-sessions
//
// The upload-session reclamation scheduler. Runs the ordered pipeline from
// Architecture Spec v1.0 §16:
//
//     expired ACTIVE sessions → seal → settle → reservation cleanup
//
// Auth: `Authorization: Bearer <CRON_SECRET>`, fail-closed. This endpoint settles real
// credits, so an unauthenticated call must not reach the pipeline at all.
//
// ═══ WHY THIS IS A SEPARATE ROUTE ════════════════════════════════════════════
// `/api/cron/media-credit-reconciliation` deliberately no-ops when `creditsEnabled` is false.
// Session cleanup must do the OPPOSITE (Spec §20): if an admin turns credits off while
// sessions are open, those holds still have to be sealed, settled and released, or the
// credits are stranded forever. Folding the two into one route would force one of them to
// behave wrongly.
//
// ═══ SAFE TO REPLAY ══════════════════════════════════════════════════════════
// Every stage is independently idempotent — sealing an already-sealed session is a no-op,
// settlement is guarded by the session status and a deterministic ledger entry id, and
// releasing a resolved reservation does nothing. Overlapping invocations cannot double-settle
// or double-release.
//
// ═══ PARTIAL PROGRESS IS THE DESIGN ══════════════════════════════════════════
// The pipeline is time-budgeted and yields rather than running long. Whatever it completed is
// committed; whatever it did not is picked up on the next tick. There is no batch to abort
// and nothing to roll back.

import { NextRequest, NextResponse } from 'next/server'
import { isAuthorizedCron, cronUnauthorized } from '@/lib/cron/auth'
import { captureFinancialError, flushMonitoring } from '@/lib/monitoring/sentry'
import { recordCronExecution } from '@/lib/monitoring/cronMetrics'
import {
  runSessionCleanup, sessionMetrics,
} from '@/features/media-credits/services/sessionCleanupService'
import { opsLog } from '@/features/media-credits/utils/opsLog'

export const dynamic     = 'force-dynamic'
export const maxDuration = 60

const CRON_NAME = 'media-credit-sessions'

/** Under `maxDuration`, so the run finishes and reports rather than being killed mid-pipeline. */
const BUDGET_MS = 45_000
const LIMIT     = 200

async function handle(req: NextRequest): Promise<NextResponse> {
  if (!isAuthorizedCron(req)) return cronUnauthorized()

  let ok = false, detail = ''
  try {
    const report = await runSessionCleanup({ limit: LIMIT, budgetMs: BUDGET_MS })

    // Read AFTER the sweep so the numbers reflect what it left behind — a backlog that
    // survived the pass is the thing worth alerting on.
    const metrics = await sessionMetrics()

    ok = true
    detail = `sealed=${report.seal.sealed}/${report.seal.scanned} `
           + `settled=${report.settle.settled}/${report.settle.scanned} `
           + `released=${report.reservations.released}/${report.reservations.scanned} `
           + `pending=${metrics.pendingSettlement} backlog=${metrics.expiredActive}`
           + (report.budgetExhausted.length ? ` budget=${report.budgetExhausted.join(',')}` : '')

    return NextResponse.json({ ...report, metrics })
  } catch (err) {
    detail = err instanceof Error ? err.message : 'error'
    opsLog('cleanup.failed', { reason: detail })
    captureFinancialError(err, { scope: 'cron.media_credit_sessions' })
    return NextResponse.json({ error: 'cron_failed' }, { status: 500 })
  } finally {
    await recordCronExecution(CRON_NAME, { ok, detail }).catch(() => {})
    await flushMonitoring()
  }
}

export async function GET(req: NextRequest):  Promise<NextResponse> { return handle(req) }
export async function POST(req: NextRequest): Promise<NextResponse> { return handle(req) }
