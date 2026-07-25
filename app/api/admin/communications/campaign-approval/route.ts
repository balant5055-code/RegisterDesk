// GET /admin/communications/campaign-approval — the canonical Campaign Approval Workflow
// (admin-only, READ-ONLY). Returns a campaign's current lifecycle state, the ALLOWED next
// actions (from the one state machine), a history projection, and validation. No transition is
// performed, and nothing is executed, scheduled, sent, or persisted.
// RD-PLATFORM-COMMS-02 Phase 5D.

import { NextRequest, NextResponse } from 'next/server'
import { resolveAdminUid } from '@/lib/admin/auth'
import { resolveCampaignApproval } from '@/lib/communications/approval/resolve'

export async function GET(req: NextRequest): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  try {
    const campaignId = req.nextUrl.searchParams.get('campaignId') ?? ''
    if (!campaignId) return NextResponse.json({ error: 'campaignId is required' }, { status: 400 })
    const data = await resolveCampaignApproval(campaignId)
    return NextResponse.json({ data }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    console.error('[admin/communications/campaign-approval] failed', e)
    return NextResponse.json({ error: 'Failed to load' }, { status: 500 })
  }
}
