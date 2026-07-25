// RD-PRODUCT-01F — post-publish edit version history.
//
//   GET  /api/organizer/events/[eventId]/edit-history
//        → list the immutable edit records (newest first).
//        ?noticeFor=<recordId> → the attendee change-notice PREVIEW for that record
//          (Phase 3): subject + html the organizer sends via the broadcast engine.
//
//   POST /api/organizer/events/[eventId]/edit-history   body: { recordId }
//        → ROLLBACK: re-apply the "before" values of that record's changed SAFE fields.
//          Financial/attendee records are never touched (only content fields exist here).
//
// Workspace-gated. Rollback reuses the SAME pure mapper as the edit route, so a rollback
// is exactly a normal content edit with a prior payload — nothing bespoke.

import { NextRequest, NextResponse } from 'next/server'
import { FieldValue } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import { authorizeWorkspace } from '@/lib/team/workspace'
import { findForbiddenEditKeys, requiresAttendeeNotification } from '@/lib/events/editing/fieldClassification'
import { buildEventEditUpdate } from '@/lib/events/editing/applyEdit'
import {
  loadEditHistory, getEditHistoryRecord, writeEditHistory, buildChangeNotice,
} from '@/lib/events/editing/editHistory'
import type { EventEditPayload } from '@/types/events'

function loadDraftContext(d: Record<string, unknown>) {
  const details = (d.eventDetails as Record<string, unknown>) ?? {}
  const info    = (details.info as Record<string, unknown>) ?? {}
  const seo     = (details.seo  as Record<string, unknown>) ?? {}
  const slug    = typeof seo.urlSlug === 'string' && seo.urlSlug ? seo.urlSlug : null
  const name    = typeof info.name === 'string' ? info.name : 'your event'
  return { slug, name }
}

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ eventId: string }> },
): Promise<NextResponse> {
  const { eventId } = await context.params
  const authz = await authorizeWorkspace(req, 'events')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })

  const draftSnap = await adminDb.doc(`users/${authz.workspaceUid}/eventDrafts/${eventId}`).get()
  if (!draftSnap.exists) return NextResponse.json({ error: 'Event not found' }, { status: 404 })
  const { slug, name } = loadDraftContext(draftSnap.data() as Record<string, unknown>)
  if (!slug) return NextResponse.json({ history: [] })

  const noticeFor = req.nextUrl.searchParams.get('noticeFor')
  if (noticeFor) {
    const record = await getEditHistoryRecord(slug, noticeFor)
    if (!record) return NextResponse.json({ error: 'History record not found' }, { status: 404 })
    const notice = buildChangeNotice({ eventName: name, impactfulFields: record.impactfulFields ?? [], after: record.after ?? {} })
    return NextResponse.json({ notice, impactfulFields: record.impactfulFields ?? [] })
  }

  const history = await loadEditHistory(slug)
  return NextResponse.json({ history })
}

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ eventId: string }> },
): Promise<NextResponse> {
  const { eventId } = await context.params
  const authz = await authorizeWorkspace(req, 'events')
  if (!authz.ok) return NextResponse.json({ success: false, error: authz.error }, { status: authz.status })
  const uid = authz.workspaceUid

  let body: { recordId?: string }
  try { body = await req.json() as { recordId?: string } } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON' }, { status: 400 })
  }
  const recordId = typeof body.recordId === 'string' ? body.recordId : ''
  if (!recordId) return NextResponse.json({ success: false, error: 'recordId is required' }, { status: 400 })

  const draftRef  = adminDb.doc(`users/${uid}/eventDrafts/${eventId}`)
  const draftSnap = await draftRef.get()
  if (!draftSnap.exists) return NextResponse.json({ success: false, error: 'Event not found' }, { status: 404 })
  const d = draftSnap.data() as Record<string, unknown>
  const { slug } = loadDraftContext(d)
  if (!slug) return NextResponse.json({ success: false, error: 'Event is not published' }, { status: 400 })

  const record = await getEditHistoryRecord(slug, recordId)
  if (!record) return NextResponse.json({ success: false, error: 'History record not found' }, { status: 404 })

  const restore = (record.before ?? {}) as EventEditPayload
  // Defense-in-depth: a rollback may only restore SAFE fields.
  const forbidden = findForbiddenEditKeys(Object.keys(restore))
  if (forbidden.length > 0) {
    return NextResponse.json({ success: false, error: `Cannot restore locked fields: ${forbidden.join(', ')}` }, { status: 400 })
  }

  // Load pass counts for the capacity floor (same guard as a normal edit).
  let passCounts: Record<string, number> = {}
  const counterSnap = await adminDb.collection('registrationCounters').doc(slug).get()
  if (counterSnap.exists) passCounts = (counterSnap.data() as { passCounts?: Record<string, number> }).passCounts ?? {}

  let built
  try {
    built = buildEventEditUpdate(restore, d, passCounts)
  } catch (err) {
    if (err instanceof RangeError) return NextResponse.json({ success: false, error: err.message }, { status: 400 })
    return NextResponse.json({ success: false, error: 'Failed to prepare rollback' }, { status: 500 })
  }
  const { updates, changedFields, impactfulFields } = built
  if (changedFields.length === 0) {
    return NextResponse.json({ success: true, changedFields: [], notificationRequired: false })
  }

  const meta = { updatedAt: FieldValue.serverTimestamp(), updatedBy: uid }
  try {
    const batch = adminDb.batch()
    batch.update(draftRef, { ...updates, ...meta })
    if (d.status === 'published') {
      const eventRef = adminDb.collection('events').doc(slug)
      const eventSnap = await eventRef.get()
      if (eventSnap.exists) batch.update(eventRef, { ...updates, ...meta })
    }
    await batch.commit()
  } catch (err) {
    console.error('[edit-history] rollback commit failed:', err)
    return NextResponse.json({ success: false, error: 'Failed to apply rollback' }, { status: 500 })
  }

  const notificationRequired = requiresAttendeeNotification(changedFields)
  void writeEditHistory(slug, {
    editorUid: authz.callerUid, editorName: authz.callerUid,
    changedFields, impactfulFields,
    reason: `Rollback of edit ${recordId}`,
    attendeesNotified: false, isRollback: true,
    before: {}, after: restore,
  })

  return NextResponse.json({ success: true, changedFields, impactfulFields, notificationRequired })
}
