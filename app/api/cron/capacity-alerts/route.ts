// GET/POST /api/cron/capacity-alerts — RD-CAPACITY-01
//
// Tells organizers as their events fill: 50%, 70%, 85%, 95% and 100% of the registration
// capacity they paid for. At 100% the message says registrations are being refused and that
// buying more capacity is what resumes them.
//
// Overlapping runs are safe: each threshold is claimed in a Firestore transaction that
// re-decides from the stored state, so only one run can claim a given threshold and the
// message is sent after that commit, never inside it.
//
// Auth: the shared cron authorizer. Fail-closed, identical to every other cron route here.

import { NextRequest, NextResponse } from 'next/server'
import { isAuthorizedCron, cronUnauthorized } from '@/lib/cron/auth'
import { sweepCapacityAlerts } from '@/lib/licensing/capacityAlertSweep'
import { captureError, flushMonitoring } from '@/lib/monitoring/sentry'
import { recordCronExecution } from '@/lib/monitoring/cronMetrics'

export const dynamic     = 'force-dynamic'
export const maxDuration = 60

async function handle(req: NextRequest): Promise<NextResponse> {
  if (!isAuthorizedCron(req)) return cronUnauthorized()

  let ok = false, detail = ''
  try {
    // Budgeted below maxDuration so a large event count reduces coverage per run rather than
    // timing the function out — a notification that arrives one interval later is fine; a
    // cron that never completes is not.
    const result = await sweepCapacityAlerts(200, 45_000)
    ok = true; detail = JSON.stringify(result)
    return NextResponse.json(result)
  } catch (err) {
    detail = err instanceof Error ? err.message : 'error'
    captureError(err, { scope: 'cron.capacity_alerts' })
    return NextResponse.json({ error: 'cron_failed' }, { status: 500 })
  } finally {
    await recordCronExecution('capacity-alerts', { ok, detail }).catch(() => {})
    await flushMonitoring()
  }
}

export async function GET(req: NextRequest):  Promise<NextResponse> { return handle(req) }
export async function POST(req: NextRequest): Promise<NextResponse> { return handle(req) }
