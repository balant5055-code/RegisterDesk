// GET /admin/communications/timeline — the canonical Communication Timeline (admin-only,
// READ-ONLY). Historical record of every platform email + WhatsApp communication, resolved
// through the one timeline resolver. Supports search / notification / provider / channel /
// status / date / recipient / priority / category filters. No mutation, replay, or resend.
// RD-PLATFORM-COMMS-01 Phase 4F.

import { NextRequest, NextResponse } from 'next/server'
import { resolveAdminUid } from '@/lib/admin/auth'
import { resolveTimeline } from '@/lib/communications/timeline/resolve'
import type { TimelineFilters, TimelineChannel, TimelineStatus } from '@/lib/communications/timeline/types'

export async function GET(req: NextRequest): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  try {
    const q = req.nextUrl.searchParams
    const filters: TimelineFilters = {
      search:       q.get('search')       ?? undefined,
      notification: q.get('notification') ?? undefined,
      provider:     q.get('provider')     ?? undefined,
      channel:      (q.get('channel') as TimelineChannel | null) ?? undefined,
      status:       (q.get('status')  as TimelineStatus  | null) ?? undefined,
      dateFrom:     q.get('dateFrom')     ?? undefined,
      dateTo:       q.get('dateTo')       ?? undefined,
      recipient:    q.get('recipient')    ?? undefined,
      priority:     q.get('priority')     ?? undefined,
      category:     q.get('category')     ?? undefined,
      limit:        q.get('limit') ? Number(q.get('limit')) : undefined,
    }
    const data = await resolveTimeline(filters)
    return NextResponse.json({ data }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    console.error('[admin/communications/timeline] failed', e)
    return NextResponse.json({ error: 'Failed to load' }, { status: 500 })
  }
}
