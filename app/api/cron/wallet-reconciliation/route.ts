// GET/POST /api/cron/wallet-reconciliation
//
// Drains pending walletTopupReconciliation records — captured top-ups whose
// credit failed transiently. Replays the atomic, idempotent atomicTopupCredit so
// the organizer is credited exactly once and no captured payment is ever lost.
//
// RD-WALLET-W2.c — then runs the bounded stale top-up sweep (pending orders that may have been
// captured while verify AND the webhook missed them). Mode: WALLET_TOPUP_SWEEP_MODE ('enforce';
// anything else = report-only). The retry runs FIRST and the sweep never starts gateway work after
// STALE_SWEEP.routeCutoffMs of this request, so it cannot starve the retry or overrun maxDuration.
// Then the bounded late-payment watch over recently ABANDONED orders (own cursor, own ≤ 10-call
// budget; skipped when the sweep's gateway circuit opened). Same mode; it never credits.
// The response keeps the retry's fields at the top level and adds `staleSweep` and `abandonedWatch`.
//
// Auth: Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`. Fail-closed.

import { NextRequest, NextResponse } from 'next/server'
import { retryPendingWalletTopups, sweepStaleWalletTopups, watchAbandonedWalletTopups, STALE_SWEEP } from '@/lib/wallet/topupReconciliation'
import { isAuthorizedCron, cronUnauthorized } from '@/lib/cron/auth'
import { captureFinancialError, flushMonitoring } from '@/lib/monitoring/sentry'
import { recordCronExecution } from '@/lib/monitoring/cronMetrics'

export const dynamic     = 'force-dynamic'
export const maxDuration = 60

async function handle(req: NextRequest): Promise<NextResponse> {
  if (!isAuthorizedCron(req)) return cronUnauthorized()
  const routeStartedAt = Date.now()
  let ok = false, detail = ''
  let retry: Awaited<ReturnType<typeof retryPendingWalletTopups>> | null = null
  let staleSweep: Awaited<ReturnType<typeof sweepStaleWalletTopups>> | null = null
  try {
    retry = await retryPendingWalletTopups(100)
    staleSweep = await sweepStaleWalletTopups({ deadlineAtMs: routeStartedAt + STALE_SWEEP.routeCutoffMs })
    const abandonedWatch = await watchAbandonedWalletTopups({
      deadlineAtMs: routeStartedAt + STALE_SWEEP.routeCutoffMs,
      ...(staleSweep.circuitOpen ? { skip: 'gateway_circuit_open' } : {}),
    })
    ok = true; detail = JSON.stringify({ ...retry, staleSweep, abandonedWatch })
    return NextResponse.json({ ...retry, staleSweep, abandonedWatch })
  } catch (err) {
    // Never report partial work as complete: which stage failed, and the results of those that ran.
    const stage = !retry ? 'retry' : !staleSweep ? 'stale_sweep' : 'abandoned_watch'
    detail = `${stage}: ${err instanceof Error ? err.message : 'error'}`
    captureFinancialError(err, { scope: 'cron.wallet_reconciliation', stage })
    return NextResponse.json({ error: 'cron_failed', stage, ...(retry ? { retry } : {}), ...(staleSweep ? { staleSweep } : {}) }, { status: 500 })
  } finally {
    await recordCronExecution('wallet-reconciliation', { ok, detail }).catch(() => {})
    await flushMonitoring()
  }
}

export async function GET(req: NextRequest):  Promise<NextResponse> { return handle(req) }
export async function POST(req: NextRequest): Promise<NextResponse> { return handle(req) }
