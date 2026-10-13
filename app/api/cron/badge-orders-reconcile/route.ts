// GET/POST /api/cron/badge-orders-reconcile
//
// RD-PRINT-BILL-P4 — every 10 minutes (Group B, financial recovery): resolves ID-badge purchase
// checkouts past their 30-minute window + 30-minute grace (lib/licensing/printBadgePurchase/sweep.ts):
// a captured payment the client and webhook never settled is settled now (activated once, or durably
// held); an order Razorpay confirms unpaid is expired and its pending slot freed; an authorised or
// unknown status is left for the next run. Recently expired orders are re-checked for late captures,
// which are HELD (never activated). Never refunds; never touches a paid order.
//
// Reuses the existing cron infrastructure (isAuthorizedCron fail-closed auth + withCronMetrics).
// Scheduled in .github/workflows/cron-recovery.yml. Auth: `Authorization: Bearer <CRON_SECRET>`.

import { NextRequest, NextResponse } from 'next/server'
import { isAuthorizedCron, cronUnauthorized } from '@/lib/cron/auth'
import { withCronMetrics } from '@/lib/cron/withMetrics'
import { captureFinancialError, flushMonitoring } from '@/lib/monitoring/sentry'
import { sweepBadgeOrders } from '@/lib/licensing/printBadgePurchase/sweep'

export const dynamic     = 'force-dynamic'
export const maxDuration = 60

const MAX_PER_TICK = 200

async function handle(req: NextRequest): Promise<NextResponse> {
  if (!isAuthorizedCron(req)) return cronUnauthorized()
  try {
    const result = await sweepBadgeOrders({ limit: MAX_PER_TICK })
    await flushMonitoring()
    return NextResponse.json(result)
  } catch (err) {
    captureFinancialError(err, { scope: 'cron.badge_orders_reconcile' })
    await flushMonitoring()
    return NextResponse.json({ error: 'reconciliation failed' }, { status: 500 })
  }
}

export const GET  = withCronMetrics('badge-orders-reconcile', handle)
export const POST = withCronMetrics('badge-orders-reconcile', handle)
