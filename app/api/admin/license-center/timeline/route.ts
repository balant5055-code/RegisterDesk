// GET /api/admin/license-center/timeline — merged license/coupon/billing trail.
// Admin-gated. Reuses getLicenseCenterTimeline (adminAuditLogs + licenseHistory).

import { NextRequest, NextResponse } from 'next/server'
import { resolveAdminUid }             from '@/lib/admin/auth'
import { getLicenseCenterTimeline }    from '@/lib/admin/licenseCenterService'
import type { LicenseCenterTimelineResponse } from '@/lib/admin/licenseCenterTypes'

export async function GET(req: NextRequest): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  try {
    const entries = await getLicenseCenterTimeline()
    return NextResponse.json({ entries } satisfies LicenseCenterTimelineResponse, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    console.error('[admin/license-center/timeline] failed', e)
    return NextResponse.json({ error: 'Failed to load timeline' }, { status: 500 })
  }
}
