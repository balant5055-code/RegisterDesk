// RD-EVENT-16 · which sections of the Event Command Center this event actually has.
//
// PURE — no React, no Firestore, no network. One function decides tab visibility, and the
// tab bar, the More menu, the routing fallback and the Command Palette all call it.
//
// ═══ THE PROBLEM ═════════════════════════════════════════════════════════════
// `EVENT_TABS` carried three flags — `sportsOnly`, `exhibitionOnly`, `awardsOnly` — and
// `sportsOnly` was set on nothing. So an event showed "Waitlist" whether or not it had a
// waitlist, "Speakers" whether or not it accepted speaker applications, and the same list
// regardless of what the organizer had actually configured. The filter was ALSO duplicated
// inline in `lib/commandPalette/registry.ts`, so the two could drift.
//
// ═══ WHAT THIS DOES NOT DO ═══════════════════════════════════════════════════
// It does not invent a capability model. Every rule below cites the source of truth that
// already existed:
//
//   · feature flag + team permission  →  `ITEM_GATES` / `gateState` (lib/eventSetup/readiness)
//   · the waitlist switch             →  `resolveWaitlistSettings` (RD-EVENT-15A)
//   · speaker / sponsor applications  →  `eventDetails.applications.{speaker,sponsor}.enabled`,
//                                        the exact condition the PUBLIC event page uses to
//                                        decide whether to offer the form
//   · exhibition / nominations        →  the event-type flags already on `EVENT_TABS`
//
// ═══ AND IT IS NOT A SECURITY BOUNDARY ═══════════════════════════════════════
// Every route re-checks server-side. Hiding a tab removes a door that would slam; it does
// not lock anything. That is why an unknown permission state stays OPTIMISTIC (see below).

import { gateState, type GateContext } from '@/lib/eventSetup/readiness'
import { resolveWaitlistSettings } from '@/lib/waitlist/waitlistSettings'
import type { EventTabDef, EventTabKey } from './eventTabs'

/**
 * Everything a visibility decision needs, and nothing more.
 *
 * Deliberately a narrow structural type rather than `EventDetailResponse`: it keeps this
 * module testable with a three-line literal, and it makes the inputs the audit found
 * explicit at the call site.
 */
export interface EventCapabilityContext {
  eventType:       string | null
  /** Flattened by the detail route from `registrationForm.registrationRules`. */
  registrationRules: Record<string, unknown> | null
  /** `eventDetails.applications` — the config the public page reads. */
  applications:    EventApplicationsConfig | null
  gate:            GateContext
}

export interface EventApplicationsConfig {
  speaker?: { enabled?: unknown } | null
  sponsor?: { enabled?: unknown } | null
}

/**
 * Tabs whose visibility is decided ONLY by a workspace feature flag and a team
 * permission — the pairing `ITEM_GATES` already defines for the Setup Center.
 *
 * The key on the right is the `ITEM_GATES` key, which is not always the tab key: the
 * `sports` tab is labelled "Identifiers" and gates on `identifiers`.
 */
const GATE_KEY_FOR_TAB: Partial<Record<EventTabKey, string>> = {
  registrations:  'registrations',
  passes:         'passes',
  coupons:        'coupons',
  waitlist:       'waitlist',
  attendance:     'checkin',
  sports:         'identifiers',
  communications: 'communications',
  certificates:   'certificates',
  reports:        'reports',
}

/**
 * Is this event's waitlist switched on?
 *
 * RD-EVENT-15A made `registrationForm.registrationRules.waitlistEnabled` canonical and
 * `resolveWaitlistSettings` the only reader. The detail payload flattens the rules object
 * onto `registrationRules`, so it is re-nested here rather than re-implemented — the UI
 * must never grow a second definition of "the waitlist is on".
 */
export function eventHasWaitlist(registrationRules: Record<string, unknown> | null): boolean {
  return resolveWaitlistSettings({ registrationForm: { registrationRules } }).enabled
}

/** The exact condition `app/events/[slug]/page.tsx` uses before offering the public form. */
function applicationsOpen(cfg: EventApplicationsConfig | null, which: 'speaker' | 'sponsor'): boolean {
  return cfg?.[which]?.enabled === true
}

/** The event-type flags `EVENT_TABS` declares. Structural, so a non-tab can present them. */
export type EventTypeFlags = Pick<EventTabDef, 'sportsOnly' | 'exhibitionOnly' | 'awardsOnly'>

/**
 * Does this event's TYPE admit a capability carrying these flags?
 *
 * The one place the `sportsOnly` / `exhibitionOnly` / `awardsOnly` rule is written. It was
 * inlined in `isEventTabAvailable`; it is lifted out so a capability that is NOT a tab —
 * Race Operations is a standalone route — can apply the identical rule instead of growing
 * an `isSportsEvent()` of its own. An unknown type (`null`) admits nothing type-restricted:
 * a sports-only capability is offered because the event SAYS it is a sports event.
 */
