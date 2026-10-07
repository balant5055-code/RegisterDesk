// RD-ANALYTICS-04 · which Analytics modules exist for THIS event. PURE.
//
// ═══ THE RULE THIS ENCODES ═══════════════════════════════════════════════════
// A module is ABSENT because something says it does not apply — never rendered and then
// hidden. Rendering everything and hiding it afterward is how a fundraiser ends up with a
// BIB panel in its DOM, how a conference gets asked about finisher pace, and how a caller
// without `transactions` receives money in a payload that the client politely declines to
// draw. Availability is decided here, before anything is fetched.
//
// ═══ NOTHING HERE IS NEW ═════════════════════════════════════════════════════
// The vocabulary is the product's existing one, reused rather than re-declared:
//
//   ITEM_GATES / gateState   lib/eventSetup/readiness.ts — the workspace feature flag +
//                            team permission pairing the Setup Center already uses
//   eventType                the taxonomy in lib/events/breadcrumbs.ts, gated the way
//                            EVENT_TABS gates sportsOnly / exhibitionOnly / awardsOnly
//   eventHasWaitlist         lib/events/eventCapabilities.ts — the one waitlist reader
//
// No capability is invented. If a module would need a signal the platform does not hold,
// it is not listed — see PARTICIPANTS below, which is the honest case.

import { gateState } from '@/lib/eventSetup/readiness'
import { eventHasWaitlist, type EventCapabilityContext } from '@/lib/events/eventCapabilities'

/** The sections the future Analytics workspace can offer. */
export type AnalyticsModuleKey =
  | 'overview'
  | 'registrations'
  | 'revenue'
  | 'operations'
  | 'communications'
  | 'participants'
  | 'reports'

export interface AnalyticsModuleDef {
  key:   AnalyticsModuleKey
  label: string
  /**
   * The `ITEM_GATES` key this module rides. Absent ⇒ no flag/permission gate of its own.
   * Note this is NOT always the module key: Operations gates on `checkin`.
   */
  gateKey?: string
  /**
   * True when the module's content is money, so it additionally requires `transactions` —
   * the permission /api/organizer/finance and RD-ANALYTICS-02 both use.
   */
  financial?: boolean
  /** Event types this module is exclusive to. Absent ⇒ universal. */
  eventTypes?: readonly string[]
}

/**
 * The module table.
 *
 * ORDER IS THE IA. Overview first because it answers "how is this event doing"; Reports
 * last because it is a different product (documents, not exploration) reached from here.
 */
export const ANALYTICS_MODULES: readonly AnalyticsModuleDef[] = [
  { key: 'overview',       label: 'Overview' },
  { key: 'registrations',  label: 'Registrations',  gateKey: 'registrations' },
  { key: 'revenue',        label: 'Revenue',        financial: true },
  // Operations is attendance: it gates on check-in, not on a module called "operations".
  { key: 'operations',     label: 'Operations',     gateKey: 'checkin' },
  { key: 'communications', label: 'Communications', gateKey: 'communications' },
  /**
   * PARTICIPANTS is listed but is NOT universally available, and the reason is worth
   * stating rather than hiding behind a flag: a registration carries `attendee.{name,
   * email,phone}` and an untyped `formResponses` map. Age, gender and geography exist only
   * where the ORGANIZER added a typed form field for them, so participant analytics is a
   * per-event data question that no existing capability answers. `hasParticipantData`
   * below is therefore an explicit caller-supplied signal, not a guess.
   */
  { key: 'participants',   label: 'Participants' },
  { key: 'reports',        label: 'Reports',        gateKey: 'reports' },
] as const

/**
 * Everything an availability decision needs.
 *
 * Extends the existing `EventCapabilityContext` rather than defining a parallel one, so a
 * caller that already resolved capabilities for the event tab bar can pass the same object.
 */
export interface AnalyticsModuleContext extends EventCapabilityContext {
  /** Does the caller hold `transactions`? Decides every financial module. */
  financeAllowed: boolean
  /**
   * Does the Participants module have anything TRUE to show for this event?
   *
   * RD-ANALYTICS-12-29 · supplied by the route as "the producer measured the registration
   * composition" (seats by source and by status). It is NOT a statement that demographic
   * or identity data exists — the platform has no semantic form-field mapping and no
   * participant identity it can count by, and those keys stay absent in the payload
   * whatever this flag says. Undefined ⇒ treated as no.
   */
  hasParticipantData?: boolean
  /**
   * RD-ANALYTICS-10 · does this event ISSUE identifiers?
   *
   * From `identifierConfigs/{slug}.enabled` — the event's own configuration, never its
   * taxonomy. Undefined ⇒ treated as no, which is the same fail-closed rule
   * `hasParticipantData` follows: a panel appears because something SAYS the capability
   * exists, never because nothing said it did not.
   */
  identifiersEnabled?: boolean
  /**
   * RD-ANALYTICS-10 · does this event use timing chips?
   *
   * From `identifierConfigs/{slug}.tagMapping.enabled`, which is ABSENT on every event
   * predating the feature and therefore off. Deliberately independent of
   * `identifiersEnabled` and of `eventType` — see the panel table.
   */
  timingEnabled?: boolean
}

/**
 * Should this module exist for this event and this caller?
 *
 * Fails CLOSED for money and OPEN for everything else, matching the two rules already in
 * the product: `isEventTabAvailable` treats "no capability signal" as available (a tab is
 * hidden because something SAYS it does not apply), while every financial surface treats a
 * missing permission as a refusal.
 */
