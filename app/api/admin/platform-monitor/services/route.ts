// GET /api/admin/platform-monitor/services — per-service health.
// Admin-gated, lazy. Reuses getPlatformServices (analytics + communications +
// per-engine job rollups). Services with no data are reported as Unavailable.

import { NextRequest, NextResponse } from 'next/server'
import { resolveAdminUid }              from '@/lib/admin/auth'
import { getPlatformServices }          from '@/lib/admin/platformMonitorService'
import type { PlatformServicesResponse } from '@/lib/admin/platformMonitorTypes'

export async function GET(req: NextRequest): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  try {
    const services = await getPlatformServices()
    return NextResponse.json({ services } satisfies PlatformServicesResponse, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    console.error('[admin/platform-monitor/services] failed', e)
    return NextResponse.json({ error: 'Failed to load services' }, { status: 500 })
  }
}
