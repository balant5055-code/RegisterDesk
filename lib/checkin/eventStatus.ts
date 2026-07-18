// Shared event-state guard used by all check-in API routes.
//
// Allowed states for check-in:
//   'published'           — event live, registrations open
//   'registration_closed' — registrations ended but event happening
//   'completed'           — event over; late arrivals / record-keeping allowed
//
// Explicitly rejected:
//   'draft'        — never published
//   'unpublished'  — pulled back from publication
//   'cancelled'    — event called off
//   'archived'     — retired event
//   (any other)    — unknown state → fail closed

import { adminDb } from '@/lib/firebase/admin'
import { isContentTakenDown } from '@/lib/admin/moderation'
import type { ModerationStatus } from '@/lib/admin/moderation'

export type EventCheckInStatus = 'ok' | 'not_found' | 'not_accepting'

const ACCEPTING_STATUSES = new Set(['published', 'registration_closed', 'completed'])

/**
 * Looks up the event document by slug and returns whether it is in a state
 * that accepts check-ins.
 *
 * 'not_found'    → event doc absent (data integrity issue or slug mismatch)
 * 'not_accepting' → doc exists but lifecycleStatus is not in the allowed set,
 *                   OR the event has been taken down by moderation
 * 'ok'           → check-in is permitted
 *
 * The moderation guard mirrors the registration gate (lib/registrations/gate.ts,
 * isContentTakenDown): a takedown halts the whole event, so check-in and walk-in
 * must stop too — not only new registrations. Takedown sets moderationStatus
 * without touching lifecycleStatus, so it needs its own check here.
 */
export async function getEventCheckInStatus(eventSlug: string): Promise<EventCheckInStatus> {
  const snap = await adminDb.collection('events').doc(eventSlug).get()
  if (!snap.exists) return 'not_found'
  const data = snap.data() as Record<string, unknown>
  if (isContentTakenDown(data.moderationStatus as ModerationStatus | undefined)) return 'not_accepting'
  const ls = data.lifecycleStatus as string | undefined
  return ls && ACCEPTING_STATUSES.has(ls) ? 'ok' : 'not_accepting'
}
