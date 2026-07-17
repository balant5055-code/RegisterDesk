// GET /api/admin/communications — platform-wide communications analytics
// (admin-only). Aggregation-based; see lib/analytics/adminCommunications.

import { NextRequest, NextResponse } from 'next/server'
import { resolveAdminUid } from '@/lib/admin/auth'
import { getAdminCommunications } from '@/lib/analytics/adminCommunications'

export async function GET(req: NextRequest): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  try {
    const data = await getAdminCommunications()
    return NextResponse.json({ data }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    console.error('[admin/communications] failed', e)
    return NextResponse.json({ error: 'Failed to load' }, { status: 500 })
  }
}
