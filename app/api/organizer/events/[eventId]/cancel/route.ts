// POST /api/organizer/events/[eventId]/cancel
//
// Thin wrapper — delegates to applyLifecycleTransition with action='cancel'.
// Body: { cancelReason: string }

import { NextRequest, NextResponse } from 'next/server'
import { adminAuth }                 from '@/lib/firebase/admin'
import { applyLifecycleTransition }  from '@/lib/events/lifecycle'
import type { StatusChangeResponse } from '@/types/events'

export async function POST(
  req:     NextRequest,
  context: { params: Promise<{ eventId: string }> },
): Promise<NextResponse<StatusChangeResponse>> {
  const { eventId } = await context.params

  const token = (req.headers.get('authorization') ?? '').replace('Bearer ', '')
  if (!token) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  let uid: string
  try {
    uid = (await adminAuth.verifyIdToken(token)).uid
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid token' }, { status: 401 })
  }

  let body: Record<string, unknown>
  try { body = await req.json() } catch { body = {} }

  const cancelReason = typeof body.cancelReason === 'string' ? body.cancelReason : undefined

  const result = await applyLifecycleTransition(uid, eventId, 'cancel', cancelReason)

  return NextResponse.json(
    { success: result.success, lifecycleStatus: result.lifecycleStatus, error: result.error },
    { status: result.statusCode },
  )
}
