// GET /admin/communications/campaigns — the canonical Campaign Registry (admin-only,
// READ-ONLY). Returns resolved PLATFORM campaigns (RegisterDesk → Organizer). No execution,
// sending, scheduling, or mutation. Namespaced under /communications to avoid the existing
// /admin/campaigns (donation-campaign moderation). RD-PLATFORM-COMMS-02 Phase 5A.

import { NextRequest, NextResponse } from 'next/server'
import { resolveAdminUid } from '@/lib/admin/auth'
import { resolveCampaigns, type CampaignFilters } from '@/lib/communications/campaigns/resolve'
import type { CampaignStatus, CampaignType, CampaignCategory } from '@/lib/communications/campaigns/types'

export async function GET(req: NextRequest): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  try {
    const q = req.nextUrl.searchParams
    const filters: CampaignFilters = {
      status:   (q.get('status')   as CampaignStatus   | null) ?? undefined,
      type:     (q.get('type')     as CampaignType     | null) ?? undefined,
      category: (q.get('category') as CampaignCategory | null) ?? undefined,
      search:   q.get('search') ?? undefined,
    }
    const data = await resolveCampaigns(filters)
    return NextResponse.json({ data }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    console.error('[admin/communications/campaigns] failed', e)
    return NextResponse.json({ error: 'Failed to load' }, { status: 500 })
  }
}
