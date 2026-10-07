// GET /api/admin/organizers/[uid]/governance — audit / entitlements & overrides /
// team permissions. Admin-gated, lazy. Reuses getOrganizer360Governance.

import { NextRequest, NextResponse } from 'next/server'
import { resolveAdminUid, resolveSuperAdminUid } from '@/lib/admin/auth'
import { getOrganizer360Governance }   from '@/lib/admin/organizer360Service'

interface RouteContext { params: Promise<{ uid: string }> }

export async function GET(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { uid } = await ctx.params
  try {
    // RD-PHASE4-S4 · D7 — financial audit rows are returned to a Super Admin only.
    const data = await getOrganizer360Governance(uid, { includeFinancialAudit: (await resolveSuperAdminUid(req.headers.get('authorization'))) !== null })
    if (!data) return NextResponse.json({ error: 'Organizer not found' }, { status: 404 })
    return NextResponse.json(data, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    console.error('[admin/organizers/governance] failed', e)
    return NextResponse.json({ error: 'Failed to load governance data' }, { status: 500 })
  }
}
