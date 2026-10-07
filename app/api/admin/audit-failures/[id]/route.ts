// GET  /api/admin/audit-failures/[id] — one failure record + audit rows that already match it.
// POST /api/admin/audit-failures/[id] — { action: 'replay' | 'mark_present', reason }
//
// RD-PHASE4-S4 closeout — Super Admin only; a 3–500 character reason; one transaction per
// reconciliation, itself audited (lib/admin/auditFailureService.ts). Never touches money.

import { NextRequest, NextResponse } from 'next/server'
import { requireSuperAdmin, parseFinancialReason, reasonErrorResponse } from '@/lib/admin/financialGuard'
import { getAuditFailureDetail, reconcileAuditFailure, AuditFailureError } from '@/lib/admin/auditFailureService'
import { AUDIT_FAILURE_ACTIONS, type AuditFailureAction } from '@/lib/admin/auditFailureTypes'

type Ctx = { params: Promise<{ id: string }> }
const NO_STORE = { 'Cache-Control': 'no-store' }

export async function GET(req: NextRequest, { params }: Ctx): Promise<NextResponse> {
  const guard = await requireSuperAdmin(req)
  if (guard.response) return guard.response
  const { id } = await params
  const detail = await getAuditFailureDetail(id)
  if (!detail) return NextResponse.json({ error: 'Audit failure record not found.' }, { status: 404, headers: NO_STORE })
  return NextResponse.json(detail, { headers: NO_STORE })
}

export async function POST(req: NextRequest, { params }: Ctx): Promise<NextResponse> {
  const guard = await requireSuperAdmin(req)
  if (guard.response) return guard.response
  const { id } = await params

  let body: { action?: unknown; reason?: unknown }
  try { body = await req.json() as { action?: unknown; reason?: unknown } }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  if (!(AUDIT_FAILURE_ACTIONS as readonly unknown[]).includes(body.action)) {
    return NextResponse.json({ error: "action must be 'replay' or 'mark_present'", code: 'INVALID_ACTION' }, { status: 400 })
  }
  const r = parseFinancialReason(body.reason)
  if (!r.ok) return reasonErrorResponse(r)

  try {
    const result = await reconcileAuditFailure(id, body.action as AuditFailureAction, guard.uid, r.reason)
    return NextResponse.json(result)
  } catch (e) {
    if (e instanceof AuditFailureError) return NextResponse.json({ error: e.message, code: e.code }, { status: e.status })
    console.error('[admin/audit-failures] reconcile failed', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'The reconciliation could not be saved. Nothing was changed.' }, { status: 500 })
  }
}
