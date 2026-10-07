// GET /api/admin/license-center/overview — License & Coupon Command Center overview.
// Admin-gated. Reuses getLicenseCenterOverview (getAdminAnalytics + listCoupons +
// bounded eventLicenses count aggregations). Read-only.

import { NextRequest, NextResponse } from 'next/server'
import { requireSuperAdmin } from '@/lib/admin/financialGuard'
import { getLicenseCenterOverview }    from '@/lib/admin/licenseCenterService'
import type { LicenseCenterOverviewResponse } from '@/lib/admin/licenseCenterTypes'

export async function GET(req: NextRequest): Promise<NextResponse> {
  // RD-CLOSE — a financial read: Super Admin only (ADMIN_UIDS). A legacy `admin: true` claim
  // alone gets 403 SUPER_ADMIN_REQUIRED (lib/admin/financialGuard.ts).
  const superGate = await requireSuperAdmin(req)
  if (superGate.response) return superGate.response
  try {
    const overview = await getLicenseCenterOverview()
    return NextResponse.json({ overview } satisfies LicenseCenterOverviewResponse, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    console.error('[admin/license-center/overview] failed', e)
    return NextResponse.json({ error: 'Failed to load overview' }, { status: 500 })
  }
}
