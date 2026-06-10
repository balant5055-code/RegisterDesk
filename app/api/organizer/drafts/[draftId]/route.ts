// DELETE /api/organizer/drafts/[draftId]
//
// Permanently deletes a draft event. Only allowed when the event is in 'draft'
// lifecycle status. If the draft was previously published and then unpublished,
// the corresponding events/{slug} document is also deleted.

import { NextRequest, NextResponse } from 'next/server'
import { adminAuth, adminDb }        from '@/lib/firebase/admin'
import { deriveLifecycleStatus }     from '@/lib/events/lifecycle'

export async function DELETE(
  req:     NextRequest,
  context: { params: Promise<{ draftId: string }> },
): Promise<NextResponse> {
  const { draftId } = await context.params

  // ── 1. Auth ────────────────────────────────────────────────────────────────
  const token = (req.headers.get('authorization') ?? '').replace('Bearer ', '')
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let uid: string
  try {
    uid = (await adminAuth.verifyIdToken(token)).uid
  } catch {
    return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
  }

  // ── 2. Load draft (uid in path enforces ownership) ─────────────────────────
  const draftRef  = adminDb.doc(`users/${uid}/eventDrafts/${draftId}`)
  const draftSnap = await draftRef.get()

  if (!draftSnap.exists) {
    return NextResponse.json({ error: 'Draft not found' }, { status: 404 })
  }

  const d             = draftSnap.data() as Record<string, unknown>
  const currentStatus = deriveLifecycleStatus(d)

  // ── 3. Only drafts may be deleted ─────────────────────────────────────────
  if (currentStatus !== 'draft') {
    return NextResponse.json(
      { error: `Cannot delete an event with status '${currentStatus}'. Only draft events can be deleted.` },
      { status: 409 },
    )
  }

  // ── 4. Resolve slug (present if event was previously published then unpublished) ──
  const details = (d.eventDetails as Record<string, unknown>) ?? {}
  const seo     = (details.seo    as Record<string, unknown>) ?? {}
  const slug    = typeof seo.urlSlug === 'string' && seo.urlSlug ? seo.urlSlug : null

  // ── 5. Atomic batch delete ─────────────────────────────────────────────────
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

  return NextResponse.json({ success: true })
}