export function isEventTypeApplicable(flags: EventTypeFlags, eventType: string | null): boolean {
  if (flags.sportsOnly     && eventType !== 'sports')     return false
  if (flags.exhibitionOnly && eventType !== 'exhibition') return false
  if (flags.awardsOnly     && eventType !== 'awards')     return false
  return true
}

/**
 * RD-RACEOPS-02B · may Race Operations (publish results, history, finisher badges) be
 * offered for this event?
 *
 * A thin adapter over the rule above, presenting the `sportsOnly` flag `EVENT_TABS` declares
 * (declared on the tab type; no tab sets it today, so this is its first live use): Race
 * Operations applies to exactly the events the platform already calls sports events —
 * every sports subtype, because the result pipeline is one elapsed time per identifier per
 * pass and serves running, cycling, swimming and triathlon alike at that level. It deliberately does NOT consult `identifierConfigs` or
 * timing-tag configuration: bibs reach `registrations.bibNumber` through the identifiers
 * engine's legacy mirror as well, and the start-list verification already fails closed
 * when an event has no bibs. Not a security boundary on its own — every Race Operations
 * route re-applies it server-side through `resolveRace` / `resolveRaceOpsEvent`.
 */
export function isRaceOperationsAvailable(eventType: string | null | undefined): boolean {
  return isEventTypeApplicable({ sportsOnly: true }, eventType ?? null)
}

/**
 * Should this tab appear for this event?
 *
 * `true` for anything with no capability signal — a tab is hidden because something
 * SAYS it does not apply, never because nothing said it did.
 */
export function isEventTabAvailable(
  tab: EventTabDef,
  ctx: EventCapabilityContext,
): boolean {
  // 1. Workspace feature flag + team permission, from the existing gate table.
  const gateKey = GATE_KEY_FOR_TAB[tab.key]
  if (gateKey && gateState(gateKey, ctx.gate) !== null) return false

  // 2. Event-type applicability — the flags `EVENT_TABS` already declared.
  if (!isEventTypeApplicable(tab, ctx.eventType)) return false

  // 3. Per-event configuration.
  switch (tab.key) {
    // The organizer's own switch. A disabled waitlist is not an empty waitlist — there is
    // nothing to manage and nothing to join, so the tab is absent rather than a dead end.
    // It is turned on where it is configured: Settings → registration form.
    case 'waitlist':
      return eventHasWaitlist(ctx.registrationRules)

    // These tabs REVIEW submissions to a public form. If the event never offers the form,
    // there is nothing to review — and the public page uses this exact condition.
    case 'speaker-applications': return applicationsOpen(ctx.applications, 'speaker')
    case 'sponsor-applications': return applicationsOpen(ctx.applications, 'sponsor')

    default:
      return true
  }
}

/** Filter a tab list. The ONE place the bar, the More menu and the palette agree. */
export function visibleEventTabs(
  tabs: readonly EventTabDef[],
  ctx: EventCapabilityContext,
): EventTabDef[] {
  return tabs.filter(t => isEventTabAvailable(t, ctx))
}

/**
 * Is a `?tab=` value usable for this event right now?
 *
 * Used by the shell to decide whether a direct URL resolves to the tab or falls back to
 * the Event Command Center. `null` (the root) is always usable.
 */
export function isEventTabReachable(
  key: EventTabKey | null,
  tabs: readonly EventTabDef[],
  ctx: EventCapabilityContext,
): boolean {
  if (key === null) return true
  const def = tabs.find(t => t.key === key)
  return def ? isEventTabAvailable(def, ctx) : false
}

/**
 * Tabs with NO cheap capability signal, kept universally visible on purpose.
 *
 * Documented here rather than left implicit, because "we chose not to gate this" and "we
 * forgot to gate this" look identical in code.
 *
 *   conference   — the agenda. Sessions live in their own collection; whether an event has
 *                  one cannot be known without a read, and the tab bar must not make one.
 *                  Gating on `eventType === 'conference'` was rejected: workshops, cultural
 *                  events and sports events all run agendas.
 *   sports       — "Identifiers". Configuration lives in `identifierConfigs/{slug}`, again
 *                  a read. Bibs, badge numbers and seat numbers are not sports-specific.
 *   setup        — the place capabilities are turned on. Hiding it could strand an event.
 *   settings     — same, and it is where the waitlist switch is reached.
 *   registrations, passes, reports, attendance, communications, certificates, coupons —
 *                  gated by flag/permission only; every event can have them.
 */
export const UNGATED_BY_DESIGN: readonly EventTabKey[] = [
  'setup', 'settings', 'conference', 'sports',
]
