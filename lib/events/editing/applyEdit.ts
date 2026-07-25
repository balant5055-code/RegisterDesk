// RD-PRODUCT-01F — pure builder for a post-publish content edit.
//
// Translates an EventEditPayload into the Firestore field-path updates written to BOTH
// the draft and the live events/{slug} doc, mirroring the mapping the edit route has
// always used. Extracted here (pure, no Firebase) so the edit route AND the rollback
// route apply the EXACT same mapping — a rollback is just re-applying a prior payload.
//
// It NEVER writes to orders, payments, snapshots, registrations, tickets, QR, coupons,
// wallet or finance — those fields are not in EventEditPayload and are rejected upstream
// by fieldClassification. Pass capacity can only rise to / stay at ≥ its sold count.

import type { EventEditPayload } from '@/types/events'
import { IMPACTFUL_EDIT_KEYS } from './fieldClassification'

const s = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)

export interface EditUpdateResult {
  /** Field-path → value map for the draft doc (excludes server metadata). */
  updates:         Record<string, unknown>
  /** Keys from the payload that were present (the changed field names). */
  changedFields:   string[]
  /** The attendee-impactful subset that actually changed value. */
  impactfulFields: string[]
}

/**
 * Build the flat field-path update map for `payload` against the current draft data.
 * `passCounts` (passId → sold) enforces the capacity floor. Throws RangeError if a pass
 * capacity would fall below its sold count. Pure.
 */
