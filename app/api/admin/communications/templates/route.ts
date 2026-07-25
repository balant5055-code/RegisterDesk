// GET /api/admin/communications/templates — the Platform Template Center (admin-only,
// READ-ONLY). Returns every RegisterDesk → Organizer template binding (per notification ×
// channel) with version, status, variables, and health, plus the canonical variable registry.
// No mutations. RD-PLATFORM-COMMS-01 Phase 4E.

import { NextRequest, NextResponse } from 'next/server'
import { resolveAdminUid } from '@/lib/admin/auth'
import { resolveTemplateCenter } from '@/lib/communications/templates/server'

export async function GET(req: NextRequest): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  try {
    const data = await resolveTemplateCenter()
    return NextResponse.json({ data }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    console.error('[admin/communications/templates] failed', e)
    return NextResponse.json({ error: 'Failed to load' }, { status: 500 })
  }
}
