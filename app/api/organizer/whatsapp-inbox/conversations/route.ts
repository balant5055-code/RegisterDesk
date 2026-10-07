// GET /api/organizer/whatsapp-inbox/conversations — WhatsApp Inbox list (Phase 1b).
//
// Query: eventId, unread=1, q (search), cursor. Owner + admin only (`broadcasts`), behind the
// `whatsappInbox` flag — see lib/whatsapp-inbox/authz.ts. The organizer is ALWAYS the
// authorized workspace; any organizerUid-like query parameter is ignored.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeInbox } from '@/lib/whatsapp-inbox/authz'
import { listConversations } from '@/lib/whatsapp-inbox/read'
import type { ConversationListResponse } from '@/lib/whatsapp-inbox/types'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest): Promise<NextResponse<ConversationListResponse>> {
  const gate = await authorizeInbox(req)
  if (!gate.ok) return gate.response as NextResponse<ConversationListResponse>

  const p = req.nextUrl.searchParams
  try {
    const r = await listConversations(gate.authz.workspaceUid, {
      eventId: (p.get('eventId') ?? '').slice(0, 200) || undefined,
      unread:  p.get('unread') === '1',
      q:       (p.get('q') ?? '').slice(0, 100) || undefined,
      cursor:  (p.get('cursor') ?? '').slice(0, 400) || undefined,
    })
    return NextResponse.json({ success: true, items: r.items, nextCursor: r.nextCursor, truncated: r.truncated })
  } catch (err) {
    console.error('[whatsapp-inbox] list failed:', (err as Error)?.message)
    return NextResponse.json({ success: false, error: 'Could not load conversations.' }, { status: 500 })
  }
}
