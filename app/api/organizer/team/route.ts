// GET  /api/organizer/team  — list this owner's team members + pending invites.
// POST /api/organizer/team  — invite a new member (owner only).
//
// The workspace is always the caller's own (organizerUid = caller uid), so a
// team member calling this only ever sees/manages their own (empty) workspace,
// never the owner's. All permission logic comes from lib/team/access.

import { NextRequest, NextResponse } from 'next/server'
import { verifyCaller, requireOwner, requireAdmin } from '@/lib/team/access'
import { listTeam, inviteMember }     from '@/lib/team/service'
import { requireFeature, requireLimit } from '@/lib/licensing/workspaceEntitlements'
import { RATE_POLICY, checkPolicy }   from '@/lib/rateLimit/policies'

export async function GET(req: NextRequest): Promise<NextResponse> {
  const caller = await verifyCaller(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Owner or admin of their own workspace may view the team.
  const access = await requireAdmin(caller.uid, caller.uid)
  if (!access.ok) return NextResponse.json({ error: access.reason }, { status: access.status })

  const data = await listTeam(caller.uid)
  return NextResponse.json(data)
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const caller = await verifyCaller(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const access = requireOwner(caller.uid, caller.uid)
  if (!access.ok) return NextResponse.json({ error: access.reason }, { status: access.status })

  // Throttle invites (each sends an email) against automation / abuse.
  const rl = checkPolicy(caller.uid, RATE_POLICY.teamInvite)
  if (rl.limited) return NextResponse.json(
    { error: 'Too many invitations. Please try again later.' },
    { status: 429, headers: { 'Retry-After': String(rl.retryAfter) } },
  )

  // Plan gate — team access is a paid feature, and the plan caps team size.
  const feat = await requireFeature(caller.uid, 'teamAccess')
  if (!feat.ok) return NextResponse.json({ error: feat.error }, { status: feat.status })
  const { members, invites } = await listTeam(caller.uid)
  const lim = await requireLimit(caller.uid, 'maxTeamMembers', members.length + invites.length + 1)
  if (!lim.ok) return NextResponse.json({ error: lim.error }, { status: lim.status })

  let body: { email?: unknown; role?: unknown }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 }) }
  if (typeof body.email !== 'string' || typeof body.role !== 'string') {
    return NextResponse.json({ error: 'Email and role are required.' }, { status: 400 })
  }

  const result = await inviteMember({
    organizerUid: caller.uid, ownerUid: caller.uid, ownerEmail: caller.email,
    email: body.email, role: body.role,
  })
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
  return NextResponse.json({ member: result.data }, { status: 201 })
}
