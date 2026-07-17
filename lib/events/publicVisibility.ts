// Single source of truth for whether an event may be exposed on ANY public
// surface (event detail page, speaker/sponsor application, calendar feed,
// public session schedule, …).
//
// SECURITY MODEL — ALLOW-LIST, not deny-list. Only the lifecycle states listed
// here are ever publicly accessible. Every other value — unrecognised states AND
// any lifecycle state added in the future — is treated as NOT public, so a new
// state can never leak to the public web by default. This replaces the former
// per-route deny-lists (which blocked a fixed set and allowed everything else).
//
// PURE + isomorphic: no Firebase import, so it is safe to call from server
// components, route handlers, and tests alike.

import type { EventLifecycleStatus } from '@/types/events'

// The exact set that is publicly visible TODAY — unchanged runtime behaviour:
//   published, registration_closed, completed → live / post-event pages
//   cancelled                                 → still shows its cancellation notice
const PUBLICLY_VISIBLE_STATUSES: ReadonlySet<EventLifecycleStatus> = new Set<EventLifecycleStatus>([
  'published',
  'registration_closed',
  'completed',
  'cancelled',
])

/**
 * True when an event in this lifecycle state may be shown publicly.
 *
 * Accepts the raw stored value (string | null | undefined) so callers can pass
 * `event.lifecycleStatus` directly. Anything not in the allow-list — including
 * undefined and any future lifecycle state — returns false (fail-closed, so the
 * caller returns its existing not-found / 404 response).
 */
export function canExposePublicEvent(lifecycleStatus: string | null | undefined): boolean {
  return typeof lifecycleStatus === 'string'
    && PUBLICLY_VISIBLE_STATUSES.has(lifecycleStatus as EventLifecycleStatus)
}
