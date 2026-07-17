// GET /api/admin/organizers/[uid]/timeline — merged chronological trail.
// Admin-gated, lazy. Reuses getOrganizer360Timeline (account/verification/license/
// event/payment/override/audit sources merged newest-first).

import { NextRequest, NextResponse } from 'next/server'
import { resolveAdminUid }           from '@/lib/admin/auth'
import { getOrganizer360Timeline }   from '@/lib/admin/organizer360Service'

interface RouteContext { params: Promise<{ uid: string }> }

export async function GET(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { uid } = await ctx.params
  try {
    const data = await getOrganizer360Timeline(uid)
    if (!data) return NextResponse.json({ error: 'Organizer not found' }, { status: 404 })
    return NextResponse.json(data, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    console.error('[admin/organizers/timeline] failed', e)
    return NextResponse.json({ error: 'Failed to load timeline' }, { status: 500 })
  }
}
