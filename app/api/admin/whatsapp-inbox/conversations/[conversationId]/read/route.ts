// POST /api/admin/whatsapp-inbox/conversations/[conversationId]/read — mark read for the
// SUPER ADMIN (Phase 1c). Clears only the admin's read state; the organizer's unread state is
// never touched, so an admin looking at a conversation cannot hide it from its organizer.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeSuperAdminInbox } from '@/lib/whatsapp-inbox/adminAuthz'
import { markAdminConversationRead } from '@/lib/whatsapp-inbox/adminRead'

export const dynamic = 'force-dynamic'
const NO_STORE = { 'Cache-Control': 'no-store' }

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ conversationId: string }> },
): Promise<NextResponse<{ success: boolean; error?: string }>> {
  const gate = await authorizeSuperAdminInbox(req)
  if (!gate.ok) return gate.response as NextResponse<{ success: boolean; error?: string }>

  const { conversationId } = await params
  try {
    const r = await markAdminConversationRead(conversationId, gate.adminUid)
    if (r === 'not_found') return NextResponse.json({ success: false, error: 'Conversation not found.' }, { status: 404, headers: NO_STORE })
    return NextResponse.json({ success: true }, { headers: NO_STORE })
  } catch (err) {
    console.error('[admin/whatsapp-inbox] mark-read failed:', (err as Error)?.message)
    return NextResponse.json({ success: false, error: 'Could not update this conversation.' }, { status: 500, headers: NO_STORE })
  }
}
