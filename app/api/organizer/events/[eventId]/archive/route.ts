// POST /api/organizer/events/[eventId]/archive
//
// Thin wrapper — delegates to applyLifecycleTransition with action='archive'.
// No body required.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeWorkspace }        from '@/lib/team/workspace'
import { applyLifecycleTransition }  from '@/lib/events/lifecycle'
import type { StatusChangeResponse } from '@/types/events'

export async function POST(
  req:     NextRequest,
  context: { params: Promise<{ eventId: string }> },
): Promise<NextResponse<StatusChangeResponse>> {
  const { eventId } = await context.params

  const authz = await authorizeWorkspace(req, 'events')
  if (!authz.ok) return NextResponse.json({ success: false, error: authz.error }, { status: authz.status })
  const uid = authz.workspaceUid

  const result = await applyLifecycleTransition(uid, eventId, 'archive', undefined, undefined, authz.callerUid)

  return NextResponse.json(
    { success: result.success, lifecycleStatus: result.lifecycleStatus, error: result.error },
    { status: result.statusCode },
  )
}
