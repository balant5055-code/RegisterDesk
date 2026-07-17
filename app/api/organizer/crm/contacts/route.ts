// GET /api/organizer/crm/contacts?search&filter&tag
// Workspace + role aware. owner/admin/manager → full; finance → donors only;
// checkin_staff → denied.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeCrm } from '@/lib/crm/access'
import { listContacts, type ContactFilter } from '@/lib/crm/queries'
import { getFeatureFlags } from '@/lib/config/resolveFeatureFlags'

export const dynamic = 'force-dynamic'

const FILTERS: ContactFilter[] = ['all', 'donors', 'repeat', 'checked_in', 'not_checked_in']

export async function GET(req: NextRequest): Promise<NextResponse> {
  const authz = await authorizeCrm(req)
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })

  // Feature flag (Business Configuration) — global CRM master switch.
  if (!(await getFeatureFlags()).crm) {
    return NextResponse.json({ error: 'CRM is currently disabled.' }, { status: 403 })
  }

  const p = req.nextUrl.searchParams
  const filterParam = p.get('filter')
  const filter = FILTERS.includes(filterParam as ContactFilter) ? (filterParam as ContactFilter) : 'all'

  const result = await listContacts(authz.workspaceUid, {
    search: (p.get('search') ?? '').slice(0, 120),
    filter,
    tag: (p.get('tag') ?? '').trim().toLowerCase() || undefined,
    scope: authz.scope,
    cursor: (p.get('cursor') ?? '').trim() || undefined,
  })
  return NextResponse.json({ ...result, scope: authz.scope }, { headers: { 'Cache-Control': 'no-store' } })
}
