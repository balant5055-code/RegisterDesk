// GET /api/organizer/communications/opt-outs — this workspace's recipient opt-outs. READ-ONLY.
//
// RD-COMMS-P2-G — the organizer sees ONLY their own organizer-scope records: who unsubscribed from
// their announcement/reminder emails, and addresses that bounced for them. Platform-wide
// suppression (another sender's bounce or complaint) is never listed — it shows only as the
// "not accepting email" reason on a skipped message. There is no write here: an opt-out is the
// recipient's to make and to lift (via their link), and nothing here can override one.
// Gated like the rest of Communications ('broadcasts' — owner and admins); scoped by the
// SERVER-resolved workspace, never by a client-supplied organizer id.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeWorkspace } from '@/lib/team/workspace'
import { listOrganizerOptOuts } from '@/lib/firebase/firestore/emailSuppressionList'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest): Promise<NextResponse> {
  const ctx = await authorizeWorkspace(req, 'broadcasts')
  if (!ctx.ok) return NextResponse.json({ error: ctx.error }, { status: ctx.status })
  try {
    const { rows, truncated } = await listOrganizerOptOuts(ctx.workspaceUid)
    return NextResponse.json({ optOuts: rows, truncated }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    console.error('[organizer/communications/opt-outs] failed', e)
    return NextResponse.json({ error: 'Failed to load opt-outs' }, { status: 500 })
  }
}
