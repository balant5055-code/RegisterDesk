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
import { toReleaseFundsResponse }    from '@/lib/settlements/releaseRunSummary'

// Response shape is preserved for existing callers (Phase 3.10D/E: + the optional budget / row-cap stop fields).
export type { ReleaseFundsResponse } from '@/lib/settlements/releaseRunSummary'

// Phase 3.10E — an explicit function limit, as the release cron has: the job's 40 s time budget
// (RELEASE_RUN_BUDGET_MS) stops STARTING rows well inside it, leaving room for the row in flight, the awaited
// audit write and the response. This bounds the normal case only; it cannot guarantee completion under every
// platform failure (each row's ledger move is still atomic on its own).
export const maxDuration = 60

export async function POST(req: NextRequest): Promise<NextResponse> {
  // RD-PHASE4-S4 · D1 + D3 — Super Admin only, with a reason.
  const guard = await requireSuperAdmin(req)
  if (guard.response) return guard.response
  const adminUid = guard.uid

  let body: { reason?: unknown } = {}
  try { body = await req.json() as { reason?: unknown } } catch { body = {} }
  const r = parseFinancialReason(body.reason)
  if (!r.ok) return reasonErrorResponse(r)

  // Phase 3.10D — the job's default time budget (RELEASE_RUN_BUDGET_MS) applies: a run that spends it stops
  // STARTING rows; the rest stay pending and eligible, and the response says so (stoppedByBudget).
  // Phase 3.10E — likewise when eligible rows remain beyond the run's count limit (stoppedByRowCap, rowCap).
  const result = await releaseEligibleFunds()
  const response = toReleaseFundsResponse(result)

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
    metadata:   { ...response },
  })

  return NextResponse.json(response)
}
