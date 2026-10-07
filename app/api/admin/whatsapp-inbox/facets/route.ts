// GET /api/admin/whatsapp-inbox/facets — organizer and event filter options for the Super
// Admin Inbox (Phase 1c), drawn from the most recent conversations (bounded scan).

import { NextRequest, NextResponse } from 'next/server'
import { authorizeSuperAdminInbox } from '@/lib/whatsapp-inbox/adminAuthz'
import { adminInboxFacets } from '@/lib/whatsapp-inbox/adminRead'
import type { AdminInboxFacets } from '@/lib/whatsapp-inbox/types'

export const dynamic = 'force-dynamic'
const NO_STORE = { 'Cache-Control': 'no-store' }

export async function GET(req: NextRequest): Promise<NextResponse<AdminInboxFacets>> {
  const gate = await authorizeSuperAdminInbox(req)
  if (!gate.ok) return gate.response as NextResponse<AdminInboxFacets>
  try {
    return NextResponse.json({ success: true, ...(await adminInboxFacets()) }, { headers: NO_STORE })
  } catch (err) {
    console.error('[admin/whatsapp-inbox] facets failed:', (err as Error)?.message)
    return NextResponse.json({ success: false, error: 'Could not load filters.' }, { status: 500, headers: NO_STORE })
  }
}
