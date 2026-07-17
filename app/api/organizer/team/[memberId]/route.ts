// PATCH  /api/organizer/team/[memberId]  — change role / suspend / reactivate.
// DELETE /api/organizer/team/[memberId]  — remove a member.
//
// Owner only. The workspace is the caller's own (organizerUid = caller uid), and
// service functions re-verify the target row belongs to that workspace.

import { NextRequest, NextResponse } from 'next/server'
import { verifyCaller, requireOwner } from '@/lib/team/access'
import { changeRole, setMemberStatus, removeMember } from '@/lib/team/service'

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
