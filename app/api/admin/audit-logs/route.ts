// GET /api/admin/audit-logs
//
// Admin-only, cursor-paginated audit trail (createdAt desc).
//
// Query params (all optional):
//   action, entityType, adminUid, entityId, startDate, endDate, cursor, pageSize

import { NextRequest, NextResponse } from 'next/server'
import { requireSuperAdmin } from '@/lib/admin/financialGuard'
import { listAuditLogs }             from '@/lib/admin/auditViewerService'
import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES } from '@/lib/admin/audit'
import type { AdminAuditAction, AdminAuditEntityType } from '@/lib/admin/audit'
import type { AuditLogFilters }      from '@/lib/admin/auditViewerTypes'

function parseAction(s: string | null): AdminAuditAction | undefined {
  return s && (AUDIT_ACTIONS as readonly string[]).includes(s) ? s as AdminAuditAction : undefined
}
function parseEntityType(s: string | null): AdminAuditEntityType | undefined {
  return s && (AUDIT_ENTITY_TYPES as readonly string[]).includes(s) ? s as AdminAuditEntityType : undefined
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  // RD-PHASE4-S4 · D7 — the platform audit log holds the FINANCIAL audit trail (settlements,
  // payouts, refunds, licences, clawbacks…): Super Admin only.
  const guard = await requireSuperAdmin(req)
  if (guard.response) return guard.response

  const { searchParams } = req.nextUrl
  const filters: AuditLogFilters = {
    action:     parseAction(searchParams.get('action')),
    entityType: parseEntityType(searchParams.get('entityType')),
    adminUid:   (searchParams.get('adminUid') ?? '').trim() || undefined,
    entityId:   (searchParams.get('entityId') ?? '').trim() || undefined,
    startDate:  (searchParams.get('startDate') ?? '').trim() || undefined,
    endDate:    (searchParams.get('endDate') ?? '').trim() || undefined,
    cursor:     (searchParams.get('cursor') ?? '').trim() || undefined,
    pageSize:   parseInt(searchParams.get('pageSize') ?? '50', 10) || 50,
  }

  const result = await listAuditLogs(filters)
  return NextResponse.json(result)
}
