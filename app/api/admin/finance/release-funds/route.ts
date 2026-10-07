// POST /api/admin/finance/release-funds
//
// Manual admin trigger for T+2 settlement release. Delegates to the shared
// releaseEligibleFunds service (the SAME exactly-once money movement the hourly
// /api/cron/release-funds job uses) and records an admin audit entry. The release
// logic itself lives in lib/settlements/releaseFunds.ts.

import { NextRequest, NextResponse } from 'next/server'
import { logAdminActionOrRecord }    from '@/lib/admin/audit'
import { requireSuperAdmin, parseFinancialReason, reasonErrorResponse } from '@/lib/admin/financialGuard'
import { releaseEligibleFunds }      from '@/lib/settlements/releaseFunds'

// Response shape is preserved for existing callers.
export interface ReleaseFundsResponse {
  releasedTransactions: number
  releasedAmountPaise:  number
  skippedTransactions:  number
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  // RD-PHASE4-S4 · D1 + D3 — Super Admin only, with a reason.
  const guard = await requireSuperAdmin(req)
  if (guard.response) return guard.response
  const adminUid = guard.uid

  let body: { reason?: unknown } = {}
  try { body = await req.json() as { reason?: unknown } } catch { body = {} }
  const r = parseFinancialReason(body.reason)
  if (!r.ok) return reasonErrorResponse(r)

  const result = await releaseEligibleFunds()

  // The release is many per-transaction ledger moves, so its audit cannot share one
  // transaction with them. It is AWAITED (not detached) and, if the write fails, the failure is
  // durably recorded for reconciliation (adminAuditFailures) — the response still reports the
  // true outcome of the release that already happened. Recorded for every run, including a
  // run that found nothing to release: the decision itself is what is audited.
  await logAdminActionOrRecord({
    adminUid,
    actorRole:  'super_admin',
    action:     'finance.release_funds',
    entityType: 'finance',
    entityId:   'release-funds',
    reason:     r.reason,
    metadata:   {
      releasedTransactions: result.processed,
      releasedAmountPaise:  result.releasedAmountPaise,
      skippedTransactions:  result.failures,
    },
  })

  return NextResponse.json({
    releasedTransactions: result.processed,
    releasedAmountPaise:  result.releasedAmountPaise,
    skippedTransactions:  result.failures,
  } satisfies ReleaseFundsResponse)
}
