// GET/POST /api/cron/global-reconciliation
//
// Daily platform-wide counter reconciliation. Verifies + repairs derived counters
// for events, passes, campaigns and sessions; verifies (REPORT ONLY) wallet
// balances against platformTransactions + settlements. Writes one
// reconciliationReports doc per mismatch.
//
// Auth: fail-closed via isAuthorizedCron (CRON_SECRET required).

import { NextRequest, NextResponse } from 'next/server'
import { isAuthorizedCron, cronUnauthorized } from '@/lib/cron/auth'
import { runGlobalReconciliation } from '@/lib/reconciliation'
import { captureError, flushMonitoring } from '@/lib/monitoring/sentry'
import { recordCronExecution } from '@/lib/monitoring/cronMetrics'

export const dynamic     = 'force-dynamic'
export const maxDuration = 300

async function handle(req: NextRequest): Promise<NextResponse> {
  if (!isAuthorizedCron(req)) return cronUnauthorized()

  let ok = false, detail = ''
  try {
    const result = await runGlobalReconciliation()
    ok = true; detail = JSON.stringify(result)
    console.log('[cron/global-reconciliation]', detail)
    return NextResponse.json(result)
  } catch (err) {
    detail = err instanceof Error ? err.message : 'error'
    captureError(err, { scope: 'global_reconciliation', detail: 'cron run failed' })
    return NextResponse.json({ error: 'cron_failed' }, { status: 500 })
  } finally {
    await recordCronExecution('global-reconciliation', { ok, detail }).catch(() => {})
    await flushMonitoring()
  }
}

export async function GET(req: NextRequest):  Promise<NextResponse> { return handle(req) }
export async function POST(req: NextRequest): Promise<NextResponse> { return handle(req) }
