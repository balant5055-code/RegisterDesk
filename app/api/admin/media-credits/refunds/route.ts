// GET /api/admin/media-credits/refunds?status=requested
//
// The platform refund queue. ADMIN ONLY — `resolveAdminUid` is the same gate every other
// /api/admin route uses; no new RBAC was introduced for Media Credits.
//
// Not tenant-scoped, deliberately: this is the cross-organizer review queue. That is exactly
// why it must never be reachable from an organizer-authenticated route.

import { NextRequest, NextResponse } from 'next/server'
import { resolveAdminUid } from '@/lib/admin/auth'
import { refundService } from '@/features/media-credits/services/refundService'
import { CREDIT_REFUND_STATUSES, type CreditRefundStatus } from '@/features/media-credits/types'

export async function GET(req: NextRequest): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const url    = new URL(req.url)
  const raw    = url.searchParams.get('status') ?? 'requested'
  const limit  = Number(url.searchParams.get('limit') ?? '25')
  const cursor = url.searchParams.get('cursor')

  if (!(CREDIT_REFUND_STATUSES as readonly string[]).includes(raw)) {
    return NextResponse.json({ error: `Unknown refund status: ${raw}` }, { status: 400 })
  }

  const page = await refundService.listByStatus(
    raw as CreditRefundStatus, Number.isFinite(limit) ? limit : 25, cursor,
  )
  return NextResponse.json(page, { headers: { 'Cache-Control': 'no-store' } })
}
