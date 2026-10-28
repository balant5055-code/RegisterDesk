// POST /api/organizer/events/[eventId]/close-review
// Body: { reviewCycleId: string | null, confirm: true, reason?: string }
//
// RD-REVIEW-02 — the event OWNER closes an event whose changes were requested (either deadline
// phase: Changes Requested or Action Required) instead of resubmitting it. Permanent for ordinary
// organizer operations: the event becomes 'cancelled' with a `reviewClosure { source: 'organizer' }`
// marker, after which editing, resubmission, restore and republish are refused. Nothing is deleted.
//
// Financial rule: a pure lifecycle write — no refund, wallet, licence, order, allowance or
// registration write of any kind. Unused paid services stay exactly as they are; the existing
// service rules (organizer request + Super Admin review) apply to them as to any cancelled event.
//
// Concurrency: the shared lifecycle transition re-checks, inside its transaction, that the event is
// still 'changes_requested', in the cycle the organizer saw, and before the last deadline. A request
// racing a resubmission or the scheduler's closure therefore either wins outright or is refused.
// A repeat of a closure that already happened answers 200 { alreadyClosed: true }.

import { NextRequest, NextResponse } from 'next/server'
import { adminDb }                   from '@/lib/firebase/admin'
import { authorizeWorkspace }        from '@/lib/team/workspace'
import { applyLifecycleTransition, deriveLifecycleStatus } from '@/lib/events/lifecycle'
import { isReviewClosed }            from '@/lib/events/lifecycleStateMachine'

type Ctx = { params: Promise<{ eventId: string }> }

export async function POST(req: NextRequest, { params }: Ctx): Promise<NextResponse> {
  const authz = await authorizeWorkspace(req, 'events')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  // Owner only (decision D7): closing ends the event for good, so a team member may not do it.
  if (authz.callerUid !== authz.workspaceUid) {
    return NextResponse.json({ error: 'Only the event owner can close this event.', code: 'OWNER_ONLY' }, { status: 403 })
  }
  const uid = authz.workspaceUid
  const { eventId } = await params

  let body: Record<string, unknown> | null = null
  try { body = await req.json() as Record<string, unknown> } catch { body = null }
  if (!body || body.confirm !== true) {
    return NextResponse.json({ error: 'Confirm that you want to close this event.', code: 'CONFIRMATION_REQUIRED' }, { status: 400 })
  }
  const cycle = body.reviewCycleId
  if (!(cycle === null || (typeof cycle === 'string' && cycle.length > 0 && cycle.length <= 100))) {
    return NextResponse.json({ error: 'reviewCycleId is required. Reload the page.', code: 'REVIEW_CYCLE_REQUIRED' }, { status: 400 })
  }
  const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 500) : ''

  const draftSnap = await adminDb.doc(`users/${uid}/eventDrafts/${eventId}`).get()
  if (!draftSnap.exists) return NextResponse.json({ error: 'Event not found' }, { status: 404 })
  const d = draftSnap.data() as Record<string, unknown>
  if (isReviewClosed(d)) {
    return NextResponse.json({ success: true, alreadyClosed: true, lifecycleStatus: 'cancelled' }, { headers: { 'Cache-Control': 'no-store' } })
  }
  if (deriveLifecycleStatus(d) !== 'changes_requested') {
    return NextResponse.json({ error: 'Only an event whose changes were requested can be closed here.', code: 'STATUS_CHANGED' }, { status: 409 })
  }

  const slug = typeof (d.eventDetails as { seo?: { urlSlug?: unknown } } | undefined)?.seo?.urlSlug === 'string'
    ? String((d.eventDetails as { seo: { urlSlug: string } }).seo.urlSlug) : eventId
  const result = await applyLifecycleTransition(uid, eventId, 'close_review', undefined, undefined, authz.callerUid, {
    expectedStatus: 'changes_requested',
    expectedCycleId: cycle as string | null,
    closureReason: reason || undefined,
    audit: {
      adminUid: authz.callerUid, actorRole: 'organizer', action: 'event.review_closed', entityType: 'event', entityId: slug,
      reason: reason || 'Closed by the organizer during review',
      before: { lifecycleStatus: 'changes_requested' }, after: { lifecycleStatus: 'cancelled', reviewClosure: 'organizer' },
      metadata: { organizerUid: uid },
    },
  })
  if (!result.success) {
    // A concurrent duplicate of this same closure (a double click, a retry) lost the race to the first:
    // the event IS closed by its owner, which is what was asked — answer as a repeat, not an error.
    if (result.code === 'STATUS_CHANGED') {
      const now = (await adminDb.doc(`users/${uid}/eventDrafts/${eventId}`).get()).data() as Record<string, unknown> | undefined
      const c = now?.reviewClosure as { source?: unknown } | undefined
      if (now && isReviewClosed(now) && c?.source === 'organizer') {
        return NextResponse.json({ success: true, alreadyClosed: true, lifecycleStatus: 'cancelled' }, { headers: { 'Cache-Control': 'no-store' } })
      }
    }
    return NextResponse.json({ success: false, error: result.error, code: result.code ?? null }, { status: result.statusCode })
  }
  return NextResponse.json({ success: true, lifecycleStatus: result.lifecycleStatus }, { headers: { 'Cache-Control': 'no-store' } })
}
