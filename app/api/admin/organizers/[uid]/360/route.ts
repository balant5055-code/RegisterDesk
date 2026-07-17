// GET /api/admin/organizers/[uid]/360 — Organizer 360 overview + Health Panel.
// Admin-gated. Reuses getOrganizer360Overview (existing services + O(1) aggregates).

import { NextRequest, NextResponse } from 'next/server'
import { resolveAdminUid }           from '@/lib/admin/auth'
import { getOrganizer360Overview }   from '@/lib/admin/organizer360Service'

interface RouteContext { params: Promise<{ uid: string }> }

export async function GET(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { uid } = await ctx.params
  try {
    const overview = await getOrganizer360Overview(uid)
    if (!overview) return NextResponse.json({ error: 'Organizer not found' }, { status: 404 })
    return NextResponse.json({ overview }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    console.error('[admin/organizers/360] failed', e)
    return NextResponse.json({ error: 'Failed to load organizer overview' }, { status: 500 })
  }
}
