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
import { EVENT_LICENSES_COLLECTION, LICENSE_ORDERS_COLLECTION } from '@/lib/licensing/schema'

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
  const details = (d.eventDetails as Record<string, unknown>) ?? {}
  const seo     = (details.seo    as Record<string, unknown>) ?? {}
  const slug    = typeof seo.urlSlug === 'string' && seo.urlSlug ? seo.urlSlug : null

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
      // Only delete the public doc if it belongs to this draft
      if (eventData.draftId === draftId) {
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
  const info      = (details.info as Record<string, unknown>) ?? {}
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
