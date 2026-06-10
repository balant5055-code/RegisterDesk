// POST /api/organizer/events/[eventId]/status
//
// Drives all organizer-initiated lifecycle transitions except draft→published
// (which is handled by /api/events/publish).
//
// Body: { action: LifecycleAction, cancelReason?: string }

import { NextRequest, NextResponse }  from 'next/server'
import { adminAuth }                  from '@/lib/firebase/admin'
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
  const token = (req.headers.get('authorization') ?? '').replace('Bearer ', '')
  if (!token) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  let uid: string
  try {
    uid = (await adminAuth.verifyIdToken(token)).uid
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid token' }, { status: 401 })
  }

  // ── 2. Parse body ──────────────────────────────────────────────────────────
  let body: Record<string, unknown>
  try { body = await req.json() } catch { body = {} }

  const action       = body.action as LifecycleAction | undefined
  const cancelReason = typeof body.cancelReason === 'string' ? body.cancelReason : undefined

  if (!action || !VALID_ACTIONS.has(action)) {
    return NextResponse.json({ success: false, error: 'Invalid action' }, { status: 400 })
  }

  // ── 3. Delegate to shared transition logic ─────────────────────────────────
  const result = await applyLifecycleTransition(uid, eventId, action, cancelReason)

  return NextResponse.json(
    { success: result.success, lifecycleStatus: result.lifecycleStatus, error: result.error },
    { status: result.statusCode },
  )
}
