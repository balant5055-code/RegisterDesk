// GET /api/admin/audit-logs/[id]
//
// Admin-only single audit-log record (for the detail drawer).

import { NextRequest, NextResponse } from 'next/server'
import { resolveAdminUid }           from '@/lib/admin/auth'
import { getAuditLog }               from '@/lib/admin/auditViewerService'

interface RouteContext {
  params: Promise<{ id: string }>
}

export async function GET(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { id } = await ctx.params
  const log = await getAuditLog(id)
  if (!log) return NextResponse.json({ error: 'Audit log not found' }, { status: 404 })

  return NextResponse.json({ log })
}
