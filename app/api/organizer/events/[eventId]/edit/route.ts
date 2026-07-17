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
import type { EventEditPayload, EventEditResponse } from '@/types/events'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function s(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null
}

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

  // ── 2. Parse body ──────────────────────────────────────────────────────────
  let payload: EventEditPayload
  try { payload = await req.json() as EventEditPayload } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON' }, { status: 400 })
  }

  // ── 3. Load draft ──────────────────────────────────────────────────────────
  const draftRef  = adminDb.doc(`users/${uid}/eventDrafts/${eventId}`)
  const draftSnap = await draftRef.get()
  if (!draftSnap.exists) {
    return NextResponse.json({ success: false, error: 'Event not found' }, { status: 404 })
  }

  const d          = draftSnap.data() as Record<string, unknown>
  const details    = (d.eventDetails    as Record<string, unknown>) ?? {}
  const seo        = (details.seo       as Record<string, unknown>) ?? {}
  const pricing    = (d.pricing         as Record<string, unknown>) ?? {}
  const sched      = (details.schedule  as Record<string, unknown>) ?? {}
  const venue      = (details.venue     as Record<string, unknown>) ?? {}
  const phys       = (venue.physical    as Record<string, unknown>) ?? {}
  const online     = (venue.online      as Record<string, unknown>) ?? {}
  const slug       = typeof seo.urlSlug === 'string' && seo.urlSlug ? seo.urlSlug : null

  // ── 4. Load registration counter for pass capacity validation ─────────────
  let passCounts: Record<string, number> = {}
  if (slug) {
    const counterSnap = await adminDb.collection('registrationCounters').doc(slug).get()
    if (counterSnap.exists) {
      passCounts = (counterSnap.data() as { passCounts?: Record<string, number> }).passCounts ?? {}
    }
  }

  // ── 5. Build update objects ────────────────────────────────────────────────
  const draftUpdate: Record<string, unknown> = {
    updatedAt: FieldValue.serverTimestamp(),
    updatedBy: uid,
  }
  const eventUpdate: Record<string, unknown> = {
    updatedAt: FieldValue.serverTimestamp(),
    updatedBy: uid,
  }

  function set(key: string, value: unknown) {
    draftUpdate[key] = value
    eventUpdate[key] = value
  }

  // Track which impactful fields (schedule / venue) actually changed
  const impactfulChanges: string[] = []

  function setImpactful(key: string, firestorePath: string, newVal: string, current: string | null) {
    const trimmed = newVal.trim()
    set(firestorePath, trimmed)
    if (trimmed !== (current ?? '')) impactfulChanges.push(key)
  }

  // ── 6a. Basic info ─────────────────────────────────────────────────────────
  if (payload.name      !== undefined) set('eventDetails.info.name',      payload.name.trim())
  if (payload.tagline   !== undefined) set('eventDetails.info.tagline',   payload.tagline.trim())
  if (payload.shortDesc !== undefined) set('eventDetails.info.shortDesc', payload.shortDesc.trim())
  if (payload.fullDesc  !== undefined) set('eventDetails.info.fullDesc',  payload.fullDesc.trim())

  if (payload.bannerUrl !== undefined) {
    set('eventDetails.media.coverBanner.value', payload.bannerUrl.trim())
    set('eventDetails.media.coverBanner.source', 'url')
  }
  if (payload.logoUrl !== undefined) {
    set('eventDetails.media.logo.value', payload.logoUrl.trim())
    set('eventDetails.media.logo.source', 'url')
  }

  // ── 6b. Schedule — impactful ───────────────────────────────────────────────
  if (payload.startDate !== undefined) {
    setImpactful('startDate', 'eventDetails.schedule.startDate', payload.startDate, s(sched.startDate))
  }
  if (payload.startTime !== undefined) {
    setImpactful('startTime', 'eventDetails.schedule.startTime', payload.startTime, s(sched.startTime))
  }
  if (payload.endDate !== undefined) {
    setImpactful('endDate', 'eventDetails.schedule.endDate', payload.endDate, s(sched.endDate))
  }
  if (payload.endTime !== undefined) {
    setImpactful('endTime', 'eventDetails.schedule.endTime', payload.endTime, s(sched.endTime))
  }
  if (payload.timezone !== undefined) {
    set('eventDetails.schedule.timezone', payload.timezone.trim())
  }

  // ── 6c. Venue — impactful ─────────────────────────────────────────────────
  if (payload.venueType !== undefined) {
    setImpactful('venueType', 'eventDetails.venue.type', payload.venueType, s(venue.type))
  }
  if (payload.venueName !== undefined) {
    setImpactful('venueName', 'eventDetails.venue.physical.name', payload.venueName, s(phys.name))
  }
  if (payload.venueCity !== undefined) {
    setImpactful('venueCity', 'eventDetails.venue.physical.city', payload.venueCity, s(phys.city))
  }
  if (payload.venueAddress !== undefined) {
    setImpactful('venueAddress', 'eventDetails.venue.physical.addressLine1', payload.venueAddress, s(phys.addressLine1))
  }
  if (payload.venueState   !== undefined) set('eventDetails.venue.physical.state',   payload.venueState.trim())
  if (payload.venueCountry !== undefined) set('eventDetails.venue.physical.country', payload.venueCountry.trim())
  if (payload.venuePincode !== undefined) set('eventDetails.venue.physical.pincode', payload.venuePincode.trim())
  if (payload.venueMapsLink !== undefined) set('eventDetails.venue.physical.mapsLink', payload.venueMapsLink.trim())
  if (payload.onlinePlatform !== undefined) {
    setImpactful('onlinePlatform', 'eventDetails.venue.online.platform', payload.onlinePlatform, s(online.platform))
  }
  if (payload.onlineMeetingUrl !== undefined) {
    setImpactful('onlineMeetingUrl', 'eventDetails.venue.online.meetingUrl', payload.onlineMeetingUrl, s(online.meetingUrl))
  }

  // ── 6d. Organizer info ─────────────────────────────────────────────────────
  if (payload.organizerName    !== undefined) set('eventDetails.organizer.name',    payload.organizerName.trim())
  if (payload.organizerEmail   !== undefined) set('eventDetails.organizer.email',   payload.organizerEmail.trim())
  if (payload.organizerPhone   !== undefined) set('eventDetails.organizer.phone',   payload.organizerPhone.trim())
  if (payload.organizerWebsite !== undefined) set('eventDetails.organizer.website', payload.organizerWebsite.trim())

  // ── 6e. Speakers / Sponsors / Gallery ─────────────────────────────────────
  if (payload.speakers !== undefined) {
    set('eventDetails.typeDetails.speakers', payload.speakers)
  }
  if (payload.sponsors !== undefined) {
    set('eventDetails.typeDetails.sponsors', payload.sponsors)
  }
  if (payload.galleryImages !== undefined) {
    // Persist as MediaAsset objects to stay compatible with the wizard schema
    const assets = payload.galleryImages.map(url => ({
      source: 'url', value: url, originalFileName: '',
    }))
    set('eventDetails.media.galleryImages', assets)
  }

  // ── 6f. SEO — urlSlug is always locked ───────────────────────────────────
  if (payload.metaTitle       !== undefined) set('eventDetails.seo.metaTitle',       payload.metaTitle.trim())
  if (payload.metaDescription !== undefined) set('eventDetails.seo.metaDescription', payload.metaDescription.trim())
  if (payload.keywords        !== undefined) set('eventDetails.seo.keywords',        payload.keywords.map(k => k.trim()).filter(Boolean))

  // ── 6g. Pass capacity updates ──────────────────────────────────────────────
  if (payload.passCapacityUpdates && payload.passCapacityUpdates.length > 0) {
    const rawPasses  = Array.isArray(pricing.passes) ? (pricing.passes as Record<string, unknown>[]) : []
    const newPasses  = rawPasses.map(pass => {
      const pid  = pass.id as string
      const upd  = payload.passCapacityUpdates!.find(u => u.passId === pid)
      if (!upd) return pass

      const sold = passCounts[pid] ?? 0
      if (upd.newCapacity !== null && upd.newCapacity < sold) {
        throw new RangeError(
          `Pass "${pass.name}" capacity (${upd.newCapacity}) cannot be less than sold count (${sold})`,
        )
      }
      return { ...pass, unlimited: upd.newCapacity === null, quantity: upd.newCapacity }
    })
    draftUpdate['pricing.passes'] = newPasses
    eventUpdate['pricing.passes'] = newPasses
  }

  // ── 7. Atomic batch update ─────────────────────────────────────────────────
  try {
    const batch = adminDb.batch()
    batch.update(draftRef, draftUpdate)

    if (slug && d.status === 'published') {
      const eventRef  = adminDb.collection('events').doc(slug)
      const eventSnap = await eventRef.get()
      if (eventSnap.exists) {
        batch.update(eventRef, eventUpdate)
      }
    }

    await batch.commit()
  } catch (err) {
    if (err instanceof RangeError) {
      return NextResponse.json({ success: false, error: err.message }, { status: 400 })
    }
    console.error('[edit] Failed to save:', err)
    return NextResponse.json({ success: false, error: 'Failed to save changes' }, { status: 500 })
  }

  // ── 8. Write change log for impactful changes (fire-and-forget) ────────────
  // Future email notification system can query events/{slug}/changeLog
  if (impactfulChanges.length > 0 && slug && d.status === 'published') {
    adminDb
      .collection('events').doc(slug)
      .collection('changeLog').add({
        changedFields: impactfulChanges,
        changedAt:     FieldValue.serverTimestamp(),
        changedBy:     uid,
      })
      .catch(err => console.error('[edit] Failed to write change log:', err))
  }

  return NextResponse.json({ success: true })
}
