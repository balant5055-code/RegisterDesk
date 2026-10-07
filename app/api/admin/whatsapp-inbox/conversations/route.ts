// GET /api/admin/whatsapp-inbox/conversations — Super Admin Inbox list, across organizers
// (Phase 1c). Query: organizerUid, eventId, unread=1 (the ADMIN's unread), q, cursor.
// Super Admin only (resolveSuperAdminUid) — see lib/whatsapp-inbox/adminAuthz.ts.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeSuperAdminInbox } from '@/lib/whatsapp-inbox/adminAuthz'
import { listAdminConversations } from '@/lib/whatsapp-inbox/adminRead'
import type { AdminConversationListResponse } from '@/lib/whatsapp-inbox/types'

export const dynamic = 'force-dynamic'
const NO_STORE = { 'Cache-Control': 'no-store' }

export async function GET(req: NextRequest): Promise<NextResponse<AdminConversationListResponse>> {
  const gate = await authorizeSuperAdminInbox(req)
  if (!gate.ok) return gate.response as NextResponse<AdminConversationListResponse>

  const p = req.nextUrl.searchParams
  const take = (k: string, max: number) => (p.get(k) ?? '').slice(0, max) || undefined
  try {
    const r = await listAdminConversations({
      organizerUid: take('organizerUid', 200),
      eventId:      take('eventId', 200),
      unread:       p.get('unread') === '1',
      q:            take('q', 100),
      cursor:       take('cursor', 400),
    })
    return NextResponse.json({ success: true, items: r.items, nextCursor: r.nextCursor, truncated: r.truncated }, { headers: NO_STORE })
  } catch (err) {
    console.error('[admin/whatsapp-inbox] list failed:', (err as Error)?.message)
    return NextResponse.json({ success: false, error: 'Could not load conversations.' }, { status: 500, headers: NO_STORE })
  }
}
