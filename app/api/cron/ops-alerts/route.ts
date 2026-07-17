// GET/POST /api/cron/ops-alerts
//
// GA-5 S2 — pushes CRITICAL operational alerts to the ops inbox (email), closing the
// dashboard-only alerting gap. Delegates to deliverCriticalAlerts, which reuses the
// existing health rules + notification engine and de-dupes delivery. Fail-closed auth.

import { NextRequest, NextResponse } from 'next/server'
import { isAuthorizedCron, cronUnauthorized } from '@/lib/cron/auth'
import { withCronMetrics } from '@/lib/cron/withMetrics'
import { deliverCriticalAlerts } from '@/lib/operations/alertDelivery'
import { flushMonitoring } from '@/lib/monitoring/sentry'

export const dynamic     = 'force-dynamic'
export const maxDuration = 60

async function handle(req: NextRequest): Promise<NextResponse> {
  if (!isAuthorizedCron(req)) return cronUnauthorized()
  const start = Date.now()
  try {
    const result = await deliverCriticalAlerts(start)
    return NextResponse.json(result)
  } catch (err) {
    console.error('[cron/ops-alerts] error:', err)
    return NextResponse.json({ error: 'ops_alerts_failed' }, { status: 500 })
  } finally {
    await flushMonitoring()
  }
}

export const GET  = withCronMetrics('ops-alerts', handle)
export const POST = withCronMetrics('ops-alerts', handle)
