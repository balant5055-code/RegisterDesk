// POST /api/organizer/crm/backfill — rebuild this workspace's CRM from existing
// registrations/donations/refunds/certificates/broadcasts. Owner-only (it's a
// full recompute). Idempotent + re-runnable.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeCrm } from '@/lib/crm/access'
import { rebuildCrmForOrganizer } from '@/lib/crm/backfill'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function POST(req: NextRequest): Promise<NextResponse> {
  const authz = await authorizeCrm(req)
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  if (authz.role !== 'owner') return NextResponse.json({ error: 'Only the workspace owner can rebuild the CRM.' }, { status: 403 })

  try {
    const result = await rebuildCrmForOrganizer(authz.workspaceUid)
    return NextResponse.json({ success: true, ...result })
  } catch (err) {
    console.error('[crm/backfill] failed:', err)
    return NextResponse.json({ error: 'Backfill failed. It is safe to retry.' }, { status: 500 })
  }
}
