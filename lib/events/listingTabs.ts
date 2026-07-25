// Shared, PURE My-Events listing-tab mapping — NO Firebase import, safe on client AND server.
//
// RD-EVENTS-01 Phase 2 (H2): the organizer Events LISTING groups events into tabs by
// lifecycle. This mapping is the SINGLE source of truth for that grouping — the listing
// API (app/api/organizer/events) filters by it server-side (authoritative, over the whole
// organizer dataset) and the client (EventsClient) labels the same tabs. Keeping it here
// prevents a second, divergent client-only filter. (Distinct from lib/events/eventTabs.ts,
// which lists the per-event MANAGE tabs — a different concept.)

import type { EventLifecycleStatus } from '@/types/events'

export type EventListingTabKey = 'active' | 'published' | 'drafts' | 'archived'

export const EVENT_LISTING_TAB_KEYS: readonly EventListingTabKey[] =
  ['active', 'published', 'drafts', 'archived']

/** Narrow an untrusted query-param string to a valid tab key (else null = no tab filter). */
export function parseListingTab(value: string | null | undefined): EventListingTabKey | null {
  return value && (EVENT_LISTING_TAB_KEYS as readonly string[]).includes(value)
    ? (value as EventListingTabKey)
    : null
}

// An event may appear in multiple tabs (e.g. published → both 'active' and 'published').
//   Active    : published | registration_closed | pending_review  (currently in-flight)
//   Published : published only                                    (open for registration)
//   Drafts    : draft | changes_requested
//   Archived  : completed | cancelled | archived | unpublished
export function listingTabsForEvent(ls: EventLifecycleStatus): EventListingTabKey[] {
  switch (ls) {
    case 'published':            return ['active', 'published']
    case 'registration_closed':  return ['active']
    case 'pending_review':       return ['active']
    case 'changes_requested':    return ['drafts']
    case 'draft':                return ['drafts']
    case 'completed':
    case 'cancelled':
    case 'archived':             return ['archived']
    // Recognition only (Phase L2): a taken-offline event is inactive, NOT a draft.
    // Grouped with archived so it can never fall into the 'drafts' default.
    case 'unpublished':          return ['archived']
    default:                     return ['drafts']
  }
}

/** True when an event (by lifecycle) belongs to the given tab. tab === null ⇒ no filter. */
export function eventInListingTab(ls: EventLifecycleStatus, tab: EventListingTabKey | null): boolean {
  return tab === null || listingTabsForEvent(ls).includes(tab)
}
