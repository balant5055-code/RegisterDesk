// GET /api/admin/communications — platform-wide communications analytics
// (admin-only). Aggregation-based; see lib/analytics/adminCommunications.

import { NextRequest, NextResponse } from 'next/server'
import { requireSuperAdmin } from '@/lib/admin/financialGuard'
import { getAdminCommunications } from '@/lib/analytics/adminCommunications'

export async function GET(req: NextRequest): Promise<NextResponse> {
  // RD-CLOSE — a financial read: Super Admin only (ADMIN_UIDS). A legacy `admin: true` claim
  // alone gets 403 SUPER_ADMIN_REQUIRED (lib/admin/financialGuard.ts).
  const superGate = await requireSuperAdmin(req)
  if (superGate.response) return superGate.response
  try {
    const data = await getAdminCommunications()
    return NextResponse.json({ data }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    console.error('[admin/communications] failed', e)
    return NextResponse.json({ error: 'Failed to load' }, { status: 500 })
  }
}
