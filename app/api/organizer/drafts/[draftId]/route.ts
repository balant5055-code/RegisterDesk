// DELETE /api/organizer/drafts/[draftId]
//
// Permanently deletes a draft event. Only allowed when the event is in 'draft'
// lifecycle status. If the draft was previously published and then unpublished,
// the corresponding events/{slug} document is also deleted.

import { NextRequest, NextResponse } from 'next/server'
import { FieldValue }                from 'firebase-admin/firestore'
import { adminDb }                   from '@/lib/firebase/admin'
import { authorizeWorkspace }        from '@/lib/team/workspace'
import { deriveLifecycleStatus }     from '@/lib/events/lifecycle'
import { isReviewClosed }            from '@/lib/events/lifecycleStateMachine'
import { getEventTypeAvailability }  from '@/lib/events/eventTypeAvailabilityServer'
import { isEventTypeAvailable, EVENT_TYPE_UNAVAILABLE_CODE, EVENT_TYPE_UNAVAILABLE_MESSAGE } from '@/lib/events/eventTypeAvailability'
import { EVENT_LICENSES_COLLECTION, LICENSE_ORDERS_COLLECTION } from '@/lib/licensing/schema'
import { sanitizeDraftPayload, pinPublishedDraftFields, serializeDraft } from '@/lib/events/draftWrite'
import { resolveOwnedEventSlug, liveEventBelongsTo } from '@/lib/events/liveEventRef'

// RD-CE-FIX M2/H6 · GET + PATCH: the wizard's ONLY read/write path for an event draft. The draft
// always lives under the WORKSPACE (users/{workspaceUid}/eventDrafts), so a team member with the
// `events` permission edits the same document the owner, publish and licensing read. Writes go
// through the allow-list in lib/events/draftWrite.ts; nothing else reaches the document.

export async function GET(
  req:     NextRequest,
  context: { params: Promise<{ draftId: string }> },
): Promise<NextResponse> {
  const { draftId } = await context.params
  const authz = await authorizeWorkspace(req, 'events')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  const snap = await adminDb.doc(`users/${authz.workspaceUid}/eventDrafts/${draftId}`).get()
  if (!snap.exists) return NextResponse.json({ error: 'Draft not found' }, { status: 404 })
  return NextResponse.json({ draft: serializeDraft(snap.id, snap.data() as Record<string, unknown>) },
    { headers: { 'Cache-Control': 'no-store' } })
}

export async function PATCH(
  req:     NextRequest,
  context: { params: Promise<{ draftId: string }> },
): Promise<NextResponse> {
  const { draftId } = await context.params
  const authz = await authorizeWorkspace(req, 'events')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })

  let body: unknown
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid request body' }, { status: 400 }) }
  const check = sanitizeDraftPayload(body)
  if (!check.ok) return NextResponse.json({ error: check.error, field: check.field ?? null }, { status: 400 })

  const ref = adminDb.doc(`users/${authz.workspaceUid}/eventDrafts/${draftId}`)
  // RD-EVENT-TYPES-01 — read only when the save carries a type (the wizard's type step).
  const availability = check.fields.eventType !== undefined ? (await getEventTypeAvailability()).availability : null
  const result = await adminDb.runTransaction(async txn => {
    const snap = await txn.get(ref)
    if (!snap.exists) return null
    // RD-REVIEW-02 — an event closed during review is permanently closed for ordinary editing.
    // Checked on the transactional snapshot, so a save racing the closure cannot slip in after it.
    if (isReviewClosed(snap.data() as Record<string, unknown>)) return { closed: true as const }
    const { fields, refused } = pinPublishedDraftFields(check.fields, snap.data() as Record<string, unknown>)
    // RD-EVENT-TYPES-01 — a draft may not be SWITCHED to an unavailable type. Re-saving the type it
    // already has is allowed (an existing draft of a now-disabled type stays editable). Checked after
    // pinning: a published draft's type is frozen and reported in `refused`, never a 403.
    if (availability && fields.eventType !== undefined && fields.eventType !== snap.get('eventType') && !isEventTypeAvailable(availability, fields.eventType)) {
      return { typeUnavailable: true as const }
    }
    txn.update(ref, { ...fields, updatedAt: FieldValue.serverTimestamp(), updatedBy: authz.callerUid })
    return { refused }
  })
  if (!result) return NextResponse.json({ error: 'Draft not found' }, { status: 404 })
  if ('closed' in result) {
    return NextResponse.json({ error: 'This event was closed during review and can no longer be edited.', code: 'REVIEW_CLOSED' }, { status: 409 })
  }
  if ('typeUnavailable' in result) {
    return NextResponse.json({ error: EVENT_TYPE_UNAVAILABLE_MESSAGE, code: EVENT_TYPE_UNAVAILABLE_CODE, field: 'eventType' }, { status: 403 })
  }
  return NextResponse.json({ ok: true, dropped: check.dropped, refused: result.refused })
}

