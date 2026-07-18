// POST /api/organizer/events/[eventId]/save-changes
//
// Syncs the full current draft content to the live events/{slug} document for
// an already-published event. Called by the wizard's "Save Changes" CTA in
// Step 7 when draftStatus === 'published'.
//
// Only content fields are written (eventDetails, pricing, registrationForm,
// accessControl). Lifecycle fields (status, publishedAt, lifecycleStatus, etc.)
// are never touched.
//
// Also writes a change-log entry when schedule or venue fields changed,
// identical to the behaviour of the PATCH /edit endpoint.

import { NextRequest, NextResponse } from 'next/server'
import { FieldValue }                from 'firebase-admin/firestore'
import { adminDb }                   from '@/lib/firebase/admin'
import { authorizeWorkspace }        from '@/lib/team/workspace'

export async function POST(
  req:     NextRequest,
  context: { params: Promise<{ eventId: string }> },
): Promise<NextResponse<{ success: boolean; error?: string }>> {
  const { eventId } = await context.params

  // ── 1. Auth ────────────────────────────────────────────────────────────────
  const authz = await authorizeWorkspace(req, 'events')
  if (!authz.ok) return NextResponse.json({ success: false, error: authz.error }, { status: authz.status })
  const uid = authz.workspaceUid

  // ── 2. Load draft ──────────────────────────────────────────────────────────
  const draftRef  = adminDb.doc(`users/${uid}/eventDrafts/${eventId}`)
  const draftSnap = await draftRef.get()
  if (!draftSnap.exists) {
    return NextResponse.json({ success: false, error: 'Event not found' }, { status: 404 })
  }

  const d       = draftSnap.data() as Record<string, unknown>
  const details = (d.eventDetails as Record<string, unknown>) ?? {}
  const seo     = (details.seo    as Record<string, unknown>) ?? {}
  const slug    = typeof seo.urlSlug === 'string' && seo.urlSlug ? seo.urlSlug : null

  // Only valid for published events
  if (d.status !== 'published') {
    return NextResponse.json(
      { success: false, error: 'Use the publish flow for draft events.' },
      { status: 400 },
    )
  }

  if (!slug) {
    return NextResponse.json(
      { success: false, error: 'Event has no URL slug — cannot sync to live page.' },
      { status: 400 },
    )
  }

  // ── 3. Detect impactful changes for change-log ────────────────────────────
  const eventRef  = adminDb.collection('events').doc(slug)
  const eventSnap = await eventRef.get()
  if (!eventSnap.exists) {
    return NextResponse.json({ success: false, error: 'Live event document not found.' }, { status: 404 })
  }

  const live        = eventSnap.data() as Record<string, unknown>
  const liveSched   = ((live.eventDetails as Record<string, unknown>)?.schedule   as Record<string, unknown>) ?? {}
  const liveVenue   = ((live.eventDetails as Record<string, unknown>)?.venue      as Record<string, unknown>) ?? {}
  const livePhys    = (liveVenue.physical as Record<string, unknown>) ?? {}
  const liveOnline  = (liveVenue.online   as Record<string, unknown>) ?? {}
  const draftSched  = (details.schedule   as Record<string, unknown>) ?? {}
  const draftVenue  = (details.venue      as Record<string, unknown>) ?? {}
  const draftPhys   = (draftVenue.physical as Record<string, unknown>) ?? {}
  const draftOnline = (draftVenue.online   as Record<string, unknown>) ?? {}

  const impactful: string[] = []
  function checkField(key: string, draftVal: unknown, liveVal: unknown) {
    const d = typeof draftVal === 'string' ? draftVal.trim() : draftVal
    const l = typeof liveVal  === 'string' ? liveVal.trim()  : liveVal
    if (d !== l) impactful.push(key)
  }
  checkField('startDate',      draftSched.startDate,    liveSched.startDate)
  checkField('startTime',      draftSched.startTime,    liveSched.startTime)
  checkField('endDate',        draftSched.endDate,      liveSched.endDate)
  checkField('endTime',        draftSched.endTime,      liveSched.endTime)
  checkField('venueType',      draftVenue.type,         liveVenue.type)
  checkField('venueName',      draftPhys.name,          livePhys.name)
  checkField('venueCity',      draftPhys.city,          livePhys.city)
  checkField('venueAddress',   draftPhys.addressLine1,  livePhys.addressLine1)
  checkField('onlinePlatform', draftOnline.platform,    liveOnline.platform)
  checkField('onlineMeetingUrl', draftOnline.meetingUrl, liveOnline.meetingUrl)

  // ── 3b. Pricing integrity guard (parity with PATCH /edit) ─────────────────
  // /edit blocks lowering a pass capacity below its sold count on a published
  // event (edit/route.ts RangeError). save-changes pushes the whole draft.pricing
  // to the live doc, so without the same check it is a bypass — a capacity below
  // sold would over-report availability / drive remaining-seats negative. Enforce
  // the identical invariant here, reading the authoritative per-pass sold counter.
  const draftPasses = Array.isArray((d.pricing as Record<string, unknown> | null)?.passes)
    ? ((d.pricing as Record<string, unknown>).passes as Record<string, unknown>[])
    : []
  if (draftPasses.length > 0) {
    const counterSnap = await adminDb.collection('registrationCounters').doc(slug).get()
    const passCounts  = (counterSnap.data()?.passCounts ?? {}) as Record<string, number>
    for (const pass of draftPasses) {
      const pid  = typeof pass.id === 'string' ? pass.id : ''
      const sold = passCounts[pid] ?? 0
      const qty  = pass.unlimited === true ? null : (typeof pass.quantity === 'number' ? pass.quantity : null)
      if (qty !== null && qty < sold) {
        return NextResponse.json(
          { success: false, error: `Pass "${typeof pass.name === 'string' ? pass.name : pid}" capacity (${qty}) cannot be less than its sold count (${sold}).` },
          { status: 400 },
        )
      }
    }
  }

  // ── 4. Batch write: touch draft + sync all content fields to live event ───
  try {
    const ts    = FieldValue.serverTimestamp()
    const batch = adminDb.batch()

    batch.update(draftRef, { updatedAt: ts, updatedBy: uid })
    batch.update(eventRef, {
      eventDetails:     d.eventDetails     ?? null,
      pricing:          d.pricing          ?? null,
      registrationForm: d.registrationForm ?? null,
      accessControl:    d.accessControl    ?? null,
      updatedAt:        ts,
      updatedBy:        uid,
    })

    await batch.commit()
  } catch (err) {
    console.error('[save-changes] Batch write failed:', err)
    return NextResponse.json({ success: false, error: 'Failed to save changes.' }, { status: 500 })
  }

  // ── 5. Change-log (fire-and-forget) ───────────────────────────────────────
  if (impactful.length > 0) {
    adminDb
      .collection('events').doc(slug)
      .collection('changeLog').add({
        changedFields: impactful,
        changedAt:     FieldValue.serverTimestamp(),
        changedBy:     uid,
      })
      .catch(err => console.error('[save-changes] Change-log write failed:', err))
  }

  return NextResponse.json({ success: true })
}
