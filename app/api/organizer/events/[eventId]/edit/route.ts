// PATCH /api/organizer/events/[eventId]/edit
//
// Edits a published event's content fields.
//
// Freely editable:
//   info (name, tagline, shortDesc, fullDesc), media (bannerUrl, logoUrl),
//   schedule, venue, organizer info, speakers, sponsors, gallery, SEO meta.
//
// Impactful changes (schedule + venue) write a record to
//   events/{slug}/changeLog for future notification use.
//
// Restricted (rejected):
//   eventType, visibility, pricingModel, pass prices, urlSlug.
//   Pass capacity can only increase — never fall below sold count.
//
// Atomically updates both the draft AND events/{slug} (if published).
//
// RD-PHASE4-S3 · Q1 — `feeModel` (the Fee Collection Method) is NOT editable here any more: fee
// collection is fixed to organizer-pays and organizers do not choose it. A request carrying it is
// refused with 403 PRICING_NOT_ORGANIZER_EDITABLE (it was editable under RD-EVENT-COMMERCE-05E).

import { NextRequest, NextResponse }  from 'next/server'
import { FieldValue }                 from 'firebase-admin/firestore'
import { adminDb }                    from '@/lib/firebase/admin'
import { authorizeWorkspace }         from '@/lib/team/workspace'
import { findForbiddenEditKeys, requiresAttendeeNotification } from '@/lib/events/editing/fieldClassification'
import { buildEventEditUpdate, extractEditableSnapshot, pickPayload } from '@/lib/events/editing/applyEdit'
import { writeEditHistory }           from '@/lib/events/editing/editHistory'
import {
  resolveLiveEventRef, draftPublicSlug, liveEventLookupMessage, liveEventLookupStatus,
} from '@/lib/events/liveEventRef'
import type { EventEditPayload, EventEditResponse } from '@/types/events'
import { introducedValueIssues, applyFieldPaths } from '@/lib/events/eventValueRules'
import { galleryChangeProblem, galleryOf } from '@/lib/events/galleryLimits'
import { resolvePlatformPricing }    from '@/lib/platform/pricing/resolver'
import { isReviewClosed }            from '@/lib/events/lifecycleStateMachine'

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function PATCH(
  req:     NextRequest,
  context: { params: Promise<{ eventId: string }> },
): Promise<NextResponse<EventEditResponse>> {
  const { eventId } = await context.params

  // ── 1. Auth ────────────────────────────────────────────────────────────────
  const authz = await authorizeWorkspace(req, 'events')
  if (!authz.ok) return NextResponse.json({ success: false, error: authz.error }, { status: authz.status })
  const uid = authz.workspaceUid

  // ── 2. Parse body + enforce field classification (defense-in-depth) ─────────
  let body: Record<string, unknown>
  try { body = await req.json() as Record<string, unknown> } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON' }, { status: 400 })
  }
  // Reject any restricted/locked/unknown key outright — an edit may ONLY touch SAFE
  // content fields. Immutable financial/attendee records live in separate collections
  // and are never reachable from here, but this is an explicit contract + audit.
  // ── RD-EMAIL-PROVIDER — ADMIN-ONLY. Refused explicitly, not merely ignored. ──
  // The email transport is platform infrastructure: an organizer switching it could move
  // their attendee mail onto a provider the platform has not verified for them. It is
  // written ONLY by PATCH /api/admin/events/[slug]/email-provider.
  //
  // Removing the key from SAFE_EDIT_KEYS already makes it 'unknown' and therefore
  // forbidden below. This named check is deliberate belt-and-braces: it survives any
  // future re-classification, and it returns an honest 403 rather than a generic
  // 'cannot be edited after publish' 400.
  if (Object.prototype.hasOwnProperty.call(body, 'emailProvider')) {
    return NextResponse.json(
      { success: false, error: 'emailProvider is managed by RegisterDesk administrators and cannot be changed here.' },
      { status: 403 },
    )
  }

  // RD-FEE-RESTORE-01 — the Fee Collection Method is organizer-editable again, but ONLY while the
  // pricing engine is on. The gate is SERVER-SIDE and independent of the builder: hiding the control
  // in the wizard is a courtesy, this is the control. The same 403 and stable code as before are
  // returned when the engine is off, so nothing an existing client does changes behaviour.
  let feeModelEditable = false
  if (Object.prototype.hasOwnProperty.call(body, 'feeModel')) {
    feeModelEditable = (await resolvePlatformPricing()).features.pricingEngineEnabled
    if (!feeModelEditable) {
      return NextResponse.json(
        { success: false, error: 'The fee collection method is managed by RegisterDesk and cannot be changed here.', code: 'PRICING_NOT_ORGANIZER_EDITABLE' },
        { status: 403 },
      )
    }
  }

  const forbidden = findForbiddenEditKeys(Object.keys(body))
  if (forbidden.length > 0) {
    return NextResponse.json(
      { success: false, error: `These fields cannot be edited after publish: ${forbidden.join(', ')}` },
      { status: 400 },
    )
  }
  const reason  = typeof body.reason === 'string' ? body.reason.trim().slice(0, 500) : null
  const payload = body as EventEditPayload

  // ── 3. Load draft ──────────────────────────────────────────────────────────
  const draftRef  = adminDb.doc(`users/${uid}/eventDrafts/${eventId}`)
  const draftSnap = await draftRef.get()
  if (!draftSnap.exists) {
    return NextResponse.json({ success: false, error: 'Event not found' }, { status: 404 })
  }

  const d       = draftSnap.data() as Record<string, unknown>
  // RD-REVIEW-02 — an event closed during review is permanently closed for ordinary editing.
  if (isReviewClosed(d)) {
    return NextResponse.json(
      { success: false, error: 'This event was closed during review and can no longer be edited.' },
      { status: 409 },
    )
  }
  const isPublished = d.status === 'published'

  // ── 3b. Locate the live document BEFORE anything is computed from the slug ──
  //
  // This used to read `eventDetails.seo.urlSlug` and then, at write time, do
  // `if (eventSnap.exists) batch.update(...)` — so a stale pointer meant the live
  // document was SILENTLY SKIPPED and the organizer was told the edit succeeded. A venue
  // or date change would sit in the draft while attendees kept seeing the old one, with
  // nothing anywhere reporting a problem. A missing live page for a published event is a
  // real fault and now fails visibly.
  //
  // Resolving here (not at write time) also means the registration counter below is read
  // under the SAME slug the live document actually uses.
  let liveRef: FirebaseFirestore.DocumentReference | null = null
  let slug: string | null = draftPublicSlug(d)

  if (isPublished) {
    const lookup = await resolveLiveEventRef(eventId, d, uid)
    if (!lookup.ok) {
      if (lookup.reason === 'SLUG_MISMATCH') {
        console.error('[edit] draft/live slug mismatch', {
          eventId, draftSlug: lookup.slug, liveSlug: lookup.canonicalSlug,
        })
      }
      return NextResponse.json(
        { success: false, error: liveEventLookupMessage(lookup) },
        { status: liveEventLookupStatus(lookup) },
      )
    }
    liveRef = lookup.ref
    slug    = lookup.slug
  }

  // ── 4. Load registration counter for pass capacity validation ─────────────
  let passCounts: Record<string, number> = {}
  if (slug) {
    const counterSnap = await adminDb.collection('registrationCounters').doc(slug).get()
    if (counterSnap.exists) {
      passCounts = (counterSnap.data() as { passCounts?: Record<string, number> }).passCounts ?? {}
    }
  }

  // ── 5. Build the field-path updates via the shared (pure) mapper ────────────
  let built
  try {
    // RD-FEE-RESTORE-01 — `authz.callerUid` (the authenticated human), not `uid` (the workspace),
    // so the recorded actor is the person who made the choice even on a delegated workspace.
    built = buildEventEditUpdate(payload, d, passCounts, {
      feeModelEditable,
      actorUid: authz.callerUid,
      nowIso:   new Date().toISOString(),
    })
  } catch (err) {
    if (err instanceof RangeError) {
      return NextResponse.json({ success: false, error: err.message }, { status: 400 })
    }
    console.error('[edit] Failed to build update:', err)
    return NextResponse.json({ success: false, error: 'Failed to prepare changes' }, { status: 500 })
  }
  const { updates, changedFields, impactfulFields } = built

  if (changedFields.length === 0) {
    return NextResponse.json({ success: true, notificationRequired: false, impactfulFields: [], changedFields: [] })
  }

  // RD-CE-FIX H1 · the edited event must still pass the server's VALUE rules (dates in order,
  // sane prices/quantities/windows). Only issues this edit introduces are refused.
  // RD-WAIVER-01 · eventType lets the sports-waiver rule run on edits (frozen after publish).
  const introduced = introducedValueIssues(
    { eventDetails: d.eventDetails, pricing: d.pricing, eventType: d.eventType },
    (() => { const after = applyFieldPaths(d, updates as Record<string, unknown>); return { eventDetails: after.eventDetails, pricing: after.pricing, eventType: d.eventType } })(),
  )
  if (introduced.length > 0) {
    return NextResponse.json({ success: false, error: introduced.map(i => i.message).join(' ') }, { status: 422 })
  }

  // RD-GALLERY-01 — 6 uploaded / 20 URL gallery images, growth-only: an event saved under the old
  // limit can still be edited and trimmed, but no edit can grow a count past its limit.
  if (changedFields.includes('galleryImages')) {
    const gallery = galleryChangeProblem(galleryOf(d.eventDetails), galleryOf(applyFieldPaths(d, updates as Record<string, unknown>).eventDetails))
    if (gallery) return NextResponse.json({ success: false, error: gallery, code: 'GALLERY_LIMIT' }, { status: 422 })
  }

  // Capture the "before" snapshot of exactly the changed fields (for rollback + audit).
  const beforeSnapshot = pickPayload(extractEditableSnapshot(d), changedFields)
  const afterSnapshot  = pickPayload(payload, changedFields)

  const meta = { updatedAt: FieldValue.serverTimestamp(), updatedBy: uid }
  const draftUpdate = { ...updates, ...meta }
  const eventUpdate = { ...updates, ...meta }

  // ── 6. Atomic update (draft + live doc if published) ─────────────────────────
  // RD-REVIEW-02 — a transaction (it was a blind batch) so the closure check above cannot race a
  // permanent review closure: the draft is re-read here, and if a closure commits after that read,
  // Firestore retries this transaction, which then sees the closure and writes nothing.
  let closedMeanwhile = false as boolean   // set inside the transaction callback (not narrowed away)
  try {
    await adminDb.runTransaction(async txn => {
      closedMeanwhile = false
      const fresh = await txn.get(draftRef)
      if (!fresh.exists || isReviewClosed(fresh.data() as Record<string, unknown>)) { closedMeanwhile = true; return }
      txn.update(draftRef, draftUpdate)

      // `liveRef` is non-null for every published event — step 3b already refused the
      // request otherwise, so there is no "exists?" branch left that can swallow the write.
      if (liveRef) txn.update(liveRef, eventUpdate)
    })
  } catch (err) {
    console.error('[edit] Failed to save:', err)
    return NextResponse.json({ success: false, error: 'Failed to save changes' }, { status: 500 })
  }
  if (closedMeanwhile) {
    return NextResponse.json(
      { success: false, error: 'This event was closed during review and can no longer be edited.' },
      { status: 409 },
    )
  }

  const notificationRequired = requiresAttendeeNotification(changedFields)

  // ── 7. Append the immutable edit-history record (fire-and-forget) ───────────
  if (isPublished && slug) {
    // Keep the legacy changeLog (backward compat with any external reader).
    if (impactfulFields.length > 0) {
      adminDb.collection('events').doc(slug).collection('changeLog')
        .add({ changedFields: impactfulFields, changedAt: FieldValue.serverTimestamp(), changedBy: uid })
        .catch(err => console.error('[edit] Failed to write change log:', err))
    }
    void writeEditHistory(slug, {
      editorUid: authz.callerUid, editorName: authz.callerUid,
      changedFields, impactfulFields, reason,
      attendeesNotified: false, isRollback: false,
      before: beforeSnapshot, after: afterSnapshot,
    })
  }

  return NextResponse.json({ success: true, notificationRequired, impactfulFields, changedFields })
}
