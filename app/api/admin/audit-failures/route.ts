// GET /api/admin/audit-failures
//
// RD-PHASE4-S4 closeout — Super Admin review of audit rows that could not be written after an
// external (gateway) action already happened. Read-only. Query params (all optional):
//   status=open|resolved|all (default open), action, entityType, entityId, cursor, pageSize
// Error text is redacted server-side; the stored audit copy was sanitized when it was recorded.

import { NextRequest, NextResponse } from 'next/server'
import { requireSuperAdmin } from '@/lib/admin/financialGuard'
import { listAuditFailures } from '@/lib/admin/auditFailureService'
import { AUDIT_FAILURE_STATUS_FILTERS, type AuditFailureStatusFilter } from '@/lib/admin/auditFailureTypes'

const NO_STORE = { 'Cache-Control': 'no-store' }

export async function GET(req: NextRequest): Promise<NextResponse> {
  const guard = await requireSuperAdmin(req)
  if (guard.response) return guard.response

  const sp = req.nextUrl.searchParams
  const rawStatus = sp.get('status') ?? 'open'
  if (!(AUDIT_FAILURE_STATUS_FILTERS as readonly string[]).includes(rawStatus)) {
    return NextResponse.json({ error: 'status must be open, resolved or all', code: 'INVALID_STATUS' }, { status: 400, headers: NO_STORE })
  }
  const trim = (k: string) => (sp.get(k) ?? '').trim().slice(0, 200) || undefined
  try {
    const result = await listAuditFailures({
      status:     rawStatus as AuditFailureStatusFilter,
      action:     trim('action'),
      entityType: trim('entityType'),
      entityId:   trim('entityId'),
      cursor:     trim('cursor'),
      pageSize:   parseInt(sp.get('pageSize') ?? '50', 10) || 50,
    })
    return NextResponse.json(result, { headers: NO_STORE })
  } catch (e) {
    console.error('[admin/audit-failures] list failed', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Failed to load audit failures' }, { status: 500, headers: NO_STORE })
  }
}
