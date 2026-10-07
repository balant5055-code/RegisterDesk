// PATCH  /api/organizer/staff/[staffId] — update name, role, events, or status;
//                                          or issue a new password.
// DELETE /api/organizer/staff/[staffId] — remove the account and its credential.
//
// RD-CHECKIN-2.0. Owner only, and always within the caller's OWN workspace: the
// service re-checks that the account belongs to `caller.uid` before it writes, so
// a staffId from another workspace is a 404 rather than an edit.

import { NextRequest, NextResponse } from 'next/server'
import { verifyCaller, requireStaffManager } from '@/lib/team/access'
import { updateStaffAccount, deleteStaffAccount, resetStaffPassword } from '@/lib/staff/service'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ staffId: string }> }

export async function PATCH(req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const caller = await verifyCaller(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // A gate credential may not manage staff accounts — see requireStaffManager
  // (RD-CHECKIN-07 Defect 1). The workspace is still always the caller's own uid.
  const access = await requireStaffManager(caller)
  if (!access.ok) return NextResponse.json({ error: access.reason }, { status: access.status })

  const { staffId } = await ctx.params

  let body: Record<string, unknown>
  try { body = await req.json() as Record<string, unknown> }
  catch { return NextResponse.json({ error: 'Invalid request.' }, { status: 400 }) }

  // ── Password reset is its own action, not a field ─────────────────────────
  // Modelled as an explicit intent so it can never be triggered as a side effect
  // of editing a name, and so the one-time password is returned only when it was
  // actually asked for.
  if (body.action === 'reset_password') {
    const result = await resetStaffPassword({ organizerUid: caller.uid, staffId })
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
    return NextResponse.json(result.data)
  }

  const result = await updateStaffAccount({
    organizerUid: caller.uid,
    actorUid:     caller.uid,
    staffId,
    displayName: typeof body.displayName === 'string' ? body.displayName : undefined,
    role:        typeof body.role        === 'string' ? body.role        : undefined,
    eventIds:    body.eventIds,
    status:      body.status === 'active' || body.status === 'suspended' ? body.status : undefined,
  })
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
  return NextResponse.json({ staff: result.data })
}

export async function DELETE(req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const caller = await verifyCaller(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // A gate credential may not manage staff accounts — see requireStaffManager
  // (RD-CHECKIN-07 Defect 1). The workspace is still always the caller's own uid.
  const access = await requireStaffManager(caller)
  if (!access.ok) return NextResponse.json({ error: access.reason }, { status: access.status })

  const { staffId } = await ctx.params
  const result = await deleteStaffAccount({ organizerUid: caller.uid, staffId })
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
  return NextResponse.json({ ok: true })
}
