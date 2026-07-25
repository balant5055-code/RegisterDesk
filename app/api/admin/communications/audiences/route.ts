// GET /admin/communications/audiences — the canonical Audience Builder registry (admin-only,
// READ-ONLY). Returns resolved platform audiences (validated rule trees + health). No execution,
// evaluation against live data, or mutation. RD-PLATFORM-COMMS-02 Phase 5B.

import { NextRequest, NextResponse } from 'next/server'
import { resolveAdminUid } from '@/lib/admin/auth'
import { resolveAudiences, type AudienceFilters } from '@/lib/communications/audiences/resolve'
import type { AudienceType, AudienceScope, AudienceStatus } from '@/lib/communications/audiences/types'

export async function GET(req: NextRequest): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  try {
    const q = req.nextUrl.searchParams
    const filters: AudienceFilters = {
      type:   (q.get('type')   as AudienceType   | null) ?? undefined,
      scope:  (q.get('scope')  as AudienceScope  | null) ?? undefined,
      status: (q.get('status') as AudienceStatus | null) ?? undefined,
      search: q.get('search') ?? undefined,
    }
    const data = await resolveAudiences(filters)
    return NextResponse.json({ data }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    console.error('[admin/communications/audiences] failed', e)
    return NextResponse.json({ error: 'Failed to load' }, { status: 500 })
  }
}
