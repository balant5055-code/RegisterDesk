// POST /api/organizer/events/[eventId]/republish
//
// Republish a previously UNPUBLISHED event. It goes back through ADMIN REVIEW
// (→ pending_review), NEVER straight to published — the existing approval flow is
// reused. Because the events/{slug} doc and the paid Event License already exist
// from the original publish, this is a pure LIFECYCLE TRANSITION: it does NOT
// re-run the publish transaction and NEVER requests payment (no Razorpay, no new
// licenseOrder, no new eventLicense). The shared publish validation is reused —
// not duplicated — before the transition.

import { NextRequest, NextResponse } from 'next/server'
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

  // ── Only an UNPUBLISHED event may be republished ────────────────────────────
  const ls = deriveLifecycleStatus(d)
  if (ls !== 'unpublished') {
    return NextResponse.json(
      { error: 'Only an unpublished event can be republished.' },
      { status: 409 },
    )
  }

  // ── The event doc must already exist (its paid Event License is keyed by slug
  //    and is reused as-is — this is what guarantees republish needs no payment) ─
  const seo  = (d.eventDetails as Record<string, unknown> | undefined)?.seo as Record<string, unknown> | undefined
  const slug = typeof seo?.urlSlug === 'string' && seo.urlSlug ? seo.urlSlug : null
  if (!slug) return NextResponse.json({ error: 'Event has never been published' }, { status: 400 })
  const eventSnap = await adminDb.collection('events').doc(slug).get()
  if (!eventSnap.exists) return NextResponse.json({ error: 'Event has never been published' }, { status: 400 })

  // ── Reuse the SHARED publish validation engine (no duplicated rules) ────────
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

  // ── EA-4 S1: PUBLISH GOVERNANCE — the same gateway as first publish. Republish
  //    reuses the license, so the identity MUST still match the immutable baseline;
  //    a major change is blocked (Duplicate as New Event), moderate needs confirm. ─
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

  // ── Lifecycle transition: unpublished → pending_review (reuses the license) ─
  const result = await applyLifecycleTransition(uid, eventId, 'republish')
  if (!result.success) {
    return NextResponse.json({ success: false, error: result.error }, { status: result.statusCode })
  }

  // EA-4 S1: record this publish against the immutable baseline (bumps publishCount;
  // captures the baseline lazily for legacy events on their first governed publish).
  const tier = typeof d.licenseTier === 'string' ? d.licenseTier : 'starter'
  void recordPublish(eventId, extractIdentity(d), { orderId: `lic_${eventId}`, tier, slug })
    .catch(e => console.error('[republish] baseline record failed (non-fatal):', eventId, e))

  // Notify the organizer their event is back under review (reuses the existing
  // review notification; appears to admin exactly like a resubmitted event).
  const info      = (d.eventDetails as Record<string, unknown> | undefined)?.info as Record<string, unknown> | undefined
  const eventName = typeof info?.name === 'string' ? info.name : 'Your event'
  void sendEventReviewEmail({ organizerUid: uid, eventName, kind: 'resubmitted', eventId })

  return NextResponse.json(
    { success: true, lifecycleStatus: result.lifecycleStatus },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
