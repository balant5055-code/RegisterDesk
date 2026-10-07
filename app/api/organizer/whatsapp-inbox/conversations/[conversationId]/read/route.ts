// POST /api/organizer/whatsapp-inbox/conversations/[conversationId]/read — mark a
// conversation read for the workspace (Phase 1b). Idempotent. Another organizer's
// conversation answers 404, identical to a missing one.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeInbox } from '@/lib/whatsapp-inbox/authz'
import { markConversationRead } from '@/lib/whatsapp-inbox/read'

export const dynamic = 'force-dynamic'

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ conversationId: string }> },
): Promise<NextResponse<{ success: boolean; error?: string }>> {
  const gate = await authorizeInbox(req)
  if (!gate.ok) return gate.response as NextResponse<{ success: boolean; error?: string }>

  const { conversationId } = await params
  try {
    const r = await markConversationRead(gate.authz.workspaceUid, conversationId, gate.authz.callerUid)
    if (r === 'not_found') return NextResponse.json({ success: false, error: 'Conversation not found.' }, { status: 404 })
    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('[whatsapp-inbox] mark-read failed:', (err as Error)?.message)
    return NextResponse.json({ success: false, error: 'Could not update this conversation.' }, { status: 500 })
  }
}