export function buildEventEditUpdate(
  payload:    EventEditPayload,
  draftData:  Record<string, unknown>,
  passCounts: Record<string, number>,
): EditUpdateResult {
  const details = (draftData.eventDetails as Record<string, unknown>) ?? {}
  const pricing = (draftData.pricing as Record<string, unknown>) ?? {}
  const sched   = (details.schedule as Record<string, unknown>) ?? {}
  const venue   = (details.venue    as Record<string, unknown>) ?? {}
  const phys    = (venue.physical   as Record<string, unknown>) ?? {}
  const online  = (venue.online     as Record<string, unknown>) ?? {}

  const updates: Record<string, unknown> = {}
  const changedFields: string[] = []
  const impactfulSet = new Set<string>(IMPACTFUL_EDIT_KEYS)
  const impactfulFields: string[] = []

  const set = (key: string, path: string, value: unknown): void => {
    updates[path] = value
    changedFields.push(key)
  }
  const setImpactful = (key: string, path: string, newVal: string, current: string | null): void => {
    const trimmed = newVal.trim()
    updates[path] = trimmed
    changedFields.push(key)
    if (impactfulSet.has(key) && trimmed !== (current ?? '')) impactfulFields.push(key)
  }

  // Basic info
  if (payload.name      !== undefined) set('name',      'eventDetails.info.name',      payload.name.trim())
  if (payload.tagline   !== undefined) set('tagline',   'eventDetails.info.tagline',   payload.tagline.trim())
  if (payload.shortDesc !== undefined) set('shortDesc', 'eventDetails.info.shortDesc', payload.shortDesc.trim())
  if (payload.fullDesc  !== undefined) set('fullDesc',  'eventDetails.info.fullDesc',  payload.fullDesc.trim())
  if (payload.bannerUrl !== undefined) {
    set('bannerUrl', 'eventDetails.media.coverBanner.value', payload.bannerUrl.trim())
    updates['eventDetails.media.coverBanner.source'] = 'url'
  }
  if (payload.logoUrl !== undefined) {
    set('logoUrl', 'eventDetails.media.logo.value', payload.logoUrl.trim())
    updates['eventDetails.media.logo.source'] = 'url'
  }

  // Schedule — impactful
  if (payload.startDate !== undefined) setImpactful('startDate', 'eventDetails.schedule.startDate', payload.startDate, s(sched.startDate))
  if (payload.startTime !== undefined) setImpactful('startTime', 'eventDetails.schedule.startTime', payload.startTime, s(sched.startTime))
  if (payload.endDate   !== undefined) setImpactful('endDate',   'eventDetails.schedule.endDate',   payload.endDate,   s(sched.endDate))
  if (payload.endTime   !== undefined) setImpactful('endTime',   'eventDetails.schedule.endTime',   payload.endTime,   s(sched.endTime))
  if (payload.timezone  !== undefined) set('timezone', 'eventDetails.schedule.timezone', payload.timezone.trim())

  // Venue — impactful
  if (payload.venueType    !== undefined) setImpactful('venueType',    'eventDetails.venue.type',                 payload.venueType,    s(venue.type))
  if (payload.venueName    !== undefined) setImpactful('venueName',    'eventDetails.venue.physical.name',        payload.venueName,    s(phys.name))
  if (payload.venueCity    !== undefined) setImpactful('venueCity',    'eventDetails.venue.physical.city',        payload.venueCity,    s(phys.city))
  if (payload.venueAddress !== undefined) setImpactful('venueAddress', 'eventDetails.venue.physical.addressLine1', payload.venueAddress, s(phys.addressLine1))
  if (payload.venueState   !== undefined) set('venueState',   'eventDetails.venue.physical.state',    payload.venueState.trim())
  if (payload.venueCountry !== undefined) set('venueCountry', 'eventDetails.venue.physical.country',  payload.venueCountry.trim())
  if (payload.venuePincode !== undefined) set('venuePincode', 'eventDetails.venue.physical.pincode',  payload.venuePincode.trim())
  if (payload.venueMapsLink !== undefined) set('venueMapsLink', 'eventDetails.venue.physical.mapsLink', payload.venueMapsLink.trim())
  if (payload.onlinePlatform   !== undefined) setImpactful('onlinePlatform',   'eventDetails.venue.online.platform',   payload.onlinePlatform,   s(online.platform))
  if (payload.onlineMeetingUrl !== undefined) setImpactful('onlineMeetingUrl', 'eventDetails.venue.online.meetingUrl', payload.onlineMeetingUrl, s(online.meetingUrl))

  // Organizer contact
  if (payload.organizerName    !== undefined) set('organizerName',    'eventDetails.organizer.name',    payload.organizerName.trim())
  if (payload.organizerEmail   !== undefined) set('organizerEmail',   'eventDetails.organizer.email',   payload.organizerEmail.trim())
  if (payload.organizerPhone   !== undefined) set('organizerPhone',   'eventDetails.organizer.phone',   payload.organizerPhone.trim())
  if (payload.organizerWebsite !== undefined) set('organizerWebsite', 'eventDetails.organizer.website', payload.organizerWebsite.trim())

  // Content arrays (full replacement)
  if (payload.speakers !== undefined) set('speakers', 'eventDetails.typeDetails.speakers', payload.speakers)
  if (payload.sponsors !== undefined) set('sponsors', 'eventDetails.typeDetails.sponsors', payload.sponsors)
  if (payload.galleryImages !== undefined) {
    const assets = payload.galleryImages.map(url => ({ source: 'url', value: url, originalFileName: '' }))
    set('galleryImages', 'eventDetails.media.galleryImages', assets)
  }

  // SEO — slug is never editable
  if (payload.metaTitle       !== undefined) set('metaTitle',       'eventDetails.seo.metaTitle',       payload.metaTitle.trim())
  if (payload.metaDescription !== undefined) set('metaDescription', 'eventDetails.seo.metaDescription', payload.metaDescription.trim())
  if (payload.keywords        !== undefined) set('keywords',        'eventDetails.seo.keywords',        payload.keywords.map(k => k.trim()).filter(Boolean))

  // Pass capacity — can only stay ≥ sold count (never corrupts a sold pass)
  if (payload.passCapacityUpdates && payload.passCapacityUpdates.length > 0) {
    const rawPasses = Array.isArray(pricing.passes) ? (pricing.passes as Record<string, unknown>[]) : []
    const newPasses = rawPasses.map(pass => {
      const pid = pass.id as string
      const upd = payload.passCapacityUpdates!.find(u => u.passId === pid)
      if (!upd) return pass
      const sold = passCounts[pid] ?? 0
      if (upd.newCapacity !== null && upd.newCapacity < sold) {
        throw new RangeError(`Pass "${pass.name as string}" capacity (${upd.newCapacity}) cannot be less than sold count (${sold})`)
      }
      return { ...pass, unlimited: upd.newCapacity === null, quantity: upd.newCapacity }
    })
    set('passCapacityUpdates', 'pricing.passes', newPasses)
  }

  return { updates, changedFields, impactfulFields }
}

