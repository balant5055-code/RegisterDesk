// GET /api/admin/platform-monitor/security — audit-derived security health.
// Admin-gated, lazy. Reuses getPlatformSecurity (adminAuditLogs). Read-only.

import { NextRequest, NextResponse } from 'next/server'
import { resolveAdminUid, resolveSuperAdminUid } from '@/lib/admin/auth'
import { getPlatformSecurity }          from '@/lib/admin/platformMonitorService'
import type { PlatformSecurityResponse } from '@/lib/admin/platformMonitorTypes'

export async function GET(req: NextRequest): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  try {
    // RD-PHASE4-S4 · D7 — financial audit rows are returned to a Super Admin only.
    const security = await getPlatformSecurity({ includeFinancial: (await resolveSuperAdminUid(req.headers.get('authorization'))) !== null })
    return NextResponse.json({ security } satisfies PlatformSecurityResponse, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    console.error('[admin/platform-monitor/security] failed', e)
    return NextResponse.json({ error: 'Failed to load security' }, { status: 500 })
  }
}
