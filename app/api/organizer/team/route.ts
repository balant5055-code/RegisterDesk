// GET /api/organizer/team — list the LEGACY members of this workspace.
//
// ═══ THERE IS NO LONGER A POST (RD-TEAM-IMPL-01) ═════════════════════════════
// This route used to invite a member by email. RegisterDesk now issues gate
// credentials directly (POST /api/organizer/staff), so there is no invitation, no
// token, no acceptance and no mail — and therefore nothing here to create.
//
// The GET remains, and is not vestigial: rows created by the old flow are still LIVE
// authorization grants. `teamMembers` is the substrate every organizer route reads,
// so an organizer must still be able to SEE the people they invited before this
// change, and retire them through PATCH/DELETE on /api/organizer/team/[memberId].
// It returns no `invites` list any more, because nothing can be in the invited state
// going forward; historical `status: 'invited'` rows are filtered out by listTeam.
//
// The workspace is always the caller's own (organizerUid = caller uid), never a
// value from the request. All permission logic comes from lib/team/access.

import { NextRequest, NextResponse } from 'next/server'
import { verifyCaller, requireAdmin } from '@/lib/team/access'
import { listTeam }                   from '@/lib/team/service'

export async function GET(req: NextRequest): Promise<NextResponse> {
  const caller = await verifyCaller(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Owner or admin of their own workspace may view the team.
  const access = await requireAdmin(caller.uid, caller.uid)
  if (!access.ok) return NextResponse.json({ error: access.reason }, { status: access.status })

  const data = await listTeam(caller.uid)
  return NextResponse.json(data)
}
