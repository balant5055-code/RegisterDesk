// GET /api/organizer/whatsapp-inbox/conversations/[conversationId] — one conversation and a
// page of its messages (Phase 1b). `?before=<messageId>` loads older messages.
//
// Another organizer's conversation answers 404, identical to a missing one, so ids cannot be
// probed. Reading does NOT mark the conversation read — that is an explicit POST .../read.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeInbox } from '@/lib/whatsapp-inbox/authz'
import { getConversation } from '@/lib/whatsapp-inbox/read'
import type { ConversationDetailResponse } from '@/lib/whatsapp-inbox/types'

export const dynamic = 'force-dynamic'

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ conversationId: string }> },
): Promise<NextResponse<ConversationDetailResponse>> {
  const gate = await authorizeInbox(req)
  if (!gate.ok) return gate.response as NextResponse<ConversationDetailResponse>

  const { conversationId } = await params
  try {
    const before = (req.nextUrl.searchParams.get('before') ?? '').slice(0, 200) || undefined
    const r = await getConversation(gate.authz.workspaceUid, conversationId, before)
    if (r.status === 'not_found') {
      return NextResponse.json({ success: false, error: 'Conversation not found.' }, { status: 404 })
    }
    return NextResponse.json({ success: true, conversation: r.conversation, messages: r.messages, olderCursor: r.olderCursor })
  } catch (err) {
    console.error('[whatsapp-inbox] detail failed:', (err as Error)?.message)
    return NextResponse.json({ success: false, error: 'Could not load this conversation.' }, { status: 500 })
  }
}
