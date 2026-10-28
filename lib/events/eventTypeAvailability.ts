// RD-EVENT-TYPES-01 — which event types organizers may choose for a NEW event. PURE (client + server).
//
// The runtime switches live in `platformSettings/eventTypes` (Super Admin, audited, no deploy needed —
// lib/events/eventTypeAvailabilityServer.ts). A type with no stored switch uses the default below.
//
// What "unavailable" means (owner decision 2026-10-28, strict):
//   • it cannot be chosen for a new draft, a draft cannot be switched to it, and an event of that
//     type cannot be duplicated (each is a new event of that type) — refused by the server;
//   • a draft that already has the type stays saved and editable, but it cannot be SUBMITTED for the
//     first time until the type is enabled again;
//   • events already submitted or published keep every existing workflow (review, resubmit,
//     republish, edits, registrations…) — availability never applies to them.
// The wizard shows an unavailable type as "Coming Soon" and does not let it be selected.

export const EVENT_TYPE_IDS = [
  'conference', 'exhibition', 'sports', 'workshop', 'meetup', 'community', 'cultural', 'awards', 'fundraising', 'custom',
] as const
export type EventTypeId = typeof EVENT_TYPE_IDS[number]

/** Launch defaults: three types on, the rest "Coming Soon". */
export const DEFAULT_EVENT_TYPE_AVAILABILITY: Readonly<Record<EventTypeId, boolean>> = {
  sports: true, custom: true, fundraising: true,
  conference: false, exhibition: false, workshop: false, meetup: false, community: false, cultural: false, awards: false,
}

export type EventTypeAvailability = Record<EventTypeId, boolean>

export const isEventTypeId = (v: unknown): v is EventTypeId =>
  typeof v === 'string' && (EVENT_TYPE_IDS as readonly string[]).includes(v)

/** The effective switches: the stored `enabled` map over the defaults (only known ids, only booleans). */
export function resolveEventTypeAvailability(stored: unknown): EventTypeAvailability {
  const out: EventTypeAvailability = { ...DEFAULT_EVENT_TYPE_AVAILABILITY }
  const enabled = stored && typeof stored === 'object' ? (stored as { enabled?: unknown }).enabled : undefined
  if (enabled && typeof enabled === 'object') {
    for (const [k, v] of Object.entries(enabled as Record<string, unknown>)) if (isEventTypeId(k) && typeof v === 'boolean') out[k] = v
  }
  return out
}

/**
 * May an event of `type` be newly chosen / first submitted? No type yet (null / empty) is not a
 * choice and is allowed; an unknown id is refused (it is not in the catalog the wizard offers).
 */
export function isEventTypeAvailable(a: EventTypeAvailability, type: unknown): boolean {
  if (type === null || type === undefined || type === '') return true
  return isEventTypeId(type) && a[type] === true
}

export const EVENT_TYPE_UNAVAILABLE_CODE = 'EVENT_TYPE_UNAVAILABLE'
export const EVENT_TYPE_UNAVAILABLE_MESSAGE =
  'This event type is coming soon and is not available yet. Choose another event type.'
export const EVENT_TYPE_SUBMIT_UNAVAILABLE_MESSAGE =
  'This event type is coming soon, so the event cannot be submitted yet. Your draft is saved; you can submit it once RegisterDesk enables this event type, or choose another event type.'
