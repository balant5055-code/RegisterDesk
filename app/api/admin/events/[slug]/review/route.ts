// POST /api/admin/events/[slug]/review — approve / reject / request changes.
// Body:
//   { action: 'approve' }
//   { action: 'reject', reason, category?, notes? }
//   { action: 'request_changes', comment }
//
// Reuses the shared event lifecycle transition (the SAME logic organizer status
// actions use) rather than reimplementing event creation:
//   approve         → pending_review → published
//   reject          → pending_review → draft (with reason)
//   request_changes → pending_review → changes_requested (with comment)
//
// Only a 'pending_review' event may be reviewed — this guards against duplicate
// approvals, double publishes, and approval after archive/cancel/publish.

import { NextRequest, NextResponse, after } from 'next/server'
import { adminDb }              from '@/lib/firebase/admin'
import { resolveAdminUid }      from '@/lib/admin/auth'
import { applyLifecycleTransition } from '@/lib/events/lifecycle'
import { ensureCounterExists }  from '@/lib/firebase/firestore/registrationCounters'
import { sendEventReviewEmail } from '@/lib/events/reviewNotifications'
import type { EventReviewMeta } from '@/types/events'

type Ctx = { params: Promise<{ slug: string }> }

function eventNameOf(raw: Record<string, unknown>): string {
  const ed   = (raw.eventDetails as Record<string, unknown> | null) ?? {}
  const info = (ed.info as Record<string, unknown> | null) ?? {}
  return typeof info.name === 'string' && info.name.trim() ? info.name.trim() : 'Your event'
}

export async function POST(req: NextRequest, { params }: Ctx): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { slug } = await params

  let body: { action?: unknown; reason?: unknown; category?: unknown; notes?: unknown; comment?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const action = body.action
  if (action !== 'approve' && action !== 'reject' && action !== 'request_changes') {
    return NextResponse.json({ error: "action must be 'approve', 'reject' or 'request_changes'" }, { status: 400 })
  }

  // Per-action input validation.
  let review: EventReviewMeta | undefined
  if (action === 'reject') {
    const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
    if (reason.length < 3) {
      return NextResponse.json({ error: 'A rejection reason is required (min 3 characters)' }, { status: 400 })
    }
    review = {
      rejectionReason:   reason,
      rejectionCategory: typeof body.category === 'string' ? body.category.trim() : '',
      rejectionNotes:    typeof body.notes === 'string' ? body.notes.trim() : '',
    }
  }
  if (action === 'request_changes') {
    const comment = typeof body.comment === 'string' ? body.comment.trim() : ''
    if (comment.length < 3) {
      return NextResponse.json({ error: 'A comment describing the requested changes is required (min 3 characters)' }, { status: 400 })
    }
    review = { changesComment: comment }
  }

  const eventSnap = await adminDb.collection('events').doc(slug).get()
  if (!eventSnap.exists) return NextResponse.json({ error: 'Event not found' }, { status: 404 })
  const ev = eventSnap.data() as Record<string, unknown>
  const lifecycleStatus = ev.lifecycleStatus as string | undefined
  const uid     = typeof ev.uid === 'string' ? ev.uid : ''
  const draftId = typeof ev.draftId === 'string' ? ev.draftId : ''

  // Only pending events can be reviewed — blocks duplicate approvals + approval
  // after archive/cancel/publish.
  if (lifecycleStatus !== 'pending_review') {
    return NextResponse.json(
      { error: `Event is '${lifecycleStatus ?? 'unknown'}', not pending review` },
      { status: 409 },
    )
  }
  if (!uid || !draftId) {
    return NextResponse.json({ error: 'Event is missing owner/draft references' }, { status: 500 })
  }

  // Reuse the shared lifecycle transition.
  const result = await applyLifecycleTransition(uid, draftId, action, undefined, review)
  if (!result.success) {
    return NextResponse.json({ success: false, error: result.error }, { status: result.statusCode })
  }

  // Side-effects (best-effort; never block the response).
  const eventName = eventNameOf(ev)
  // Scheduled via after() so email + WhatsApp complete after the response without
  // being cut off by serverless termination (LS1 fix).
  if (action === 'approve') {
    try { await ensureCounterExists(slug) } catch { /* idempotent */ }
    after(() => sendEventReviewEmail({ organizerUid: uid, eventName, kind: 'approved', eventId: draftId }))
  } else if (action === 'reject') {
    after(() => sendEventReviewEmail({ organizerUid: uid, eventName, kind: 'rejected', reason: review?.rejectionReason, eventId: draftId }))
  } else {
    after(() => sendEventReviewEmail({ organizerUid: uid, eventName, kind: 'changes_requested', comment: review?.changesComment, eventId: draftId }))
  }

  return NextResponse.json(
    { success: true, lifecycleStatus: result.lifecycleStatus },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
