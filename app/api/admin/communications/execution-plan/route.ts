// GET /admin/communications/execution-plan — the canonical Campaign Execution Planner
// (admin-only, READ-ONLY). Produces a deterministic execution PLAN by composing the canonical
// resolvers. Makes NO provider calls; executes, schedules, queues, sends, and persists nothing.
// RD-PLATFORM-COMMS-02 Phase 5E.

import { NextRequest, NextResponse } from 'next/server'
import { resolveAdminUid } from '@/lib/admin/auth'
import { resolveExecutionPlan } from '@/lib/communications/planner/resolve'

export async function GET(req: NextRequest): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  try {
    const campaignId = req.nextUrl.searchParams.get('campaignId') ?? ''
    if (!campaignId) return NextResponse.json({ error: 'campaignId is required' }, { status: 400 })
    const data = await resolveExecutionPlan(campaignId)
    return NextResponse.json({ data }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    console.error('[admin/communications/execution-plan] failed', e)
    return NextResponse.json({ error: 'Failed to load' }, { status: 500 })
  }
}
