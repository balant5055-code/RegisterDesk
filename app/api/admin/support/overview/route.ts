// GET /api/admin/support/overview — Support Workspace overview + health.
// Admin-gated. Reuses getSupportOverview (bounded recent reads + count aggregations).

import { NextRequest, NextResponse } from 'next/server'
import { resolveAdminUid }             from '@/lib/admin/auth'
import { getSupportOverview }          from '@/lib/admin/supportService'
import type { SupportOverviewResponse } from '@/lib/admin/supportTypes'

export async function GET(req: NextRequest): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  try {
    const overview = await getSupportOverview()
    return NextResponse.json({ overview } satisfies SupportOverviewResponse, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    console.error('[admin/support/overview] failed', e)
    return NextResponse.json({ error: 'Failed to load support overview' }, { status: 500 })
  }
}
