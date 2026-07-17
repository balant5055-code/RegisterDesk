// GET /api/organizer/crm/analytics — total contacts, repeat attendees, top donors,
// retention rate, donation value. Finance scope → donation metrics only.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeCrm } from '@/lib/crm/access'
import { computeAnalytics } from '@/lib/crm/queries'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest): Promise<NextResponse> {
  const authz = await authorizeCrm(req)
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })

  const analytics = await computeAnalytics(authz.workspaceUid, authz.scope)
  return NextResponse.json({ analytics, scope: authz.scope }, { headers: { 'Cache-Control': 'no-store' } })
}
