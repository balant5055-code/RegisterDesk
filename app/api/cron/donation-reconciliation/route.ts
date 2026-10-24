// GET/POST /api/cron/donation-reconciliation
//
// Drains pending donationFinancialReconciliation records — donations whose
// POST-COMMIT wallet credit + platform-ledger write failed transiently. Replays
// the atomic, idempotent recordPlatformTransactionAndCredit so the organizer is
// credited exactly once and no donation/receipt state is ever touched. Resolved
// records are marked 'resolved'; ones that still fail stay 'pending' for the next
// run.
//
// Auth: Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`. Fail-closed when
// CRON_SECRET is unset.

import { NextRequest, NextResponse } from 'next/server'
import { retryPendingDonationFinancials, recoverUncreditedDonations } from '@/lib/donations/donationReconciliation'
import { retryDonationRefundAccounting, reconcileDonationRefundAttempts } from '@/lib/donations/refundService'
import { isAuthorizedCron, cronUnauthorized } from '@/lib/cron/auth'
import { captureFinancialError, flushMonitoring } from '@/lib/monitoring/sentry'
import { recordCronExecution } from '@/lib/monitoring/cronMetrics'

export const dynamic     = 'force-dynamic'
export const maxDuration = 60

async function handle(req: NextRequest): Promise<NextResponse> {
  if (!isAuthorizedCron(req)) return cronUnauthorized()
  let ok = false, detail = ''
  try {
    const credits = await retryPendingDonationFinancials(100)
    // RD-PAY-GA-01B — self-heal successful donations missing their ptx_ ledger (the hard-kill
    // window that leaves no reconciliation record). Idempotent + recency-window bounded.
    const ledgerSweep = await recoverUncreditedDonations(500)
    // Phase 2 — refunds the gateway PROCESSED whose accounting failed: bounded, backed-off retries of
    // the internal accounting only (never a gateway call); exhausted ones become needs_review.
    const refundAccounting = await retryDonationRefundAccounting(50)
    // Phase 2.2 — refund requests whose gateway outcome is unknown: matched ONLY by the attempt id Razorpay
    // echoes in the refund's notes (read-only lookup). Never resolved as "no refund" here, never retried.
    const refundAttempts = await reconcileDonationRefundAttempts(25)
    const result = { credits, ledgerSweep, refundAccounting, refundAttempts }
    ok = true; detail = JSON.stringify(result)
    return NextResponse.json(result)
  } catch (err) {
    detail = err instanceof Error ? err.message : 'error'
    captureFinancialError(err, { scope: 'cron.donation_reconciliation' })
    return NextResponse.json({ error: 'cron_failed' }, { status: 500 })
  } finally {
    await recordCronExecution('donation-reconciliation', { ok, detail }).catch(() => {})
    await flushMonitoring()
  }
}

export async function GET(req: NextRequest):  Promise<NextResponse> { return handle(req) }
export async function POST(req: NextRequest): Promise<NextResponse> { return handle(req) }
