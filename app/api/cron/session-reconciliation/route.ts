// GET/POST /api/cron/session-reconciliation
//
// Daily: rebuilds eventSessions.registeredCount + checkedInCount from the active
// registrations source-of-truth, correcting any drift left by missed live updates,
// crashes mid-transition, or backfill/live races. Track occupancy, speaker counts
// and analytics are derived from these counters, so this keeps them honest too.
//
// Auth: fail-closed via isAuthorizedCron (CRON_SECRET required).

import { NextRequest, NextResponse } from 'next/server'
import { isAuthorizedCron, cronUnauthorized } from '@/lib/cron/auth'
import { reconcileSessionCounts } from '@/lib/sessions/reconciliation'
import { captureError, flushMonitoring } from '@/lib/monitoring/sentry'
import { recordCronExecution } from '@/lib/monitoring/cronMetrics'

export const dynamic     = 'force-dynamic'
export const maxDuration = 300

async function handle(req: NextRequest): Promise<NextResponse> {
  if (!isAuthorizedCron(req)) return cronUnauthorized()

  let ok = false, detail = ''
  try {
    const result = await reconcileSessionCounts()
    ok = true; detail = JSON.stringify(result)
    console.log('[cron/session-reconciliation]', detail)
    return NextResponse.json(result)
  } catch (err) {
    detail = err instanceof Error ? err.message : 'error'
    captureError(err, { scope: 'session_reconciliation', detail: 'cron run failed' })
    return NextResponse.json({ error: 'cron_failed' }, { status: 500 })
  } finally {
    await recordCronExecution('session-reconciliation', { ok, detail }).catch(() => {})
    await flushMonitoring()
  }
}

export async function GET(req: NextRequest):  Promise<NextResponse> { return handle(req) }
export async function POST(req: NextRequest): Promise<NextResponse> { return handle(req) }
