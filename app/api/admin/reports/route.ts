// GET /api/admin/reports
//
// Admin-only, cursor-paginated abuse-report queue.
//
// Query params:
//   pageSize   — results per page (default 25, max 100)
//   cursor     — last report id from the previous page (createdAt-desc cursor)
//   status     — 'open' | 'reviewing' | 'actioned' | 'dismissed'
//   targetType — 'event' | 'campaign' | 'organizer'
//   search     — substring over reason / targetId / details (in-memory)

import { NextRequest, NextResponse } from 'next/server'
import { resolveAdminUid }           from '@/lib/admin/auth'
import { listReports }               from '@/lib/admin/reportService'
import type { ReportStatus, ReportTargetType } from '@/lib/admin/reportTypes'

function parseStatus(s: string | null): ReportStatus | null {
  return s === 'open' || s === 'reviewing' || s === 'actioned' || s === 'dismissed' ? s : null
}
function parseTargetType(s: string | null): ReportTargetType | null {
  return s === 'event' || s === 'campaign' || s === 'organizer' ? s : null
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { searchParams } = req.nextUrl
  const result = await listReports({
    pageSize:   Math.min(100, Math.max(1, parseInt(searchParams.get('pageSize') ?? '25', 10))),
    cursor:     searchParams.get('cursor') ?? '',
    search:     (searchParams.get('search') ?? '').trim().toLowerCase(),
    status:     parseStatus(searchParams.get('status')),
    targetType: parseTargetType(searchParams.get('targetType')),
  })

  return NextResponse.json(result)
}
