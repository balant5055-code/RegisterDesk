// GET /api/admin/operations-center/overview — NOC status rollup + Health Panel.
// Admin-gated. Reuses getOpsOverview (bounded count() aggregations over the existing
// job collections). Read-only.

import { NextRequest, NextResponse } from 'next/server'
import { resolveAdminUid }           from '@/lib/admin/auth'
import { getOpsOverview }            from '@/lib/admin/operationsCenterService'
import type { OpsOverviewResponse }  from '@/lib/admin/operationsCenterTypes'

export async function GET(req: NextRequest): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  try {
    const overview = await getOpsOverview()
    return NextResponse.json({ overview } satisfies OpsOverviewResponse, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    console.error('[admin/operations-center/overview] failed', e)
    return NextResponse.json({ error: 'Failed to load overview' }, { status: 500 })
  }
}
