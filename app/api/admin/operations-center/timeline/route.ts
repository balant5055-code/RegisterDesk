// GET /api/admin/operations-center/timeline — merged job lifecycle events.
// Admin-gated, lazy. Reuses getOpsTimeline (created/completed/failed/cancelled
// events derived from the shared Job docs, newest-first).

import { NextRequest, NextResponse } from 'next/server'
import { resolveAdminUid }            from '@/lib/admin/auth'
import { getOpsTimeline }             from '@/lib/admin/operationsCenterService'
import type { OpsTimelineResponse }   from '@/lib/admin/operationsCenterTypes'

export async function GET(req: NextRequest): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  try {
    const entries = await getOpsTimeline()
    return NextResponse.json({ entries } satisfies OpsTimelineResponse, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    console.error('[admin/operations-center/timeline] failed', e)
    return NextResponse.json({ error: 'Failed to load timeline' }, { status: 500 })
  }
}
