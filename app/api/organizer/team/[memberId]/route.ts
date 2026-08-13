// PATCH  /api/organizer/team/[memberId]  — change role / suspend / reactivate.
// DELETE /api/organizer/team/[memberId]  — remove a member.
//
// Owner only. The workspace is the caller's own (organizerUid = caller uid), and
// service functions re-verify the target row belongs to that workspace.

import { NextRequest, NextResponse } from 'next/server'
import { verifyCaller, requireOwner } from '@/lib/team/access'
import { changeRole, setMemberStatus, removeMember, resendInvitation } from '@/lib/team/service'
import { RATE_POLICY, checkPolicy } from '@/lib/rateLimit/policies'

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ memberId: string }> },
): Promise<NextResponse> {
  const caller = await verifyCaller(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const access = requireOwner(caller.uid, caller.uid)
  if (!access.ok) return NextResponse.json({ error: access.reason }, { status: access.status })

  const { memberId } = await params
  let body: { action?: unknown; role?: unknown }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 }) }

  const base = { organizerUid: caller.uid, ownerUid: caller.uid, memberId }

  if (body.action === 'change_role') {
    if (typeof body.role !== 'string') return NextResponse.json({ error: 'Role is required.' }, { status: 400 })
    const r = await changeRole({ ...base, role: body.role })
    return r.ok ? NextResponse.json({ member: r.data }) : NextResponse.json({ error: r.error }, { status: r.status })
  }
  if (body.action === 'suspend' || body.action === 'reactivate') {
    const r = await setMemberStatus({ ...base, status: body.action === 'suspend' ? 'suspended' : 'active' })
    return r.ok ? NextResponse.json({ member: r.data }) : NextResponse.json({ error: r.error }, { status: r.status })
  }
  if (body.action === 'resend') {
    // Throttled, and ONLY here. The other actions are pure Firestore writes; resend is the
    // one that sends email, which makes it the one that could be looped to mail-bomb an
    // address and burn provider quota. It reuses the POST invite policy rather than adding a
    // second one, so both routes that can send an invitation share a single budget.
    const rl = checkPolicy(caller.uid, RATE_POLICY.teamInvite)
    if (rl.limited) return NextResponse.json(
      { error: 'Too many invitations. Please try again later.' },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfter) } },
    )
    const r = await resendInvitation({ ...base, ownerEmail: caller.email })
    return r.ok ? NextResponse.json({ member: r.data }) : NextResponse.json({ error: r.error }, { status: r.status })
  }
  return NextResponse.json({ error: 'Unknown action.' }, { status: 400 })
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ memberId: string }> },
): Promise<NextResponse> {
  const caller = await verifyCaller(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const access = requireOwner(caller.uid, caller.uid)
  if (!access.ok) return NextResponse.json({ error: access.reason }, { status: access.status })

  const { memberId } = await params
  const r = await removeMember({ organizerUid: caller.uid, ownerUid: caller.uid, callerUid: caller.uid, memberId })
  return r.ok ? NextResponse.json({ success: true }) : NextResponse.json({ error: r.error }, { status: r.status })
}
