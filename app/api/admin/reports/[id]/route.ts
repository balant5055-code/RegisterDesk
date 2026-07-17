// GET   /api/admin/reports/[id] — report + resolved target + related reports
// PATCH /api/admin/reports/[id] — reviewing | dismiss | take_down | suspend
//
// Admin-only. take_down/suspend DELEGATE to the shared moderation/organizer
// services (no duplicated takedown logic). Every action is audited.

import { NextRequest, NextResponse } from 'next/server'
import { resolveAdminUid }           from '@/lib/admin/auth'
import { getReportDetail, applyReportAction } from '@/lib/admin/reportService'
import type { AdminReportAction, AdminReportPatchResponse } from '@/lib/admin/reportTypes'

interface RouteContext {
  params: Promise<{ id: string }>
}

export async function GET(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { id } = await ctx.params
  const detail = await getReportDetail(id)
  if (!detail) return NextResponse.json({ error: 'Report not found' }, { status: 404 })

  return NextResponse.json(detail)
}

interface PatchBody {
  action?:     unknown
  resolution?: unknown
}

export async function PATCH(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { id } = await ctx.params

  let body: PatchBody
  try { body = await req.json() as PatchBody }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  const action = body.action
  if (action !== 'reviewing' && action !== 'dismiss' && action !== 'take_down' && action !== 'suspend') {
    return NextResponse.json(
      { error: "action must be 'reviewing', 'dismiss', 'take_down', or 'suspend'" },
      { status: 400 },
    )
  }
  const resolution = typeof body.resolution === 'string' ? body.resolution.trim() : ''

  const result = await applyReportAction(id, action as AdminReportAction, adminUid, resolution)
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.httpStatus })

  return NextResponse.json({ id, status: result.status } satisfies AdminReportPatchResponse)
}
