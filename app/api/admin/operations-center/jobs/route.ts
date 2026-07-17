// GET /api/admin/operations-center/jobs — recent jobs across every engine.
// Admin-gated, lazy. Query params: collection?, status?, search?, limit?.
// Reuses listOpsJobs (bounded per-collection reads over the shared Job shape).

import { NextRequest, NextResponse } from 'next/server'
import { resolveAdminUid }           from '@/lib/admin/auth'
import { listOpsJobs }               from '@/lib/admin/operationsCenterService'
import type { OpsJobsResponse }      from '@/lib/admin/operationsCenterTypes'

export async function GET(req: NextRequest): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const sp = req.nextUrl.searchParams
  try {
    const result = await listOpsJobs({
      collection: sp.get('collection') ?? undefined,
      status:     sp.get('status') ?? undefined,
      search:     sp.get('search') ?? undefined,
      limit:      sp.get('limit') ? parseInt(sp.get('limit') as string, 10) : undefined,
    })
    return NextResponse.json(result satisfies OpsJobsResponse, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    console.error('[admin/operations-center/jobs] failed', e)
    return NextResponse.json({ error: 'Failed to load jobs' }, { status: 500 })
  }
}
