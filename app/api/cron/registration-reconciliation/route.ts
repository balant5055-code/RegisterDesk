// GET/POST /api/cron/registration-reconciliation
//
// Drains pending registrationFinancialReconciliation records — registrations
// whose POST-COMMIT wallet credit + ledger write failed transiently. Replays the
// atomic, idempotent recordPlatformTransactionAndCredit, so the organizer is
// credited exactly once and no refund/registration state is ever touched.
//
// Auth: Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`. Fail-closed
// when CRON_SECRET is unset.

import { NextRequest, NextResponse } from 'next/server'
import { retryPendingRegistrationFinancials, retryPendingRefundLedgerReversals } from '@/lib/payments/registrationReconciliation'
import { isAuthorizedCron, cronUnauthorized } from '@/lib/cron/auth'
import { captureFinancialError, flushMonitoring } from '@/lib/monitoring/sentry'
import { recordCronExecution } from '@/lib/monitoring/cronMetrics'

export const dynamic     = 'force-dynamic'
export const maxDuration = 60

async function handle(req: NextRequest): Promise<NextResponse> {
  if (!isAuthorizedCron(req)) return cronUnauthorized()
  let ok = false, detail = ''
  try {
    const credits  = await retryPendingRegistrationFinancials(100)
    const reversals = await retryPendingRefundLedgerReversals(100)
    const result = { credits, reversals }
    ok = true; detail = JSON.stringify(result)
    return NextResponse.json(result)
  } catch (err) {
    detail = err instanceof Error ? err.message : 'error'
    captureFinancialError(err, { scope: 'cron.registration_reconciliation' })
    return NextResponse.json({ error: 'cron_failed' }, { status: 500 })
  } finally {
    await recordCronExecution('registration-reconciliation', { ok, detail }).catch(() => {})
    await flushMonitoring()
  }
}

export async function GET(req: NextRequest):  Promise<NextResponse> { return handle(req) }
export async function POST(req: NextRequest): Promise<NextResponse> { return handle(req) }
