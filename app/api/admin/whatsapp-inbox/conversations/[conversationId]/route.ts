// GET /api/admin/whatsapp-inbox/conversations/[conversationId] — any organizer's
// conversation and a page of messages, for the Super Admin (Phase 1c). `?before=<messageId>`
// loads older messages. Reading does NOT mark anything read (admin or organizer).

import { NextRequest, NextResponse } from 'next/server'
import { authorizeSuperAdminInbox } from '@/lib/whatsapp-inbox/adminAuthz'
import { getAdminConversation } from '@/lib/whatsapp-inbox/adminRead'
import { auditInboxAccess } from '@/lib/whatsapp-inbox/adminAudit'
import type { AdminConversationDetailResponse } from '@/lib/whatsapp-inbox/types'

export const dynamic = 'force-dynamic'
const NO_STORE = { 'Cache-Control': 'no-store' }

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ conversationId: string }> },
): Promise<NextResponse<AdminConversationDetailResponse>> {
  const gate = await authorizeSuperAdminInbox(req)
  if (!gate.ok) return gate.response as NextResponse<AdminConversationDetailResponse>

  const { conversationId } = await params
  try {
    const before = (req.nextUrl.searchParams.get('before') ?? '').slice(0, 200) || undefined
    const r = await getAdminConversation(conversationId, before)
    if (r.status === 'not_found') {
      return NextResponse.json({ success: false, error: 'Conversation not found.' }, { status: 404, headers: NO_STORE })
    }
    // Super Admin access to an attendee conversation is audited (once per admin + hour; ids only).
    await auditInboxAccess({
      adminUid: gate.adminUid, action: 'whatsapp_inbox.conversation_viewed', entityType: 'whatsapp_conversation',
      entityId: conversationId, metadata: { organizerUid: r.conversation.organizerUid, eventId: r.conversation.eventId },
    })
    return NextResponse.json({ success: true, conversation: r.conversation, messages: r.messages, olderCursor: r.olderCursor }, { headers: NO_STORE })
  } catch (err) {
    console.error('[admin/whatsapp-inbox] detail failed:', (err as Error)?.message)
    return NextResponse.json({ success: false, error: 'Could not load this conversation.' }, { status: 500, headers: NO_STORE })
  }
}
