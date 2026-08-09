// GET /api/admin/media-credits/sessions?status=SEALED|ACTIVE&quarantined=true
//
// MC-08. Platform-wide session lists for the operations console. READ ONLY.
//
// The reconciliation endpoint already reports session COUNTS; this returns the rows behind
// them, because "12 sealed sessions" is a number an operator can watch and "which twelve" is
// the question they ask next.
//
// No mutation, deliberately. Sessions are opened by the upload path and resolved by the
// scheduler; an admin endpoint that could seal or settle one would be a second way to move
// credits, which the architecture forbids.

import { NextRequest, NextResponse } from 'next/server'
import { resolveAdminUid } from '@/lib/admin/auth'
import * as sessionRepo from '@/features/media-credits/repositories/sessionRepo'
import { CREDIT_SESSION_STATUSES, type CreditSessionStatus } from '@/features/media-credits/types'
import { toDto } from '@/features/media-credits/services/sessionService'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const params = req.nextUrl.searchParams
  const raw    = Number(params.get('limit') ?? '50')
  const limit  = Math.min(Math.max(1, Number.isFinite(raw) ? Math.trunc(raw) : 50), 200)

  // Quarantined is its own view rather than a status: a quarantined session is still SEALED,
  // so filtering by status alone would never surface it separately.
  if (params.get('quarantined') === 'true') {
    const rows = await sessionRepo.listQuarantined(limit)
    return NextResponse.json(
      { view: 'quarantined', sessions: rows.map(toDto) },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  }

  const status = params.get('status') ?? 'SEALED'
  if (!(CREDIT_SESSION_STATUSES as readonly string[]).includes(status)) {
    return NextResponse.json({ error: `Unknown session status: ${status}` }, { status: 400 })
  }

  const rows = status === 'ACTIVE'
    // Expired-and-still-ACTIVE is the actionable subset: it means the sweep has not reached
    // them. A plain ACTIVE list is mostly healthy in-flight uploads.
    ? await sessionRepo.listExpiredActive(limit)
    : await sessionRepo.listSealed(limit)

  return NextResponse.json({
    view: status === 'ACTIVE' ? 'expired_active' : 'sealed',
    status: status as CreditSessionStatus,
    sessions: rows.map(toDto),
  }, { headers: { 'Cache-Control': 'no-store' } })
}
