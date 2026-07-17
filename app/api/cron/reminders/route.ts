// GET/POST /api/cron/reminders
//
// Runs every 15 minutes. (1) Materializes due reminder jobs from published events +
// active organizers' wallets (idempotent, deterministic ids), then (2) dispatches
// jobs whose time has arrived through the existing notification engine. The claim is
// status-guarded, so overlapping runs can never double-send.
//
// Auth: Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`. Fail-closed.

import { NextRequest, NextResponse } from 'next/server'
import { isAuthorizedCron, cronUnauthorized } from '@/lib/cron/auth'
import { materializeReminders } from '@/lib/reminders/scheduler'
import { dispatchDueReminders } from '@/lib/reminders/dispatch'
import { captureError, flushMonitoring } from '@/lib/monitoring/sentry'
import { recordCronExecution } from '@/lib/monitoring/cronMetrics'

export const dynamic     = 'force-dynamic'
export const maxDuration = 60

async function handle(req: NextRequest): Promise<NextResponse> {
  if (!isAuthorizedCron(req)) return cronUnauthorized()

  let ok = false, detail = ''
  const startedAt = Date.now()
  try {
    const materialized = await materializeReminders()
    // Give dispatch whatever remains of a ~55s working window (maxDuration 60) after
    // materialize, floored at 5s, so a slow materialize can't push us past the limit.
    const budgetMs = Math.max(5_000, 55_000 - (Date.now() - startedAt))
    const dispatched   = await dispatchDueReminders(50, budgetMs)
    ok = true; detail = JSON.stringify({ ...materialized, ...dispatched })
    return NextResponse.json({ ...materialized, ...dispatched })
  } catch (err) {
    detail = err instanceof Error ? err.message : 'error'
    captureError(err, { scope: 'cron.reminders' })
    return NextResponse.json({ error: 'cron_failed' }, { status: 500 })
  } finally {
    await recordCronExecution('reminders', { ok, detail }).catch(() => {})
    await flushMonitoring()
  }
}

export async function GET(req: NextRequest):  Promise<NextResponse> { return handle(req) }
export async function POST(req: NextRequest): Promise<NextResponse> { return handle(req) }
