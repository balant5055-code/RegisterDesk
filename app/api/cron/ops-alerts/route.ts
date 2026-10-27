// GET/POST /api/cron/ops-alerts
//
// GA-5 S2 — pushes CRITICAL operational alerts to the ops inbox (email), closing the
// dashboard-only alerting gap. Delegates to deliverCriticalAlerts, which reuses the
// existing health rules + notification engine and de-dupes delivery. Fail-closed auth.

import { NextRequest, NextResponse } from 'next/server'
import { isAuthorizedCron, cronUnauthorized } from '@/lib/cron/auth'
import { withCronMetrics } from '@/lib/cron/withMetrics'
import { deliverCriticalAlerts } from '@/lib/operations/alertDelivery'
import { drainOutbox } from '@/lib/notifications/outbox'
import { flushMonitoring } from '@/lib/monitoring/sentry'

export const dynamic     = 'force-dynamic'
export const maxDuration = 60

async function handle(req: NextRequest): Promise<NextResponse> {
  if (!isAuthorizedCron(req)) return cronUnauthorized()
  const start = Date.now()
  try {
    const result = await deliverCriticalAlerts(start)
    // RD-NOTIFY-01 — the notification outbox (Super Admin alerts + organizer decision emails):
    // re-attempts anything not delivered right after its request. Isolated: an outbox problem
    // never fails the ops alert, and is reported in this response for the cron logs.
    const outbox = await drainOutbox(50, start).catch((e: unknown) => ({ error: e instanceof Error ? e.message : 'drain failed' }))
    return NextResponse.json({ ...result, outbox })
  } catch (err) {
    console.error('[cron/ops-alerts] error:', err)
    return NextResponse.json({ error: 'ops_alerts_failed' }, { status: 500 })
  } finally {
    await flushMonitoring()
  }
}

export const GET  = withCronMetrics('ops-alerts', handle)
export const POST = withCronMetrics('ops-alerts', handle)
