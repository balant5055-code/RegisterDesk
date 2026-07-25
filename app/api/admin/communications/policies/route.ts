// GET /api/admin/communications/policies — the canonical Notification Policy Center
// (admin-only, READ-ONLY). Returns the resolved policy for every notification: priority,
// mandatory, delivery mode, retry, expiry, visibility, escalation, channel support, and
// future-readiness flags. No mutations. RD-PLATFORM-COMMS-01 Phase 4D.

import { NextRequest, NextResponse } from 'next/server'
import { resolveAdminUid } from '@/lib/admin/auth'
import { resolveAllNotificationPolicies } from '@/lib/communications/policy/server'

export async function GET(req: NextRequest): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  try {
    const data = await resolveAllNotificationPolicies()
    return NextResponse.json({ data }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    console.error('[admin/communications/policies] failed', e)
    return NextResponse.json({ error: 'Failed to load' }, { status: 500 })
  }
}
