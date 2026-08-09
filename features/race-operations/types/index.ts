// RD-RACEOPS-01 · Race Operations — domain types.
//
// SDK-FREE by contract: no firebase-admin, no next/*, no React. Safe to import
// from client components, server components, route handlers and unit tests alike.
// This is the module's vocabulary; nothing outside the module imports from here.
//
// Sprint 1 scope: the types needed to NAVIGATE the module and to describe what the
// organizer has selected. No result, ranking, or import types exist yet — those
// arrive with the engines in Sprint 2+ and are added here, not scattered.

import type { TeamRole } from '@/lib/team/types'

// ─── Access ───────────────────────────────────────────────────────────────────

/**
 * The roles permitted to operate Race Operations.
 *
 * Deliberately derived from the EXISTING TeamRole union (lib/team/types.ts) rather
 * than a new permission enum — Race Operations introduces no permission model of
 * its own. This mirrors, on the client, exactly what `requireAdmin()` enforces on
 * the server: the workspace owner, or an active member with the `admin` role.
 */
export const RACE_OPS_ROLES: readonly TeamRole[] = ['owner', 'admin']

/** Resolved answer to "may this caller operate Race Operations?". */
export interface RaceOpsAccess {
  /** undefined while still resolving — never render a denial during resolution. */
  allowed: boolean | undefined
  /** The caller's effective workspace role, verbatim from the existing
   *  GET /api/organizer/workspace contract (`role: string`). Kept as the raw value
   *  so a denied role is still reportable to the organizer. */
  role:    string | null
  isOwner: boolean
}

// ─── Publish Results flow ─────────────────────────────────────────────────────

/**
 * The six stages of the Publish Results flow, in order.
 *
 * `event` and `race` are INTERACTIVE in Sprint 1 (they read data that already
 * exists through existing APIs). `upload` → `publish` are declared placeholders:
 * they render what the stage will do and state plainly that it is not built yet.
 */
export type RaceOpsStageKey =
  | 'event'
  | 'race'
  | 'upload'
  | 'validate'
  | 'preview'
  | 'publish'

export const RACE_OPS_STAGE_ORDER: readonly RaceOpsStageKey[] = [
  'event', 'race', 'upload', 'validate', 'preview', 'publish',
]

/** Which sprint delivers a stage's behaviour — surfaced in the UI so a placeholder
 *  is never mistaken for a broken feature. */
export type RaceOpsStageState = 'ready' | 'planned'

// ─── Selection ────────────────────────────────────────────────────────────────

/**
 * An event the organizer has selected. Projected from the EXISTING
 * `EventListItem` returned by GET /api/organizer/events — Race Operations defines
 * no event shape of its own and performs no event read of its own.
 *
 * `eventId` is the draftId (`users/{uid}/eventDrafts/{eventId}`) — the organizer-side
 * key. `slug` is the published-event key (`events/{slug}`) and is null for a draft.
 */
export interface RaceOpsEventSelection {
  eventId:         string
  name:            string
  slug:            string | null
  eventType:       string | null
  lifecycleStatus: string
  startDate:       string | null
  raceCount:       number
}

/**
 * A "race" — i.e. a DISTANCE. Per the approved Phase 0 decision (D2), a race
 * distance IS a pass on the event (`events/{slug}.pricing.passes[]`); RegisterDesk
 * has no separate distance field and Race Operations does not invent one.
 * Projected from the existing `EventPassSummary`.
 */
export interface RaceOpsRaceSelection {
  passId:        string
  name:          string
  registrations: number
}

// ─── Event eligibility ────────────────────────────────────────────────────────

/**
 * Lifecycle states in which results are meaningful: the event is live, closed to
 * new registrations, or finished. A draft has no participants to publish results
 * for, and a cancelled/archived event should not gain new published artefacts.
 *
 * Values are members of the existing EventLifecycleStatus union (types/events.ts).
 */
export const RACE_OPS_ELIGIBLE_LIFECYCLE: readonly string[] = [
  'published', 'registration_closed', 'completed',
]

// ─── Result model (Sprint 2) ──────────────────────────────────────────────────
// Re-exported so `@/features/race-operations/types` stays the module's one type entry
// point. The definitions live in ./results.ts.

export type {
  RaceResultStatus, NormalizedRaceResult, ResultField, ResultFieldDef,
  ColumnMapping, ParsedRow, ParsedTable,
} from './results'
export {
  NON_FINISHING_STATUSES, RACE_RESULT_STATUS_LABEL,
  RESULT_FIELDS, REQUIRED_RESULT_FIELDS, RESULT_FIELD_LABEL,
} from './results'
