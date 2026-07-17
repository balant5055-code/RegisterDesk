// POST /api/admin/finance/release-funds
//
// Manual admin trigger for T+2 settlement release. Delegates to the shared
// releaseEligibleFunds service (the SAME exactly-once money movement the hourly
// /api/cron/release-funds job uses) and records an admin audit entry. The release
// logic itself lives in lib/settlements/releaseFunds.ts.

import { NextRequest, NextResponse } from 'next/server'
import { captureFinancialError }     from '@/lib/monitoring/sentry'
import { resolveAdminUid }           from '@/lib/admin/auth'
import { logAdminAction }            from '@/lib/admin/audit'
import { releaseEligibleFunds }      from '@/lib/settlements/releaseFunds'

// Response shape is preserved for existing callers.
export interface ReleaseFundsResponse {
  releasedTransactions: number
  releasedAmountPaise:  number
  skippedTransactions:  number
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const result = await releaseEligibleFunds()

  if (result.processed > 0) {
    void logAdminAction({
      adminUid,
      action:     'finance.release_funds',
      entityType: 'finance',
      entityId:   'release-funds',
      metadata:   {
        releasedTransactions: result.processed,
        releasedAmountPaise:  result.releasedAmountPaise,
        skippedTransactions:  result.failures,
      },
    }).catch(err => captureFinancialError(err, { scope: 'settlement_release', area: 'settlement_release', detail: 'admin audit log failed' }))
  }

  return NextResponse.json({
    releasedTransactions: result.processed,
    releasedAmountPaise:  result.releasedAmountPaise,
    skippedTransactions:  result.failures,
  } satisfies ReleaseFundsResponse)
}