export function isAnalyticsModuleAvailable(
  module: AnalyticsModuleDef,
  ctx: AnalyticsModuleContext,
): boolean {
  // 1. Money is never available without the finance permission.
  if (module.financial && !ctx.financeAllowed) return false

  // 2. Workspace feature flag + team permission, from the existing gate table.
  if (module.gateKey && gateState(module.gateKey, ctx.gate) !== null) return false

  // 3. Event-type exclusivity, expressed the way EVENT_TABS expresses it.
  if (module.eventTypes && !module.eventTypes.includes(ctx.eventType ?? '')) return false

  // 4. Per-module data conditions.
  if (module.key === 'participants') return ctx.hasParticipantData === true

  return true
}

/** The modules to offer, in IA order. */
export function availableAnalyticsModules(ctx: AnalyticsModuleContext): AnalyticsModuleDef[] {
  return ANALYTICS_MODULES.filter(m => isAnalyticsModuleAvailable(m, ctx))
}

// ─── Conditional panels INSIDE a module ───────────────────────────────────────
//
// Event-type analytics are panels, not tabs: "finisher pace" belongs inside Operations for
// a sports event, not as a peer of Revenue. Keeping them here means the same gate table
// answers both questions and a future panel cannot invent a third way to ask.

export type AnalyticsPanelKey =
  | 'timing'      // sports — timing/finishers/pace
  | 'identifiers' // BIB / delegate numbers
  | 'certificates'
  | 'coupons'
  | 'waitlist'
  | 'donations'   // fundraising

export interface AnalyticsPanelDef {
  key:        AnalyticsPanelKey
  label:      string
  module:     AnalyticsModuleKey
  gateKey?:   string
  eventTypes?: readonly string[]
}

export const ANALYTICS_PANELS: readonly AnalyticsPanelDef[] = [
  /**
   * RD-ANALYTICS-10 · TIMING IS A CONFIGURATION, NOT A TAXONOMY.
   *
   * ═══ WHAT WAS WRONG ════════════════════════════════════════════════════════
   * This panel carried `eventTypes: ['sports']`, mirroring the restriction the event tab
   * bar applies. That inference is wrong in BOTH directions: a sports event whose organizer
   * never switched timing on was offered a timing panel, and a non-sports event that
   * genuinely issues timing chips — the feature is a per-event switch, available to any
   * event — could never be. Timing chips are used by cycling sportives and by conference
   * badge-tracking alike; the platform stores the capability precisely so nobody has to
   * guess it from a taxonomy string.
   *
   * The capability now comes from `identifierConfigs/{slug}.tagMapping.enabled`, resolved
   * by the caller. Absent ⇒ off, so every event predating the feature shows nothing.
   */
  { key: 'timing',       label: 'Timing',             module: 'operations',    gateKey: 'identifiers' },
  /**
   * Likewise: the workspace feature flag says the PRODUCT has identifiers; only
   * `identifierConfigs/{slug}.enabled` says THIS EVENT issues them. Gating on the flag
   * alone offered the panel to every event that had never configured one.
   */
  { key: 'identifiers',  label: 'Identifiers',        module: 'operations',    gateKey: 'identifiers' },
  { key: 'certificates', label: 'Certificates',       module: 'communications', gateKey: 'certificates' },
  { key: 'coupons',      label: 'Coupons',            module: 'revenue',       gateKey: 'coupons' },
  { key: 'waitlist',     label: 'Waitlist',           module: 'registrations', gateKey: 'waitlist' },
  { key: 'donations',    label: 'Donations',          module: 'revenue',       gateKey: 'donations' },
] as const

/**
 * Should this panel exist?
 *
 * Waitlist additionally consults the organizer's own switch through `eventHasWaitlist` —
 * a disabled waitlist is not an empty waitlist, and a panel of zeros would claim nobody
 * queued when in fact nobody could.
 */
export function isAnalyticsPanelAvailable(
  panel: AnalyticsPanelDef,
  ctx: AnalyticsModuleContext,
): boolean {
  if (panel.gateKey && gateState(panel.gateKey, ctx.gate) !== null) return false
  if (panel.eventTypes && !panel.eventTypes.includes(ctx.eventType ?? '')) return false
  if (panel.key === 'waitlist') return eventHasWaitlist(ctx.registrationRules)
  /**
   * RD-ANALYTICS-10 · the two identifier capabilities, each from its own switch.
   *
   * They are checked INDEPENDENTLY and in this order because the four combinations are all
   * real: an event may issue bib numbers without chips (most road races), chips without
   * platform-issued numbers (a timed event using pre-printed bibs), both, or neither.
   * Deriving one from the other — or either from `eventType` — would make one of those
   * four events wrong.
   */
  if (panel.key === 'identifiers') return ctx.identifiersEnabled === true
  if (panel.key === 'timing')      return ctx.timingEnabled === true
  // Every panel under a financial module inherits that module's permission.
  const owner = ANALYTICS_MODULES.find(m => m.key === panel.module)
  if (owner?.financial && !ctx.financeAllowed) return false
  return true
}

/** The panels to offer inside one module, in declaration order. */
export function availableAnalyticsPanels(
  module: AnalyticsModuleKey,
  ctx: AnalyticsModuleContext,
): AnalyticsPanelDef[] {
  return ANALYTICS_PANELS.filter(p => p.module === module && isAnalyticsPanelAvailable(p, ctx))
}
