// lib/finance/viewScope.ts
// RD-FIN-SCOPE-01 — how /dashboard/finance turns the GLOBAL Event Selector into the scope of its
// event-scoped sections. PURE (no React, no fetch) so the rules are unit-testable; client-safe.
//
// The selector (components/dashboard/EventContextProvider → lib/events/eventContext
// resolveSelectedEvent) is the only source of truth. Finance keeps no event state of its own.

import { ALL_EVENTS_SELECTION } from '@/lib/events/eventContext'

export type FinanceViewScope = { kind: 'all' } | { kind: 'event'; eventId: string; name: string }

export interface SelectorSnapshot {
  loading:         boolean
  urlEventMissing: boolean
  selectedEventId: string | null
  isAllEvents:     boolean
  selectedEventName: string | null
}

/**
 * The scope the Finance sections show, or null while it cannot be known:
 *   • the selector is still loading                     → null (nothing is fetched yet)
 *   • the URL named an event this workspace cannot see   → null (an "unavailable" state —
 *                                                           NEVER a fall-back to all events)
 *   • one event selected                                 → that event
 *   • All events (or an empty workspace, nothing to pick) → all events
 */
export function financeViewScope(s: SelectorSnapshot): FinanceViewScope | null {
  if (s.loading || s.urlEventMissing) return null
  if (s.selectedEventId && !s.isAllEvents) return { kind: 'event', eventId: s.selectedEventId, name: s.selectedEventName ?? 'Selected event' }
  return { kind: 'all' }
}

/** The `eventId` request parameter for a scope (the server resolves and authorizes it). */
export function financeScopeParam(scope: FinanceViewScope | null): string | null {
  return scope ? (scope.kind === 'event' ? scope.eventId : ALL_EVENTS_SELECTION) : null
}

/**
 * "Only the latest request may write." Each request takes a ticket; a response whose ticket is no
 * longer the latest is dropped — so after a switch from Event A to Event B, a slow response for A
 * can never paint A's figures under B's name.
 */
export function createLatestGate(): { take(): number; isLatest(ticket: number): boolean } {
  let latest = 0
  return { take: () => ++latest, isLatest: t => t === latest }
}
