// GET /api/admin/communications/registry — the canonical Communication Registry
// (admin-only, READ-ONLY). Returns every RegisterDesk notification with its category,
// channels, priority, mandatory flag, enabled state, template key, and future-rule key.
// No mutations. RD-PLATFORM-COMMS-01 Phase 4C.

import { NextRequest, NextResponse } from 'next/server'
import { resolveAdminUid } from '@/lib/admin/auth'
import { resolveCommunicationRegistry } from '@/lib/communications/registry/resolve'

export async function GET(req: NextRequest): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  try {
    const data = await resolveCommunicationRegistry()
    return NextResponse.json({ data }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    console.error('[admin/communications/registry] failed', e)
    return NextResponse.json({ error: 'Failed to load' }, { status: 500 })
  }
}
