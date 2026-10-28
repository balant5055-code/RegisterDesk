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
//
// RD-REVIEW-02 — every body also names `reviewCycleId`: the cycle the Super Admin reviewed (null for
// an event submitted before cycles existed). The transition compares it, and that the event is still
// pending review, INSIDE its transaction — a decision made on an older version (the organizer has
// since resubmitted) is refused with 409 REVIEW_CYCLE_STALE instead of publishing unreviewed content.
// The audit row is staged in the same transaction as the decision.

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

  let body: { action?: unknown; reason?: unknown; category?: unknown; notes?: unknown; comment?: unknown; reviewCycleId?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const action = body.action
  if (action !== 'approve' && action !== 'reject' && action !== 'request_changes') {
    return NextResponse.json({ error: "action must be 'approve', 'reject' or 'request_changes'" }, { status: 400 })
  }
  // RD-REVIEW-02 — the reviewed cycle is REQUIRED (an explicit null for a legacy event): a client
  // that does not send it cannot prove which version it reviewed.
  if (!body || !Object.prototype.hasOwnProperty.call(body, 'reviewCycleId')
      || !(body.reviewCycleId === null || (typeof body.reviewCycleId === 'string' && body.reviewCycleId.length > 0 && body.reviewCycleId.length <= 100))) {
    return NextResponse.json({ error: 'reviewCycleId is required (the review cycle you reviewed). Reload the review page.', code: 'REVIEW_CYCLE_REQUIRED' }, { status: 400 })
  }
  const expectedCycleId = body.reviewCycleId as string | null

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
  // adminUid is the actor: the review history and changesRequestedBy name the admin who decided.
  // Immutable admin audit trail, staged IN the decision's transaction (the decision and its audit
  // row commit together). The internal rejection note is never copied into the audit row.
  const auditAction = action === 'approve' ? 'event.approved'
    : action === 'reject' ? 'event.rejected' : 'event.changes_requested'
  const result = await applyLifecycleTransition(uid, draftId, action, undefined, review, adminUid, {
    expectedStatus: 'pending_review',
    expectedCycleId,
    audit: {
      adminUid, actorRole: 'super_admin', action: auditAction, entityType: 'event', entityId: slug,
      reason: review?.rejectionReason ?? review?.changesComment,
      before: { lifecycleStatus: 'pending_review' },
      after:  { lifecycleStatus: action === 'approve' ? 'published' : action === 'reject' ? 'draft' : 'changes_requested' },
      metadata: { organizerUid: uid, draftId, category: review?.rejectionCategory || null },
    },
  })
  if (!result.success) {
    return NextResponse.json({ success: false, error: result.error, code: result.code ?? null }, { status: result.statusCode })
  }

  // Side-effects (best-effort; never block the response).
  const eventName = eventNameOf(ev)
  // Scheduled via after() so email + WhatsApp complete after the response without
  // being cut off by serverless termination (LS1 fix).
  // occurrenceId = the review-history entry of THIS decision: the organizer's inbox item is keyed
  // to it, so a repeated delivery of one decision lands once, while a later cycle is a new item.
  const occurrenceId = result.reviewEntryId
  if (action === 'approve') {
    try { await ensureCounterExists(slug) } catch { /* idempotent */ }
    after(() => sendEventReviewEmail({ organizerUid: uid, eventName, kind: 'approved', eventId: draftId, occurrenceId }))
  } else if (action === 'reject') {
    after(() => sendEventReviewEmail({ organizerUid: uid, eventName, kind: 'rejected', reason: review?.rejectionReason, eventId: draftId, occurrenceId }))
  } else {
    after(() => sendEventReviewEmail({ organizerUid: uid, eventName, kind: 'changes_requested', comment: review?.changesComment, eventId: draftId, occurrenceId }))
  }

  return NextResponse.json(
    { success: true, lifecycleStatus: result.lifecycleStatus },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
