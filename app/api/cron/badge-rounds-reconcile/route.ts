// GET/POST /api/cron/badge-rounds-reconcile
//
// RD-PRINT-P8 (W6) — every 10 minutes (Group B, financial recovery): settles ID-badge billing rounds
// left open by a job that ended without settling them (a crash after its last chunk, a cancel whose
// settlement failed — organizer or Operations Center — a failed job, a deleted job). Its own schedule
// and budget, so it never depends on time left over in print-generation (whose inline sweep remains as
// a fast path). Walk, cursor and safety rules: lib/printAssets/badgeBilling/roundRecovery.ts — rounds
// of running jobs are never force-settled; settlement is the existing transactional, idempotent one.
//
// Reuses the existing cron infrastructure (isAuthorizedCron fail-closed auth + withCronMetrics).
// Scheduled in .github/workflows/cron-recovery.yml. Auth: `Authorization: Bearer <CRON_SECRET>`.

import { NextRequest, NextResponse } from 'next/server'
import { isAuthorizedCron, cronUnauthorized } from '@/lib/cron/auth'
import { withCronMetrics } from '@/lib/cron/withMetrics'
import { captureFinancialError, flushMonitoring } from '@/lib/monitoring/sentry'
import { recoverBadgeRounds } from '@/lib/printAssets/badgeBilling/roundRecovery'

export const dynamic     = 'force-dynamic'
export const maxDuration = 60

async function handle(req: NextRequest): Promise<NextResponse> {
  if (!isAuthorizedCron(req)) return cronUnauthorized()
  try {
    const result = await recoverBadgeRounds()
    if (result.errors > 0) captureFinancialError(new Error('BADGE_ROUNDS_LEFT_OPEN'), { scope: 'cron.badge_rounds_reconcile', errors: result.errors })
    await flushMonitoring()
    return NextResponse.json(result)
  } catch (err) {
    captureFinancialError(err, { scope: 'cron.badge_rounds_reconcile' })
    await flushMonitoring()
    return NextResponse.json({ error: 'round recovery failed' }, { status: 500 })
  }
}

export const GET  = withCronMetrics('badge-rounds-reconcile', handle)
export const POST = withCronMetrics('badge-rounds-reconcile', handle)
