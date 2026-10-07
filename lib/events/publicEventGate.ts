// ─── May the public see this event? The rule, with nothing attached ──────────
//
// PURE + isomorphic: no Firebase import, so it is safe from server components, route
// handlers and bootless unit tests alike — the same reason publicVisibility.ts is written
// this way. The fetching half lives in publicEventAccess.ts, which does import
// firebase-admin; keeping the DECISION separate from the READ is what lets the decision be
// tested directly instead of through a mock.
//
// ═══ THE THREE CONDITIONS ════════════════════════════════════════════════════
//   1. the event exists
//   2. canExposePublicEvent(lifecycleStatus) — an ALLOW-list, so a draft, an archived event
//      or any state nobody has invented yet is not public by default
//   3. not taken down by admin moderation
//
// ═══ WHY visibility: 'private' IS ABSENT ═════════════════════════════════════
// Deliberate. A private event is INVITE-ONLY, not hidden: it stays reachable by its link
// because that is how an invitee registers at all. It is withheld from discovery listings
// and from the sitemap, and its detail page sets robots noindex/nofollow. Adding it here
// would 404 every invited guest — a product regression wearing the costume of a security
// fix. Lifecycle and moderation are the public boundary; visibility governs LISTING.

import { canExposePublicEvent } from '@/lib/events/publicVisibility'
import { isContentTakenDown } from '@/lib/admin/moderation'
import type { EventLifecycleStatus } from '@/types/events'
import type { ModerationStatus } from '@/lib/admin/moderation'

/** The fields the gate reads — anything event-shaped satisfies it. */
export interface PublicGateSubject {
  lifecycleStatus?:  EventLifecycleStatus | null
  moderationStatus?: ModerationStatus | null
}

/**
 * True when the public may see this event.
 *
 * Written as a type guard so a route can narrow `Event | null` to `Event` with the same
 * call that enforces the rule.
 */
export function isPubliclyViewable<T extends PublicGateSubject>(event: T | null | undefined): event is T {
  if (!event) return false
  if (!canExposePublicEvent(event.lifecycleStatus)) return false
  if (isContentTakenDown(event.moderationStatus)) return false
  return true
}
