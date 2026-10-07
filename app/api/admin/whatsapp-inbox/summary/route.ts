// GET /api/admin/whatsapp-inbox/summary — Super Admin counts for the Inbox tabs (Phase 1c):
// conversations unread by the admin, and messages waiting in the unmatched queue.
// Two count() aggregates; no documents are read.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeSuperAdminInbox } from '@/lib/whatsapp-inbox/adminAuthz'
import { adminInboxSummary } from '@/lib/whatsapp-inbox/adminRead'
import type { AdminInboxSummary } from '@/lib/whatsapp-inbox/types'

export const dynamic = 'force-dynamic'
const NO_STORE = { 'Cache-Control': 'no-store' }

export async function GET(req: NextRequest): Promise<NextResponse<AdminInboxSummary>> {
  const gate = await authorizeSuperAdminInbox(req)
  if (!gate.ok) return gate.response as NextResponse<AdminInboxSummary>
  try {
    return NextResponse.json({ success: true, ...(await adminInboxSummary()) }, { headers: NO_STORE })
  } catch (err) {
    console.error('[admin/whatsapp-inbox] summary failed:', (err as Error)?.message)
    return NextResponse.json({ success: false, error: 'Could not load the inbox summary.' }, { status: 500, headers: NO_STORE })
  }
}
