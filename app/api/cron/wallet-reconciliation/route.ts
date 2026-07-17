// GET/POST /api/cron/wallet-reconciliation
//
// Drains pending walletTopupReconciliation records — captured top-ups whose
// credit failed transiently. Replays the atomic, idempotent atomicTopupCredit so
// the organizer is credited exactly once and no captured payment is ever lost.
//
// Auth: Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`. Fail-closed.

import { NextRequest, NextResponse } from 'next/server'
import { retryPendingWalletTopups }  from '@/lib/wallet/topupReconciliation'
import { isAuthorizedCron, cronUnauthorized } from '@/lib/cron/auth'
import { captureFinancialError, flushMonitoring } from '@/lib/monitoring/sentry'
import { recordCronExecution } from '@/lib/monitoring/cronMetrics'

export const dynamic     = 'force-dynamic'
export const maxDuration = 60

async function handle(req: NextRequest): Promise<NextResponse> {
  if (!isAuthorizedCron(req)) return cronUnauthorized()
  let ok = false, detail = ''
  try {
    const result = await retryPendingWalletTopups(100)
    ok = true; detail = JSON.stringify(result)
    return NextResponse.json(result)
  } catch (err) {
    detail = err instanceof Error ? err.message : 'error'
    captureFinancialError(err, { scope: 'cron.wallet_reconciliation' })
    return NextResponse.json({ error: 'cron_failed' }, { status: 500 })
  } finally {
    await recordCronExecution('wallet-reconciliation', { ok, detail }).catch(() => {})
    await flushMonitoring()
  }
}

export async function GET(req: NextRequest):  Promise<NextResponse> { return handle(req) }
export async function POST(req: NextRequest): Promise<NextResponse> { return handle(req) }