/**
 * Read the CURRENT value of every editable field from the draft into an EventEditPayload —
 * the "before" snapshot stored on an edit-history record so a later edit can be rolled back.
 * Only reads SAFE content fields; never financial/attendee data.
 */
export function extractEditableSnapshot(draftData: Record<string, unknown>): EventEditPayload {
  const details = (draftData.eventDetails as Record<string, unknown>) ?? {}
  const info    = (details.info    as Record<string, unknown>) ?? {}
  const media   = (details.media   as Record<string, unknown>) ?? {}
  const banner  = (media.coverBanner as Record<string, unknown>) ?? {}
  const logo    = (media.logo      as Record<string, unknown>) ?? {}
  const sched   = (details.schedule as Record<string, unknown>) ?? {}
  const venue   = (details.venue   as Record<string, unknown>) ?? {}
  const phys    = (venue.physical  as Record<string, unknown>) ?? {}
  const online  = (venue.online    as Record<string, unknown>) ?? {}
  const org     = (details.organizer as Record<string, unknown>) ?? {}
  const typeDet = (details.typeDetails as Record<string, unknown>) ?? {}
  const seo     = (details.seo     as Record<string, unknown>) ?? {}

  const str = (v: unknown): string => (typeof v === 'string' ? v : '')
  const gallery = Array.isArray(media.galleryImages)
    ? (media.galleryImages as Record<string, unknown>[]).map(a => str(a?.value)).filter(Boolean)
    : []

  return {
    name: str(info.name), tagline: str(info.tagline), shortDesc: str(info.shortDesc), fullDesc: str(info.fullDesc),
    bannerUrl: str(banner.value), logoUrl: str(logo.value),
    startDate: str(sched.startDate), startTime: str(sched.startTime), endDate: str(sched.endDate),
    endTime: str(sched.endTime), timezone: str(sched.timezone),
    venueType: str(venue.type), venueName: str(phys.name), venueCity: str(phys.city), venueAddress: str(phys.addressLine1),
    venueState: str(phys.state), venueCountry: str(phys.country), venuePincode: str(phys.pincode), venueMapsLink: str(phys.mapsLink),
    onlinePlatform: str(online.platform), onlineMeetingUrl: str(online.meetingUrl),
    organizerName: str(org.name), organizerEmail: str(org.email), organizerPhone: str(org.phone), organizerWebsite: str(org.website),
    speakers: Array.isArray(typeDet.speakers) ? typeDet.speakers as EventEditPayload['speakers'] : undefined,
    sponsors: Array.isArray(typeDet.sponsors) ? typeDet.sponsors as EventEditPayload['sponsors'] : undefined,
    galleryImages: gallery,
    metaTitle: str(seo.metaTitle), metaDescription: str(seo.metaDescription),
    keywords: Array.isArray(seo.keywords) ? (seo.keywords as unknown[]).map(str).filter(Boolean) : [],
  }
}

/** Pick only the given keys from a payload (for the "before"/"after" diff on history). */
export function pickPayload(payload: EventEditPayload, keys: string[]): Partial<EventEditPayload> {
  const out: Record<string, unknown> = {}
  const src = payload as Record<string, unknown>
  for (const k of keys) { if (k in src) out[k] = src[k] }
  return out as Partial<EventEditPayload>
}
