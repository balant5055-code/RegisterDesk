// GET /admin/communications/playground — the Communication Playground (admin-only, READ-ONLY).
// Resolves a QA session for one notification + channel by COMPOSING the canonical resolvers.
// Persists nothing, sends nothing, bypasses nothing. RD-PLATFORM-COMMS-01 Phase 4I.

import { NextRequest, NextResponse } from 'next/server'
import { resolveAdminUid } from '@/lib/admin/auth'
import { resolvePlaygroundSession } from '@/lib/communications/playground/resolve'
import type { TemplateChannel } from '@/lib/communications/templates/registry'

export async function GET(req: NextRequest): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  try {
    const q = req.nextUrl.searchParams
    const notificationId = q.get('notificationId') ?? ''
    const channel = (q.get('channel') as TemplateChannel | null) ?? 'email'
    if (!notificationId) return NextResponse.json({ error: 'notificationId is required' }, { status: 400 })
    const data = await resolvePlaygroundSession({ notificationId, channel })
    return NextResponse.json({ data }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    console.error('[admin/communications/playground] failed', e)
    return NextResponse.json({ error: 'Failed to load' }, { status: 500 })
  }
}