export async function DELETE(
  req:     NextRequest,
  context: { params: Promise<{ draftId: string }> },
): Promise<NextResponse> {
  const { draftId } = await context.params

  // ── 1. Auth — owner only (team members cannot delete events) ───────────────
  const authz = await authorizeWorkspace(req, 'events')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  if (!authz.isOwner) {
    return NextResponse.json({ error: 'Only the account owner can delete events.' }, { status: 403 })
  }
  const uid = authz.workspaceUid

  // ── 2. Load draft (uid in path enforces ownership) ─────────────────────────
  const draftRef  = adminDb.doc(`users/${uid}/eventDrafts/${draftId}`)
  const draftSnap = await draftRef.get()

  if (!draftSnap.exists) {
    return NextResponse.json({ error: 'Draft not found' }, { status: 404 })
  }

  const d             = draftSnap.data() as Record<string, unknown>
  const currentStatus = deriveLifecycleStatus(d)

  // ── 3. Resolve slug (present if event was ever published) ──────────────────
  // RD-CE-FIX C1 · the pointer is client-writable and draft ids are client-chosen: only a live
  // document stamped with THIS workspace and THIS draft is ever looked at, let alone deleted.
  const slug    = await resolveOwnedEventSlug(uid, draftId, d)

  // ── 4. Phase L1: NEVER permanently delete a paid/licensed event ────────────
  // Payment happens BEFORE publish — the purchase writes a PAID order keyed
  // `lic_{draftId}` (licenseOrders); the license doc (once the event was ever
  // published) is keyed by slug (eventLicenses). Either signal proves that a
  // successful license/payment exists, so permanent deletion is forbidden and
  // must delete NOTHING. Uses only existing licensing records — creates none.
  const orderSnap    = await adminDb.collection(LICENSE_ORDERS_COLLECTION).doc(`lic_${draftId}`).get()
  const hasPaidOrder = orderSnap.exists && (orderSnap.data() as { status?: unknown }).status === 'paid'

  let hasLicense = false
  if (slug) {
    const licenseSnap = await adminDb.collection(EVENT_LICENSES_COLLECTION).doc(slug).get()
    hasLicense = licenseSnap.exists
  }

  if (hasPaidOrder || hasLicense) {
    return NextResponse.json(
      {
        success: false,
        code:    'PAID_EVENT_CANNOT_DELETE',
        message: 'This event has an active license and cannot be permanently deleted.',
      },
      { status: 409 },
    )
  }

  // ── 5. Only drafts may be deleted ─────────────────────────────────────────
  if (currentStatus !== 'draft') {
    return NextResponse.json(
      { error: `Cannot delete an event with status '${currentStatus}'. Only draft events can be deleted.` },
      { status: 409 },
    )
  }

  // ── 6. Atomic batch delete ─────────────────────────────────────────────────
  const batch = adminDb.batch()
  batch.delete(draftRef)

  if (slug) {
    const eventRef  = adminDb.collection('events').doc(slug)
    const eventSnap = await eventRef.get()
    if (eventSnap.exists) {
      const eventData = eventSnap.data() as Record<string, unknown>
      // Only delete the public doc if it belongs to this draft AND this workspace
      if (liveEventBelongsTo(eventData, uid, draftId)) {
        batch.delete(eventRef)
      }
    }
  }

  try {
    await batch.commit()
  } catch {
    return NextResponse.json({ error: 'Failed to delete draft' }, { status: 500 })
  }

  // ── 7. Audit log (organizer-scoped, fire-and-forget — never blocks delete) ──
  const info      = ((d.eventDetails as Record<string, unknown> | undefined)?.info as Record<string, unknown>) ?? {}
  const eventName = typeof info.name === 'string' ? info.name : null
  void adminDb.collection('teamAuditLogs').add({
    organizerUid: uid,
    actorUid:     authz.callerUid,
    action:       'event.deleted',
    entityType:   'event',
    entityId:     draftId,
    metadata:     { name: eventName, slug, hadPublicDoc: Boolean(slug) },
    createdAt:    FieldValue.serverTimestamp(),
  }).catch(() => { /* best-effort audit */ })

  return NextResponse.json({ success: true })
}
