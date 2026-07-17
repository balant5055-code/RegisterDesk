// GET /api/admin/campaigns
//
// Admin-only, cursor-paginated list of published donation campaigns for
// moderation. Same query semantics as /api/admin/events.

import { NextRequest, NextResponse } from 'next/server'
import { resolveAdminUid }           from '@/lib/admin/auth'
import { listModerationItems }       from '@/lib/admin/moderationService'
import type { ModerationStatus }     from '@/lib/admin/moderation'

// Campaign title lives at campaignDetails.basics.title.
function campaignTitle(d: Record<string, unknown>): string {
  const cd     = d.campaignDetails as Record<string, unknown> | undefined
  const basics = cd?.basics as Record<string, unknown> | undefined
  const title  = basics?.title
  return typeof title === 'string' && title.trim() ? title.trim() : '(untitled campaign)'
}

function parseStatus(s: string | null): ModerationStatus | null {
  return s === 'active' || s === 'under_review' || s === 'taken_down' ? s : null
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { searchParams } = req.nextUrl
  const result = await listModerationItems('donationCampaigns', campaignTitle, {
    pageSize:     Math.min(100, Math.max(1, parseInt(searchParams.get('pageSize') ?? '25', 10))),
    cursor:       searchParams.get('cursor') ?? '',
    search:       (searchParams.get('search') ?? '').trim().toLowerCase(),
    status:       parseStatus(searchParams.get('status')),
    organizerUid: (searchParams.get('organizerUid') ?? '').trim(),
  })

  return NextResponse.json(result)
}
