// GET /api/organizer/payout-profile/history — this workspace's payout-change trail
//
// RD-FINANCE-CLOSURE-02. Read-only by construction: there is no POST, PATCH, PUT or
// DELETE here, and none anywhere else. Records are appended by the payout-profile PUT, in
// the same batch as the change itself.
//
// Authorization is the EXISTING payout-profile model, unchanged and re-used verbatim:
// `authorizeWorkspace(req, 'transactions')`, the same gate the GET on the parent route
// uses. Finance team members can read the trail; only the OWNER can create entries,
// because only the owner can edit the profile.
//
// Tenant isolation comes from the query, not from a filter applied afterwards: the
// organizer id passed to `listPayoutHistory` is `authz.workspaceUid`, which is derived
// from the caller's own membership and can never be supplied by the client.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeWorkspace } from '@/lib/team/workspace'
import { listPayoutHistory, type PayoutProfileHistoryEntry } from '@/lib/payout/history'

export interface PayoutHistoryResponse {
  entries: PayoutProfileHistoryEntry[]
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const authz = await authorizeWorkspace(req, 'transactions')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })

  const entries = await listPayoutHistory(authz.workspaceUid)
  return NextResponse.json(
    { entries } satisfies PayoutHistoryResponse,
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
