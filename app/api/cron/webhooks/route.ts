// GET/POST /api/cron/webhooks
//
// Runs every minute. Processes due pending webhook deliveries (nextRetryAt <= now)
// through processWebhookDelivery, which signs + POSTs (10s timeout) and applies
// the exponential retry policy. Delivery claiming is transactional, so overlapping
// runs never double-send a delivery within its send window.
//
// Auth: Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`. Fail-closed.

import { NextRequest, NextResponse } from 'next/server'
import { isAuthorizedCron, cronUnauthorized } from '@/lib/cron/auth'
import { dueDeliveries, processWebhookDelivery } from '@/lib/integrations/webhooks'
import { captureWebhookError, flushMonitoring } from '@/lib/monitoring/sentry'
import { recordCronExecution } from '@/lib/monitoring/cronMetrics'

export const dynamic     = 'force-dynamic'
export const maxDuration = 60

const MAX_PER_RUN = 50

async function handle(req: NextRequest): Promise<NextResponse> {
  if (!isAuthorizedCron(req)) return cronUnauthorized()

  let ok = false, detail = ''
  try {
    const ids = await dueDeliveries(MAX_PER_RUN)
    let delivered = 0, failed = 0, retried = 0
    for (const id of ids) {
      const r = await processWebhookDelivery(id)
      if (r.delivered) delivered++
      else if (r.attempts >= 5) failed++
      else retried++
    }
    ok = true; detail = JSON.stringify({ scanned: ids.length, delivered, failed, retried })
    return NextResponse.json({ scanned: ids.length, delivered, failed, retried })
  } catch (err) {
    detail = err instanceof Error ? err.message : 'error'
    captureWebhookError(err, { scope: 'cron.webhooks' })
    return NextResponse.json({ error: 'cron_failed' }, { status: 500 })
  } finally {
    await recordCronExecution('webhooks', { ok, detail }).catch(() => {})
    await flushMonitoring()   // ensure events captured during the run are sent
  }
}

export async function GET(req: NextRequest):  Promise<NextResponse> { return handle(req) }
export async function POST(req: NextRequest): Promise<NextResponse> { return handle(req) }
