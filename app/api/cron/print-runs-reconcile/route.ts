// GET/POST /api/cron/print-runs-reconcile
//
// RD-PRINT-P4 — daily reconciliation of ABANDONED combined print runs: a run still `planned`
// with no activity for RUN_STALE_MS (the browser closed, the connection dropped) is marked
// `expired`. That is the ONLY write: the status/error fields of stale `printRuns` documents.
// It never reads or writes registrations, jobs, templates or Storage, and deletes nothing.
// Runs it does not reach are still expired lazily the next time they are read.
//
// Reuses the existing cron infrastructure (isAuthorizedCron fail-closed auth +
// withCronMetrics). Bounded per tick. Scheduled in .github/workflows/cron-maintenance.yml.
//
// Auth: `Authorization: Bearer <CRON_SECRET>`. Fail-closed when unset.

import { NextRequest, NextResponse } from 'next/server'
import { isAuthorizedCron, cronUnauthorized } from '@/lib/cron/auth'
import { withCronMetrics } from '@/lib/cron/withMetrics'
import { captureError, flushMonitoring } from '@/lib/monitoring/sentry'
import { reconcileStalePrintRuns } from '@/lib/printAssets/runs/service'

export const dynamic     = 'force-dynamic'
export const maxDuration = 60

const MAX_PER_TICK = 500

async function handle(req: NextRequest): Promise<NextResponse> {
  if (!isAuthorizedCron(req)) return cronUnauthorized()
  try {
    const result = await reconcileStalePrintRuns({ limit: MAX_PER_TICK })
    await flushMonitoring()
    return NextResponse.json(result)
  } catch (err) {
    captureError(err, { scope: 'cron.print_runs_reconcile', area: 'print' })
    await flushMonitoring()
    return NextResponse.json({ error: 'reconciliation failed' }, { status: 500 })
  }
}

export const GET  = withCronMetrics('print-runs-reconcile', handle)
export const POST = withCronMetrics('print-runs-reconcile', handle)
