// PATCH /api/admin/incidents/[id] — transition status / add postmortem. Admin-only.

import { NextRequest, NextResponse } from 'next/server'
import { resolveAdminUid } from '@/lib/admin/auth'
import { updateIncident, isStatus } from '@/lib/operations/incidents'

export const dynamic = 'force-dynamic'

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const { id } = await ctx.params

  let body: { status?: unknown; postmortem?: unknown }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  if (body.status !== undefined && !isStatus(body.status)) {
    return NextResponse.json({ error: 'Invalid status' }, { status: 400 })
  }

  const incident = await updateIncident(adminUid, id, {
    status: isStatus(body.status) ? body.status : undefined,
    postmortem: typeof body.postmortem === 'string' ? body.postmortem : undefined,
  })
  if (!incident) return NextResponse.json({ error: 'Incident not found' }, { status: 404 })
  return NextResponse.json({ incident })
}
