// GET /api/admin/organizers/[uid]/business — licenses / coupons / wallet /
// settlements / entitlements. Admin-gated, lazy. Reuses getOrganizer360Business.

import { NextRequest, NextResponse } from 'next/server'
import { requireSuperAdmin } from '@/lib/admin/financialGuard'
import { getOrganizer360Business }   from '@/lib/admin/organizer360Service'

interface RouteContext { params: Promise<{ uid: string }> }

export async function GET(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  // RD-CLOSE — a financial read: Super Admin only (ADMIN_UIDS). A legacy `admin: true` claim
  // alone gets 403 SUPER_ADMIN_REQUIRED (lib/admin/financialGuard.ts).
  const superGate = await requireSuperAdmin(req)
  if (superGate.response) return superGate.response

  const { uid } = await ctx.params
  try {
    const data = await getOrganizer360Business(uid)
    if (!data) return NextResponse.json({ error: 'Organizer not found' }, { status: 404 })
    return NextResponse.json(data, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    console.error('[admin/organizers/business] failed', e)
    return NextResponse.json({ error: 'Failed to load business data' }, { status: 500 })
  }
}
