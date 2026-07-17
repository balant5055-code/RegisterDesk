// GET /api/admin/license-center/overview — License & Coupon Command Center overview.
// Admin-gated. Reuses getLicenseCenterOverview (getAdminAnalytics + listCoupons +
// bounded eventLicenses count aggregations). Read-only.

import { NextRequest, NextResponse } from 'next/server'
import { resolveAdminUid }             from '@/lib/admin/auth'
import { getLicenseCenterOverview }    from '@/lib/admin/licenseCenterService'
import type { LicenseCenterOverviewResponse } from '@/lib/admin/licenseCenterTypes'

export async function GET(req: NextRequest): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  try {
    const overview = await getLicenseCenterOverview()
    return NextResponse.json({ overview } satisfies LicenseCenterOverviewResponse, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    console.error('[admin/license-center/overview] failed', e)
    return NextResponse.json({ error: 'Failed to load overview' }, { status: 500 })
  }
}
