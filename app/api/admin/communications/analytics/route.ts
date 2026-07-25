// GET /admin/communications/analytics — the canonical Communication Analytics Foundation
// (admin-only, READ-ONLY). Aggregates the resolved TIMELINE into overall / provider / channel
// / category / notification / template breakdowns. No charts, no mutation; analytics consumes
// the timeline, never providers. RD-PLATFORM-COMMS-01 Phase 4G.

import { NextRequest, NextResponse } from 'next/server'
import { resolveAdminUid } from '@/lib/admin/auth'
import { resolveCommunicationAnalytics } from '@/lib/communications/analytics/resolve'
import type { TimelineFilters, TimelineChannel } from '@/lib/communications/timeline/types'

export async function GET(req: NextRequest): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  try {
    const q = req.nextUrl.searchParams
    const filters: TimelineFilters = {
      channel:  (q.get('channel') as TimelineChannel | null) ?? undefined,
      dateFrom: q.get('dateFrom') ?? undefined,
      dateTo:   q.get('dateTo')   ?? undefined,
      limit:    q.get('limit') ? Number(q.get('limit')) : undefined,
    }
    const data = await resolveCommunicationAnalytics(filters)
    return NextResponse.json({ data }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    console.error('[admin/communications/analytics] failed', e)
    return NextResponse.json({ error: 'Failed to load' }, { status: 500 })
  }
}
