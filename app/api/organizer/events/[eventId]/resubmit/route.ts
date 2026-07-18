// POST /api/organizer/events/[eventId]/resubmit
//
// Resubmit a previously-submitted event for review after edits. Applies to events
// that were REJECTED (returned to draft) or had CHANGES REQUESTED. Because the
// event doc + license already exist from the first submission, resubmit is a
// LIFECYCLE TRANSITION (→ pending_review) — it does NOT re-run the publish
// transaction (which would fail on the existing license).

import { NextRequest, NextResponse, after } from 'next/server'
import { adminDb }              from '@/lib/firebase/admin'
import { authorizeWorkspace }   from '@/lib/team/workspace'
import { applyLifecycleTransition, deriveLifecycleStatus } from '@/lib/events/lifecycle'
import { sendEventReviewEmail } from '@/lib/events/reviewNotifications'

type Ctx = { params: Promise<{ eventId: string }> }

export async function POST(req: NextRequest, { params }: Ctx): Promise<NextResponse> {
  const authz = await authorizeWorkspace(req, 'events')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  const uid = authz.workspaceUid

  const { eventId } = await params

  const draftRef  = adminDb.doc(`users/${uid}/eventDrafts/${eventId}`)
  const draftSnap = await draftRef.get()
  if (!draftSnap.exists) return NextResponse.json({ error: 'Event not found' }, { status: 404 })
  const d = draftSnap.data() as Record<string, unknown>

  const ls = deriveLifecycleStatus(d)
  const reviewStatus = d.reviewStatus

  // Only a rejected draft or a changes_requested event may be resubmitted, and it
  // must have been submitted before (an events/{slug} doc + license exist).
  const eligible = ls === 'changes_requested' || (ls === 'draft' && reviewStatus === 'rejected')
  if (!eligible) {
    return NextResponse.json(
      { error: 'This event cannot be resubmitted. Only rejected or changes-requested events can be resubmitted.' },
      { status: 409 },
    )
  }

  const seo  = (d.eventDetails as Record<string, unknown> | undefined)?.seo as Record<string, unknown> | undefined
  const slug = typeof seo?.urlSlug === 'string' && seo.urlSlug ? seo.urlSlug : null
  if (!slug) return NextResponse.json({ error: 'Event has not been submitted before' }, { status: 400 })
  const eventSnap = await adminDb.collection('events').doc(slug).get()
  if (!eventSnap.exists) return NextResponse.json({ error: 'Event has not been submitted before' }, { status: 400 })

  const result = await applyLifecycleTransition(uid, eventId, 'resubmit')
  if (!result.success) {
    return NextResponse.json({ success: false, error: result.error }, { status: result.statusCode })
  }

  const info      = (d.eventDetails as Record<string, unknown> | undefined)?.info as Record<string, unknown> | undefined
  const eventName = typeof info?.name === 'string' ? info.name : 'Your event'
  // Schedule via after() (not a dangling void) so the email + organizer WhatsApp
  // complete after the response instead of being cut off when the route returns —
  // matches the publish/review sites (reviewNotifications header requirement).
  after(() => sendEventReviewEmail({ organizerUid: uid, eventName, kind: 'resubmitted', eventId }))

  return NextResponse.json(
    { success: true, lifecycleStatus: result.lifecycleStatus },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
