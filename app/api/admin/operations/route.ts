// GET /api/admin/operations — operational health snapshot + system alerts.
// Admin-only. Read-only aggregation; modifies no business state.

import { NextRequest, NextResponse } from 'next/server'
import { resolveAdminUid } from '@/lib/admin/auth'
import { getOperationsHealth, evaluateAlerts } from '@/lib/operations/healthMetrics'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(req: NextRequest): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  try {
    const health = await getOperationsHealth()
    const alerts = evaluateAlerts(health)
    return NextResponse.json({ health, alerts }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    console.error('[admin/operations] failed:', err)
    return NextResponse.json({ error: 'Could not load operations health.' }, { status: 500 })
  }
}
