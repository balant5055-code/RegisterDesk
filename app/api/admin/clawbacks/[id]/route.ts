// GET   /api/admin/clawbacks/[id]  — clawback detail + audit history
// PATCH /api/admin/clawbacks/[id]  — { action: 'waive' | 'mark_recovered', reason, amountPaise?, requestId? }
//   mark_recovered = collected OUTSIDE the wallet (Phase 3.3: recorded as offPlatformRecoveredAmountPaise);
//   amountPaise (+ requestId) records a PARTIAL off-platform recovery.
//
// GET is admin. PATCH is Super Admin only (RD-PHASE4-S4 · D1) with a 3–500 character reason
// (D3, `reason` or the legacy `note`); the service stages the audit row in the SAME
// transaction as the resolution (D6).

import { NextRequest, NextResponse } from 'next/server'
import { resolveSuperAdminUid } from '@/lib/admin/auth'
import { requireSuperAdmin, parseFinancialReason, reasonErrorResponse } from '@/lib/admin/financialGuard'
import { adminDb }                   from '@/lib/firebase/admin'
import {
  getClawback, waiveClawback, markClawbackRecovered,
} from '@/lib/clawbacks/clawbackService'

type Ctx = { params: Promise<{ id: string }> }

function tsToISO(ts: unknown): string | null {
  if (ts && typeof (ts as { toDate?: () => Date }).toDate === 'function') {
    return (ts as { toDate: () => Date }).toDate().toISOString()
  }
  return null
}

export async function GET(req: NextRequest, { params }: Ctx): Promise<NextResponse> {
  // RD-CLOSE — a financial read: Super Admin only (ADMIN_UIDS). A legacy `admin: true` claim
  // alone gets 403 SUPER_ADMIN_REQUIRED (lib/admin/financialGuard.ts).
  const superGate = await requireSuperAdmin(req)
  if (superGate.response) return superGate.response

  const { id } = await params
  const clawback = await getClawback(id)
  if (!clawback) return NextResponse.json({ error: 'Clawback not found' }, { status: 404 })

  // History — audit-log events for this clawback entity, newest first. RD-PHASE4-S4 · D7 — the
  // financial audit trail is returned to a Super Admin only (an empty history otherwise).
  const isSuper = (await resolveSuperAdminUid(req.headers.get('authorization'))) !== null
  const histSnap = !isSuper ? { docs: [] as FirebaseFirestore.QueryDocumentSnapshot[] } : await adminDb.collection('adminAuditLogs')
    .where('entityType', '==', 'clawback')
    .where('entityId', '==', id)
    .limit(50)
    .get()
  const history = histSnap.docs
    .map(d => {
      const x = d.data() as { action?: string; adminUid?: string; metadata?: unknown; createdAt?: unknown }
      return { action: x.action ?? '', actorUid: x.adminUid ?? '', metadata: x.metadata ?? null, createdAt: tsToISO(x.createdAt) }
    })
    .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))

  return NextResponse.json({ clawback, history }, { headers: { 'Cache-Control': 'no-store' } })
}

export async function PATCH(req: NextRequest, { params }: Ctx): Promise<NextResponse> {
  const guard = await requireSuperAdmin(req)
  if (guard.response) return guard.response
  const adminUid = guard.uid

  const { id } = await params
  let body: { action?: unknown; note?: unknown; reason?: unknown; amountPaise?: unknown; requestId?: unknown }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }
  if (body.action !== 'waive' && body.action !== 'mark_recovered') {
    return NextResponse.json({ error: 'Unknown action.' }, { status: 400 })
  }
  const r = parseFinancialReason(body.reason, body.note)
  if (!r.ok) return reasonErrorResponse(r)
  if (body.amountPaise !== undefined && typeof body.amountPaise !== 'number') return NextResponse.json({ error: 'amountPaise must be a number of paise.' }, { status: 400 })
  if (body.requestId !== undefined && typeof body.requestId !== 'string') return NextResponse.json({ error: 'requestId must be a string.' }, { status: 400 })
  if (body.action === 'waive' && (body.amountPaise !== undefined || body.requestId !== undefined)) return NextResponse.json({ error: 'waive takes no amount.' }, { status: 400 })

  const result = body.action === 'waive'
    ? await waiveClawback(id, adminUid, r.reason)
    : await markClawbackRecovered(id, adminUid, r.reason, { amountPaise: body.amountPaise as number | undefined, requestId: body.requestId as string | undefined })

  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
  return NextResponse.json({ clawback: result.view })
}
