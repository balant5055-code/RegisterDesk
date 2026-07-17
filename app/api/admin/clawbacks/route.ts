// GET /api/admin/clawbacks?status=&organizer=&startDate=&endDate=
//
// Lists wallet clawbacks (insolvent reversal debts) for the finance team.
// Admin-only.

import { NextRequest, NextResponse } from 'next/server'
import { resolveAdminUid }           from '@/lib/admin/auth'
import { listClawbacks }             from '@/lib/clawbacks/clawbackService'
import type { ClawbackStatus, ClawbackView } from '@/lib/clawbacks/types'

const STATUSES: ClawbackStatus[] = ['open', 'partially_recovered', 'recovered', 'waived']

export interface ClawbacksListResponse { clawbacks: ClawbackView[] }

export async function GET(req: NextRequest): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const sp     = req.nextUrl.searchParams
  const status = sp.get('status') ?? ''
  const clawbacks = await listClawbacks({
    status:       STATUSES.includes(status as ClawbackStatus) ? status as ClawbackStatus : undefined,
    organizerUid: sp.get('organizer')?.trim() || undefined,
    startDate:    sp.get('startDate') ? `${sp.get('startDate')}T00:00:00.000Z` : undefined,
    endDate:      sp.get('endDate')   ? `${sp.get('endDate')}T23:59:59.999Z`   : undefined,
    limit:        parseInt(sp.get('limit') ?? '', 10) || 100,
  })
  return NextResponse.json({ clawbacks } satisfies ClawbacksListResponse, { headers: { 'Cache-Control': 'no-store' } })
}
