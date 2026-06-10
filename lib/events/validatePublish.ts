// Server-side publish validation. Never exposed to the client.
// Called by the /api/events/publish route before any status change.

import type { PublishValidationResult } from '@/types/events'

// Minimal shape we expect from a Firestore draft document
interface DraftSnapshot {
  status:               string
  pricing:              Record<string, unknown> | null
  eventDetails:         Record<string, unknown> | null
  communicationBilling: Record<string, unknown> | null | undefined
  registrationForm:     Record<string, unknown> | null | undefined
}

export function validateEventPublish(draft: DraftSnapshot): PublishValidationResult {
  // Guard: already published
  if (draft.status === 'published') {
    return { canPublish: false, reason: 'EVENT_ALREADY_PUBLISHED' }
  }

  // ── Required event detail fields ───────────────────────────────────────────
  const pricing   = draft.pricing
  const details   = draft.eventDetails
  const info      = (details?.info      as Record<string, unknown> | null | undefined) ?? null
  const venue     = (details?.venue     as Record<string, unknown> | null | undefined) ?? null
  const schedule  = (details?.schedule  as Record<string, unknown> | null | undefined) ?? null
  const organizer = (details?.organizer as Record<string, unknown> | null | undefined) ?? null
  const passes    = Array.isArray(pricing?.passes) ? (pricing!.passes as unknown[]) : []

  const hasName      = typeof info?.name === 'string' && info.name.trim().length > 0
  const hasVenueType = typeof venue?.type === 'string' && venue.type.trim().length > 0
  const hasDates     = typeof schedule?.startDate === 'string' && schedule.startDate.trim().length > 0
  const hasPasses    = passes.length > 0
  const hasOrganizer = typeof organizer?.name === 'string' && organizer.name.trim().length > 0

  // Physical / hybrid events must have a named venue — type alone is not enough
  const venueType    = typeof venue?.type === 'string' ? venue.type : ''
  const physical     = (venue?.physical as Record<string, unknown> | null | undefined) ?? null
  const hasVenueName = ['physical', 'hybrid'].includes(venueType)
    ? typeof physical?.name === 'string' && physical.name.trim().length > 0
    : true   // online events have no physical address requirement

  if (!hasName || !hasVenueType || !hasDates || !hasPasses || !hasOrganizer || !hasVenueName) {
    return { canPublish: false, reason: 'INCOMPLETE_REQUIRED_FIELDS' }
  }

  // ── Registration form must have a template or at least one field section ───
  const rf         = draft.registrationForm as Record<string, unknown> | null | undefined
  const rfTemplate = typeof rf?.template === 'string' ? (rf.template as string) : ''
  const rfSections = Array.isArray(rf?.sections) ? (rf.sections as unknown[]) : []
  const hasForm    = rfTemplate.length > 0 || rfSections.length > 0

  if (!hasForm) {
    return { canPublish: false, reason: 'INCOMPLETE_REQUIRED_FIELDS' }
  }

  // ── Timezone must be a valid IANA name ─────────────────────────────────────
  const tz = typeof schedule?.timezone === 'string' ? schedule.timezone.trim() : ''
  if (tz) {
    try {
      Intl.DateTimeFormat(undefined, { timeZone: tz })
    } catch {
      return { canPublish: false, reason: 'INVALID_TIMEZONE' }
    }
  }

  // Communication billing is now handled at the publish API level:
  // — Paid events: charges deducted from settlement (no gate here).
  // — Free events: wallet balance checked atomically in the publish transaction.

  return { canPublish: true }
}
