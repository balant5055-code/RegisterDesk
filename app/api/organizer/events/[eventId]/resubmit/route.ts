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
import { validateEventPublish } from '@/lib/events/validatePublish'
import { sendEventReviewEmail } from '@/lib/events/reviewNotifications'
import { governPublish, recordPublish, extractIdentity } from '@/lib/events/governance'

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

  // ── Reuse the SHARED publish validation engine (no duplicated rules) — identical to
  //    republish, so resubmit and republish run ONE publish-validation pipeline (RD-EVENTS-01
  //    Phase 3.1 parity). A content-broken event is rejected here rather than reaching review. ─
  const validation = validateEventPublish({
    status:               d.status               as string,
    pricing:              d.pricing              as Record<string, unknown> | null,
    eventDetails:         d.eventDetails         as Record<string, unknown> | null,
    communicationBilling: d.communicationBilling as Record<string, unknown> | null | undefined,
    registrationForm:     d.registrationForm     as Record<string, unknown> | null | undefined,
  })
  if (!validation.canPublish) {
    return NextResponse.json(
      { canPublish: false, reason: validation.reason, blockers: validation.blockers },
      { status: 403 },
    )
  }

  // ── PUBLISH GOVERNANCE (M2): resubmit is a publish path (→ review → live), so it must
  //    pass the SAME identity gateway as publish/republish. A rejected / changes-requested
  //    event cannot be morphed (name/date/venue) and resubmitted under the existing license
  //    without classification — a major change is blocked (Duplicate as New Event), a moderate
  //    one needs confirmation. Reuses governPublish (the ONE governance path; no duplication). ─
  let body: Record<string, unknown> | null = null
  try { body = await req.json() } catch { body = null }
  const confirmed = body?.confirmIdentityChange === true
  const gov = await governPublish({ eventId, draft: d, slug, confirmed })
  if (!gov.ok) {
    return NextResponse.json(
      {
        canPublish: false,
        reason:     gov.decision === 'warn' ? 'IDENTITY_CONFIRMATION_REQUIRED' : 'IDENTITY_CHANGED',
        error:      gov.reason,
        governance: {
          decision: gov.decision as 'warn' | 'block', level: gov.level, changedFields: gov.changedFields,
          requiresConfirmation: gov.requiresConfirmation, suggestDuplicate: gov.suggestDuplicate,
        },
      },
      { status: gov.decision === 'warn' ? 409 : 403 },
    )
  }

  const result = await applyLifecycleTransition(uid, eventId, 'resubmit')
  if (!result.success) {
    return NextResponse.json({ success: false, error: result.error }, { status: result.statusCode })
  }

  // Record this publish against the immutable identity baseline (bumps publishCount;
  // captures the baseline lazily for legacy events) — identical to republish.
  const tier = typeof d.licenseTier === 'string' ? d.licenseTier : 'starter'
  void recordPublish(eventId, extractIdentity(d), { orderId: `lic_${eventId}`, tier, slug })
    .catch(e => console.error('[resubmit] baseline record failed (non-fatal):', eventId, e))

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
