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

// ─── Dashboard exclusion (RD-DASHBOARD-05) ────────────────────────────────────
//
// THE INVARIANT THIS ESTABLISHES:
//
//     eventInListingTab(event, 'archived') === true
//         ⇒  the event contributes NOTHING to organizer dashboard analytics
//
// Why it lives here and not in the dashboard: the "Archived" tab is a bucket for FOUR
// terminal states (completed | cancelled | archived | unpublished), and that grouping is
// defined directly above. A dashboard that re-listed those states would be a second copy
// destined to drift the next time a lifecycle state is added — which is exactly how an
// `unpublished` event kept feeding Pass Distribution and Event Performance while sitting
// under the Archived tab in the UI. Deriving the answer FROM `listingTabsForEvent` means the
// tab and the dashboard can never disagree again.
//
// NOTE the deliberate distinction from `isArchivedEvent`: that predicate means the genuine,
// permanent `archived` state and gates permanent DELETION. This one means "shown under the
// Archived tab" and gates dashboard VISIBILITY. An unpublished event is excluded from the
// dashboard but must stay editable, restorable and NOT permanently deletable.

import { deriveLifecycleStatus, isArchivedEvent } from './lifecycleStateMachine'

/**
 * The lifecycle status a raw event-draft document should be treated as.
 *
 * `deriveLifecycleStatus` alone cannot report 'archived' for an event archived before
 * `lifecycleStatus` existed — archiving also writes the legacy `status: 'draft'`, so the
 * derivation returns that instead. Consulting `isArchivedEvent` first closes that gap, and
 * doing it in ONE place keeps the tab filter, the serialized payload and the dashboard scope
 * reading the same value.
 */
export function effectiveLifecycleStatus(d: Record<string, unknown>): EventLifecycleStatus {
  return isArchivedEvent(d) ? 'archived' : deriveLifecycleStatus(d)
}

/** True when this event is shown under the Events "Archived" tab. */
export function isArchivedTabEvent(d: Record<string, unknown>): boolean {
  return listingTabsForEvent(effectiveLifecycleStatus(d)).includes('archived')
}
