// GET /api/admin/analytics — platform analytics (admin-only). Aggregation-based,
// no full scans. See lib/analytics/adminAnalytics.

import { NextRequest, NextResponse } from 'next/server'
import { resolveAdminUid } from '@/lib/admin/auth'
import { getAdminAnalytics } from '@/lib/analytics/adminAnalytics'

export async function GET(req: NextRequest): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  try {
    const analytics = await getAdminAnalytics()
    return NextResponse.json({ analytics }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    console.error('[admin/analytics] failed', e)
    return NextResponse.json({ error: 'Failed to load analytics' }, { status: 500 })
  }
}
