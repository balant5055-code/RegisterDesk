// GET /api/admin/audit-logs/[id]
//
// Admin-only single audit-log record (for the detail drawer).

import { NextRequest, NextResponse } from 'next/server'
import { requireSuperAdmin } from '@/lib/admin/financialGuard'
import { getAuditLog }               from '@/lib/admin/auditViewerService'

interface RouteContext {
  params: Promise<{ id: string }>
}

export async function GET(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  // RD-PHASE4-S4 · D7 — the platform audit log holds the FINANCIAL audit trail (settlements,
  // payouts, refunds, licences, clawbacks…): Super Admin only.
  const guard = await requireSuperAdmin(req)
  if (guard.response) return guard.response

  const { id } = await ctx.params
  const log = await getAuditLog(id)
  if (!log) return NextResponse.json({ error: 'Audit log not found' }, { status: 404 })

  return NextResponse.json({ log })
}
