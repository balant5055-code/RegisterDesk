// RD-FEATURE-REQ-01 — Super Admin feature-request queue. Super Admin ONLY (ADMIN_UIDS) — a
// claim-only admin is refused, like every other Super Admin console.
//   ?status=<status>  that status (most recent 200)      ?cursor=<epoch ms>  next page (no filter)

import { NextRequest, NextResponse } from 'next/server'
import { requireSuperAdmin } from '@/lib/admin/financialGuard'
import { isStatus } from '@/lib/featureRequests/types'
import { adminListRequests } from '@/lib/featureRequests/service'

export async function GET(req: NextRequest): Promise<NextResponse> {
  const gate = await requireSuperAdmin(req)
  if (gate.response) return gate.response
  const p = req.nextUrl.searchParams
  const status = p.get('status')
  const cursorRaw = Number(p.get('cursor'))
  const result = await adminListRequests({
    status: isStatus(status) ? status : null,
    cursor: Number.isFinite(cursorRaw) && cursorRaw > 0 ? cursorRaw : null,
  })
  return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } })
}
