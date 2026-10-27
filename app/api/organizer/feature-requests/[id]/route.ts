// RD-FEATURE-REQ-01 — one of this workspace's feature requests, with its status history.
// A request owned by another workspace reads as 404 — existence is never confirmed across workspaces.
// The view is the organizer whitelist (toOrganizerView): no internal notes, rollout targets or admin ids.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeWorkspace } from '@/lib/team/workspace'
import { getWorkspaceRequest } from '@/lib/featureRequests/service'

type Ctx = { params: Promise<{ id: string }> }

export async function GET(req: NextRequest, { params }: Ctx): Promise<NextResponse> {
  const authz = await authorizeWorkspace(req, 'events')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  const { id } = await params
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const request = await getWorkspaceRequest(authz.workspaceUid, id)
  if (!request) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json({ request }, { headers: { 'Cache-Control': 'no-store' } })
}
