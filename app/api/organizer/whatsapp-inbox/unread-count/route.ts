// GET /api/organizer/whatsapp-inbox/unread-count — conversations with unread messages, for
// the sidebar badge (Phase 1b). One count() aggregate; no documents are read.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeInbox } from '@/lib/whatsapp-inbox/authz'
import { countUnreadConversations } from '@/lib/whatsapp-inbox/read'
import type { UnreadCountResponse } from '@/lib/whatsapp-inbox/types'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest): Promise<NextResponse<UnreadCountResponse>> {
  const gate = await authorizeInbox(req)
  if (!gate.ok) return gate.response as NextResponse<UnreadCountResponse>
  try {
    return NextResponse.json({ success: true, count: await countUnreadConversations(gate.authz.workspaceUid) })
  } catch (err) {
    console.error('[whatsapp-inbox] unread-count failed:', (err as Error)?.message)
    return NextResponse.json({ success: false, error: 'Could not load the unread count.' }, { status: 500 })
  }
}
