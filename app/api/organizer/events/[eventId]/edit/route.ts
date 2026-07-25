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

import { NextRequest, NextResponse }  from 'next/server'
import { FieldValue }                 from 'firebase-admin/firestore'
import { adminDb }                    from '@/lib/firebase/admin'
import { authorizeWorkspace }         from '@/lib/team/workspace'
import { findForbiddenEditKeys, requiresAttendeeNotification } from '@/lib/events/editing/fieldClassification'
import { buildEventEditUpdate, extractEditableSnapshot, pickPayload } from '@/lib/events/editing/applyEdit'
import { writeEditHistory }           from '@/lib/events/editing/editHistory'
import type { EventEditPayload, EventEditResponse } from '@/types/events'

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
  const details = (d.eventDetails as Record<string, unknown>) ?? {}
  const seo     = (details.seo    as Record<string, unknown>) ?? {}
  const slug    = typeof seo.urlSlug === 'string' && seo.urlSlug ? seo.urlSlug : null

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
    built = buildEventEditUpdate(payload, d, passCounts)
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

  // Capture the "before" snapshot of exactly the changed fields (for rollback + audit).
  const beforeSnapshot = pickPayload(extractEditableSnapshot(d), changedFields)
  const afterSnapshot  = pickPayload(payload, changedFields)

  const meta = { updatedAt: FieldValue.serverTimestamp(), updatedBy: uid }
  const draftUpdate = { ...updates, ...meta }
  const eventUpdate = { ...updates, ...meta }
  const isPublished = Boolean(slug && d.status === 'published')

  // ── 6. Atomic batch update (draft + live doc if published) ──────────────────
  try {
    const batch = adminDb.batch()
    batch.update(draftRef, draftUpdate)

    if (isPublished && slug) {
      const eventRef  = adminDb.collection('events').doc(slug)
      const eventSnap = await eventRef.get()
      if (eventSnap.exists) batch.update(eventRef, eventUpdate)
    }

    await batch.commit()
  } catch (err) {
    console.error('[edit] Failed to save:', err)
    return NextResponse.json({ success: false, error: 'Failed to save changes' }, { status: 500 })
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
