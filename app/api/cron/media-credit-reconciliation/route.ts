// GET/POST /api/cron/media-credit-reconciliation
//
// The Media Credits financial scheduler. Drains BOTH queues and reports orphans:
//   • captured purchases whose credits were never granted   (MC-04's `paid` parking)
//   • approved refunds whose payout never completed          (MC-05's `approved` parking)
//
// Auth: `Authorization: Bearer <CRON_SECRET>`, fail-closed — the same gate every other cron
// route uses. This endpoint moves real money, so an unauthenticated call must not reach the
// drains at all.
//
// SAFE TO RUN REPEATEDLY. Grants are idempotent on `purchase:{purchaseId}`; refund payouts
// ask Razorpay whether a refund tagged with our refundId already exists and adopt it rather
// than creating a second one. Overlapping invocations therefore cannot double-pay.
//
// A drain never throws into the response: individual failures are counted and left in place
// for the next tick, so one poisoned record cannot stop the queue.

import { NextRequest, NextResponse } from 'next/server'
import { isAuthorizedCron, cronUnauthorized } from '@/lib/cron/auth'
import { captureFinancialError, flushMonitoring } from '@/lib/monitoring/sentry'
import { recordCronExecution } from '@/lib/monitoring/cronMetrics'
import { runReconciliation } from '@/features/media-credits/services/reconciliation'
import { getCreditPolicy } from '@/features/media-credits/services'

export const dynamic     = 'force-dynamic'
export const maxDuration = 60

const CRON_NAME = 'media-credit-reconciliation'

async function handle(req: NextRequest): Promise<NextResponse> {
  if (!isAuthorizedCron(req)) return cronUnauthorized()

  let ok = false, detail = ''
  try {
    // With credits off there is nothing to reconcile and no reason to scan. Reported as a
    // successful no-op so the monitoring stays green rather than looking like a dead cron.
    if (!(await getCreditPolicy()).creditsEnabled) {
      ok = true; detail = 'skipped:credits_disabled'
      return NextResponse.json({ skipped: true, reason: 'credits_disabled' })
    }

    // Budget stays under `maxDuration` so the run finishes and reports rather than being
    // killed mid-drain with nothing recorded.
    const result = await runReconciliation({ limit: 100, budgetMs: 45_000 })
    ok = true
    detail = `grants=${result.grants.resolved}/${result.grants.scanned} `
           + `refunds=${result.refunds.resolved}/${result.refunds.scanned} `
           + `orphans=${result.orphans.unrecordedPaidPurchases.length + result.orphans.stuckRefunds.length}`
    return NextResponse.json(result)
  } catch (err) {
    detail = err instanceof Error ? err.message : 'error'
    captureFinancialError(err, { scope: 'cron.media_credit_reconciliation' })
    return NextResponse.json({ error: 'cron_failed' }, { status: 500 })
  } finally {
    await recordCronExecution(CRON_NAME, { ok, detail }).catch(() => {})
    await flushMonitoring()
  }
}

export async function GET(req: NextRequest):  Promise<NextResponse> { return handle(req) }
export async function POST(req: NextRequest): Promise<NextResponse> { return handle(req) }
