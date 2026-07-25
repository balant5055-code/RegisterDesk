// GET /api/admin/communications/health — Admin Communication Center read model
// (admin-only). Returns the canonical communication overview: provider health, channel
// states, health dimensions, recommendations, and platform message counts. READ-ONLY —
// composes canonical resolvers (RD-PLATFORM-COMMS-01 Phase 4B); sends/charges/mutates nothing.

import { NextRequest, NextResponse } from 'next/server'
import { resolveAdminUid } from '@/lib/admin/auth'
import { resolveAdminCommunicationOverview } from '@/lib/communications/health/adminOverview'

export async function GET(req: NextRequest): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  try {
    const data = await resolveAdminCommunicationOverview()
    return NextResponse.json({ data }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    console.error('[admin/communications/health] failed', e)
    return NextResponse.json({ error: 'Failed to load' }, { status: 500 })
  }
}
