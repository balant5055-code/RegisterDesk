// POST /api/organizer/events/[eventId]/status
//
// Drives all organizer-initiated lifecycle transitions except draft→published
// (which is handled by /api/events/publish).
//
// Body: { action: LifecycleAction, cancelReason?: string }

import { NextRequest, NextResponse }  from 'next/server'
import { authorizeWorkspace }         from '@/lib/team/workspace'
import { applyLifecycleTransition }   from '@/lib/events/lifecycle'
import type { LifecycleAction, StatusChangeResponse } from '@/types/events'

const VALID_ACTIONS = new Set<LifecycleAction>([
  'close_registrations',
  'reopen_registrations',
  'complete',
  'cancel',
  'archive',
  'unpublish',
])

export async function POST(
  req:     NextRequest,
  context: { params: Promise<{ eventId: string }> },
): Promise<NextResponse<StatusChangeResponse>> {
  const { eventId } = await context.params

  // ── 1. Auth ────────────────────────────────────────────────────────────────
  const authz = await authorizeWorkspace(req, 'events')
  if (!authz.ok) return NextResponse.json({ success: false, error: authz.error }, { status: authz.status })
  const uid = authz.workspaceUid

  // ── 2. Parse body ──────────────────────────────────────────────────────────
  let body: Record<string, unknown>
  try { body = await req.json() } catch { body = {} }

  const action       = body.action as LifecycleAction | undefined
  const cancelReason = typeof body.cancelReason === 'string' ? body.cancelReason : undefined

  if (!action || !VALID_ACTIONS.has(action)) {
    return NextResponse.json({ success: false, error: 'Invalid action' }, { status: 400 })
  }

  // ── 3. Delegate to shared transition logic ─────────────────────────────────
  const result = await applyLifecycleTransition(uid, eventId, action, cancelReason, undefined, authz.callerUid)

  return NextResponse.json(
    { success: result.success, lifecycleStatus: result.lifecycleStatus, error: result.error },
    { status: result.statusCode },
  )
}
