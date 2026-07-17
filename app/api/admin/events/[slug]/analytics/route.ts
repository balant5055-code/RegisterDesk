// GET /api/admin/events/[slug]/analytics — Event 360 Operations + Business data.
//
// Thin admin-gated wrapper over the EXISTING per-event analytics service
// (getEventAnalytics) — a single bounded, single-event query that already derives
// registrations, payments, passes, coupons, communications, reminders,
// certificates and the financial rollup from existing data. Lazy-loaded: fetched
// only when the Operations or Business workspace is opened. No new query logic.

import { NextRequest, NextResponse } from 'next/server'
import { resolveAdminUid }           from '@/lib/admin/auth'
import { getEventAnalytics }         from '@/lib/analytics/eventAnalytics'
import type { Event360Analytics }    from '@/lib/admin/event360Types'

interface RouteContext { params: Promise<{ slug: string }> }

export async function GET(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { slug } = await ctx.params
  try {
    const result = await getEventAnalytics(slug)
    if (!result) return NextResponse.json({ error: 'Event not found' }, { status: 404 })
    return NextResponse.json({ analytics: result.analytics } satisfies Event360Analytics, {
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (e) {
    console.error('[admin/events/360] analytics failed', e)
    return NextResponse.json({ error: 'Failed to load analytics' }, { status: 500 })
  }
}
