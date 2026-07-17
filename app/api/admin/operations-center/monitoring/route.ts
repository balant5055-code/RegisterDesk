// GET /api/admin/operations-center/monitoring — per-engine success/failure/duration.
// Admin-gated, lazy. Reuses getOpsMonitoring (bounded recent samples per engine).

import { NextRequest, NextResponse } from 'next/server'
import { resolveAdminUid }              from '@/lib/admin/auth'
import { getOpsMonitoring }             from '@/lib/admin/operationsCenterService'
import type { OpsMonitoringResponse }   from '@/lib/admin/operationsCenterTypes'

export async function GET(req: NextRequest): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  try {
    const monitoring = await getOpsMonitoring()
    return NextResponse.json({ monitoring } satisfies OpsMonitoringResponse, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    console.error('[admin/operations-center/monitoring] failed', e)
    return NextResponse.json({ error: 'Failed to load monitoring' }, { status: 500 })
  }
}
