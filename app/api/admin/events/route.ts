// GET /api/admin/events
//
// Admin-only, cursor-paginated list of published events for moderation.
//
// Query params:
//   pageSize     — results per page (default 25, max 100)
//   cursor       — last slug from the previous page (publishedAt-desc cursor)
//   search       — substring over title / slug / organizer name (in-memory)
//   status       — 'active' | 'under_review' | 'taken_down' (effective)
//   organizerUid — restrict to one organizer (in-memory)

import { NextRequest, NextResponse } from 'next/server'
import { resolveAdminUid }           from '@/lib/admin/auth'
import { listModerationItems }       from '@/lib/admin/moderationService'
import type { ModerationStatus }     from '@/lib/admin/moderation'

// Event title lives at eventDetails.info.name.
function eventTitle(d: Record<string, unknown>): string {
  const ed   = d.eventDetails as Record<string, unknown> | undefined
  const info = ed?.info as Record<string, unknown> | undefined
  const name = info?.name
  return typeof name === 'string' && name.trim() ? name.trim() : '(untitled event)'
}

function parseStatus(s: string | null): ModerationStatus | null {
  return s === 'active' || s === 'under_review' || s === 'taken_down' ? s : null
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { searchParams } = req.nextUrl
  const result = await listModerationItems('events', eventTitle, {
    pageSize:     Math.min(100, Math.max(1, parseInt(searchParams.get('pageSize') ?? '25', 10))),
    cursor:       searchParams.get('cursor') ?? '',
    search:       (searchParams.get('search') ?? '').trim().toLowerCase(),
    status:       parseStatus(searchParams.get('status')),
    organizerUid: (searchParams.get('organizerUid') ?? '').trim(),
  })

  return NextResponse.json(result)
}
