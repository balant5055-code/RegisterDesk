// GET/POST /api/cron/release-funds
//
// Hourly: automatically moves organizer revenue from pendingPaise → availablePaise
// once the T+2 hold expires, eliminating manual release ops. Delegates to the
// shared, exactly-once releaseEligibleFunds service.
//
// Auth: fail-closed via isAuthorizedCron (CRON_SECRET required; see lib/cron/auth.ts).

import { NextRequest, NextResponse } from 'next/server'
import { isAuthorizedCron, cronUnauthorized } from '@/lib/cron/auth'
import { releaseEligibleFunds } from '@/lib/settlements/releaseFunds'
import { getSettlementConfig } from '@/lib/settlements/resolveSettlementConfig'
import { captureFinancialError, flushMonitoring } from '@/lib/monitoring/sentry'
import { recordCronExecution } from '@/lib/monitoring/cronMetrics'

export const dynamic     = 'force-dynamic'
export const maxDuration = 60

async function handle(req: NextRequest): Promise<NextResponse> {
  if (!isAuthorizedCron(req)) return cronUnauthorized()

  let ok = false, detail = ''
  try {
    // Settlement policy (Business Configuration): the automatic (cron) release only
    // runs when auto-release is on. Manual admin release is unaffected.
    const settlements = await getSettlementConfig()
    if (!settlements.autoRelease) {
      ok = true; detail = 'auto_release_disabled'
      return NextResponse.json({ processed: 0, releasedAmountPaise: 0, failures: 0, skipped: 'auto_release_disabled' })
    }
    const result = await releaseEligibleFunds({ limit: 500 })
    ok = true; detail = JSON.stringify(result)
    console.log('[cron/release-funds]', detail)
    return NextResponse.json(result)
  } catch (err) {
    detail = err instanceof Error ? err.message : 'error'
    captureFinancialError(err, { scope: 'settlement_release', area: 'settlement_release', detail: 'cron run failed' })
    return NextResponse.json({ error: 'cron_failed' }, { status: 500 })
  } finally {
    await recordCronExecution('release-funds', { ok, detail }).catch(() => {})
    await flushMonitoring()   // deliver any events captured during the run
  }
}

export async function GET(req: NextRequest):  Promise<NextResponse> { return handle(req) }
export async function POST(req: NextRequest): Promise<NextResponse> { return handle(req) }
