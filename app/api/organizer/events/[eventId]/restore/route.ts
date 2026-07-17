// POST /api/organizer/events/[eventId]/restore
//
// Restore an ARCHIVED event. It returns to the PRIVATE 'unpublished' state (never
// straight back to public/published). Re-launch is then the normal republish →
// admin review → published flow. This is a pure lifecycle transition — it reuses
// the existing paid Event License and NEVER calls Razorpay, creates a licenseOrder,
// creates an eventLicense, or touches the wallet. No body required.

import { NextRequest, NextResponse } from 'next/server'
import { adminDb }                   from '@/lib/firebase/admin'
import { authorizeWorkspace }        from '@/lib/team/workspace'
import { applyLifecycleTransition, deriveLifecycleStatus } from '@/lib/events/lifecycle'
import type { StatusChangeResponse } from '@/types/events'

export async function POST(
  req:     NextRequest,
  context: { params: Promise<{ eventId: string }> },
): Promise<NextResponse<StatusChangeResponse>> {
  const { eventId } = await context.params

  const authz = await authorizeWorkspace(req, 'events')
  if (!authz.ok) return NextResponse.json({ success: false, error: authz.error }, { status: authz.status })
  const uid = authz.workspaceUid

  // Restore applies ONLY to an archived event. (An explicit guard is needed because
  // 'published → unpublished' is also a valid transition, so the state machine alone
  // would let a non-archived event through and mislabel the audit as a restore.)
  const draftSnap = await adminDb.doc(`users/${uid}/eventDrafts/${eventId}`).get()
  if (!draftSnap.exists) return NextResponse.json({ success: false, error: 'Event not found' }, { status: 404 })
  if (deriveLifecycleStatus(draftSnap.data() as Record<string, unknown>) !== 'archived') {
    return NextResponse.json({ success: false, error: 'Only an archived event can be restored.' }, { status: 409 })
  }

  const result = await applyLifecycleTransition(uid, eventId, 'restore', undefined, undefined, authz.callerUid)

  return NextResponse.json(
    { success: result.success, lifecycleStatus: result.lifecycleStatus, error: result.error },
    { status: result.statusCode },
  )
}
