// GET /api/admin/platform-monitor/overview — platform KPIs + Health Panel.
// Admin-gated. Reuses getPlatformOverview (getAdminAnalytics + bounded rollups).
// Honesty: today metrics that cannot be derived are null → UI shows "Unavailable".

import { NextRequest, NextResponse } from 'next/server'
import { resolveAdminUid }              from '@/lib/admin/auth'
import { getPlatformOverview }          from '@/lib/admin/platformMonitorService'
import type { PlatformOverviewResponse } from '@/lib/admin/platformMonitorTypes'

export async function GET(req: NextRequest): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  try {
    const overview = await getPlatformOverview()
    return NextResponse.json({ overview } satisfies PlatformOverviewResponse, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    console.error('[admin/platform-monitor/overview] failed', e)
    return NextResponse.json({ error: 'Failed to load overview' }, { status: 500 })
  }
}
