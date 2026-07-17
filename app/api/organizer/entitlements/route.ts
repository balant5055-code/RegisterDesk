// GET /api/organizer/entitlements
//
// Returns the calling workspace's effective Event License entitlements — the
// effective tier, included limits and enabled features. The single read used by
// client-side feature gating (e.g. the Reports page's advancedReports check).
// Resolved for the WORKSPACE OWNER (a team member sees the owner's entitlements),
// derived from the organizer's highest active event license via the Event License
// model — there is no subscription plan involved.

import { NextRequest, NextResponse } from 'next/server'
import { verifyCaller }              from '@/lib/team/access'
import { resolveWorkspaceUid }       from '@/lib/team/workspace'
import { getWorkspaceEntitlements }  from '@/lib/licensing/workspaceEntitlements'

export async function GET(req: NextRequest): Promise<NextResponse> {
  const caller = await verifyCaller(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ctx = await resolveWorkspaceUid(caller.uid)
  const ent = await getWorkspaceEntitlements(ctx.workspaceUid)

  return NextResponse.json(
    {
      tier:             ent.effectiveTier,
      effectiveTier:    ent.effectiveTier,
      source:           ent.source,
      name:             ent.definition.name,
      features:         ent.features,
      limits:           ent.limits,
      activeEventCount: ent.activeEventCount,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
