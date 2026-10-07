// Phase H.1.5B — Participant Identity Platform: domain types.
//
// This is the PERMANENT identity layer for RegisterDesk. "Bib Number" is only a
// label (identifier.label = "Bib Number"); nothing here is sports-specific.
// Every event type inherits this engine without a schema change.
//
// SDK-free — safe to import from client and server.

// ─── Lifecycle ──────────────────────────────────────────────────────────────

/**
 * The complete identifier lifecycle. Transitions are enforced by the engine:
 *   available → reserved | blocked | assigned | retired
 *   reserved  → assigned | blocked | retired | available(release)
 *   assigned  → consumed | released | retired(after release)
 *   released  → assigned(reuse, policy-gated) | retired | blocked
 *   consumed  → released   (everCheckedIn stays true — never auto-reusable)
 *   blocked   → available | retired
 *   retired   → (terminal)
 */
export type IdentifierState =
  | 'available'
  | 'reserved'
  | 'blocked'
  | 'assigned'
  | 'released'
  | 'consumed'
  | 'retired'

export type ReusePolicy =
  | 'never'
  | 'before_event_start'
  | 'after_cancel_before_checkin'
  | 'after_event_completed'
  | 'manual_only'

export type IdentifierType = 'numeric' | 'alphanumeric' | 'random' | 'pattern'

export type AssignmentStrategy = 'manual' | 'auto'

/**
 * RD-BIB-01 · which participant gets the first number.
 *
 *   'document'     — Firestore document id order. Random UUIDs, so the order is
 *                    arbitrary but stable. THE DEFAULT, because it is what every
 *                    existing event already did and changing it silently would
 *                    re-order numbers nobody asked to re-order.
 *   'registration' — oldest sign-up first, ties broken by document id.
 *
 * Name-based ordering is deliberately absent: the platform stores no normalised name
 * field, so sorting on `attendee.name` would be locale-dependent and would need both
 * a denormalised field and a backfill. Recorded as deferred rather than half-built.
 */
export type AssignmentOrder = 'document' | 'registration'

export type AutoTrigger = 'on_confirmation' | 'on_payment' | 'on_checkin'

export type IdentifierSource = 'manual' | 'auto' | 'bulk' | 'import' | 'api' | 'walkin'

export type HistoryAction =
  | 'created'
  | 'reserved'
  | 'assigned'
  | 'released'
  | 'swapped'
  | 'checked_in'
  | 'consumed'
  | 'retired'
  | 'reused'
  | 'blocked'
  | 'restored'        // H.3: reserved/blocked → available
  | 'config_changed'  // H.3: identifier configuration / pool edited

// ─── Format / template / pool ───────────────────────────────────────────────

/**
 * RD-EVENT-19A · how a manually-supplied value is folded before it becomes the
 * authoritative lock identity. `preserve` is the DEFAULT and reproduces today's
 * behaviour byte-for-byte — existing events never change meaning.
 */
export type IdentifierCaseMode = 'preserve' | 'upper' | 'lower'

export interface IdentifierFormat {
  prefix:      string
  suffix:      string
  padding:     number          // zero-pad width for the numeric body
  startNumber: number          // first number issued for a fresh counter
  pattern?:    string          // for type 'pattern', e.g. "RUN-{YEAR}-{0001}"
  alphabet?:   string          // for type 'random'
  randomLength?: number        // for type 'random'
  /** RD-EVENT-19A · case policy for manual values. Absent ⇒ 'preserve'. */
  caseMode?:   IdentifierCaseMode
}

/**
 * RD-EVENT-19A · one contiguous, INCLUSIVE numeric range: 5001–6500 is
 * `{ start: 5001, end: 6500 }` and holds 1500 identifiers.
 */
export interface IdentifierRange {
  start: number
  end:   number
}

/**
 * A pool is a generic allocation group. The engine knows nothing about sports —
 * "5K", "VIP", "Speakers", "Volunteers" and "Pool A" are all just pools.
 */
export interface IdentifierPool {
  poolId:     string
  label:      string
  prefix?:    string
  suffix?:    string
  padding?:   number
  rangeStart?: number | null   // inclusive; null = unbounded  (legacy single range)
  rangeEnd?:   number | null   // inclusive; null = unbounded  (legacy single range)
  templateId?: string | null
  /**
   * RD-EVENT-19A · FIRST-CLASS pass association. A registration whose `passId` is
   * listed here resolves to this pool. This is what lets one event issue
   * 5001–6500 for one pass and 7000–7500 for another without a line of
   * pass-specific code anywhere in the engine.
   *
   * An EMPTY array is NOT "all passes" — it is "no pass restriction declared",
   * i.e. exactly the same as the field being absent. A pool that should serve
   * every pass simply omits the field and is reached through the existing
   * category / default-pool behaviour.
   */
  passIds?:   string[]
  /**
   * RD-EVENT-19A · multiple non-overlapping ranges, walked in ascending order.
   * AUTHORITATIVE when present: `rangeStart`/`rangeEnd` are then ignored rather
   * than merged, so the two can never silently combine into a third range.
   */
  ranges?:    IdentifierRange[]
  /** How a registration maps to this pool. Absent ⇒ only matched explicitly. */
  matchRule?: {
    by:     'pass' | 'category' | 'registration_type' | 'custom'
    values: string[]
  }
}

/**
 * Templates are schema-only in this phase (printing comes later). Future modules
 * (bib/badge/ID-card/QR/RFID printing) read these properties — they never create
 * a parallel identifier system.
 */
export interface IdentifierTemplate {
  templateId:         string
  label:              string
  prefix?:            string
  suffix?:            string
  digits?:            number
  color?:             string
  printTemplate?:     string | null
  reusePolicy?:       ReusePolicy
  poolId?:            string | null
  assignmentStrategy?: AssignmentStrategy
}

export interface IdentifierVisibility {
  attendee:    boolean
  ticket:      boolean
  certificate: boolean
  badge:       boolean
  checkin:     boolean
}

// ─── Config ─────────────────────────────────────────────────────────────────

/** identifierConfigs/{eventSlug} */
export interface IdentifierConfig {
  eventSlug:           string
  enabled:             boolean
  label:               string             // the ONLY user-facing name; never hardcode "Bib"
  preset:              string             // 'bib' | 'badge' | 'token' | 'volunteer' | ... (informational)
  type:                IdentifierType
  format:              IdentifierFormat
  reusePolicy:         ReusePolicy
  assignmentStrategy:  AssignmentStrategy
  autoTrigger?:        AutoTrigger
  /**
   * RD-BIB-01 · the order a bulk run walks the roster in, and therefore the order
   * numbers come out in.
   *
   * ABSENT ⇒ `'document'`, which is what every existing event has been doing: the
   * roster is paged by document id, and document ids are random UUIDs, so the first
   * number goes to an arbitrary participant. Deterministic and stable, but not
   * meaningful — observed in the audit, where 5001 went to the 24th person to sign up.
   *
   * `'registration'` walks the roster oldest-first, so the first person to sign up
   * gets the first number. Ties on the timestamp are broken by document id, which is
   * what keeps the cursor stable across pages.
   *
   * NOT changed for any existing event: absent means the old behaviour, and the
   * organizer has to choose the new one.
   */
  assignmentOrder?:    AssignmentOrder
  allowManualOverride: boolean
  allowDuplicate:      boolean            // default false
  pools:               IdentifierPool[]
  templates:           IdentifierTemplate[]
  defaultPoolId:       string
  visibility:          IdentifierVisibility
  version:             number
  /**
   * RD-EVENT-19F-B · timing-tag capability, stored on the config document this
   * event already has rather than in a new collection or a new toggle system.
   *
   * ABSENT ⇒ off. Every event that predates the feature therefore shows nothing,
   * with no migration and no backfill. Read it through `resolveTagMapping`.
   */
  tagMapping?:         import('./timingTags').TagMappingConfig
  updatedAt?:          unknown
  createdAt?:          unknown
}

// ─── Firestore document shapes ──────────────────────────────────────────────

/** identifierLocks/{eventSlug}__{value} — authoritative uniqueness + state. */
export interface IdentifierLockDoc {
  eventSlug:      string
  value:          string
  numeric:        number | null
  poolId:         string
  templateId:     string | null
  state:          IdentifierState
  registrationId: string | null
  everCheckedIn:  boolean
  reason:         string | null
  assignedAt:     unknown
  releasedAt:     unknown
  createdAt:      unknown
  updatedAt:      unknown
}

/** identifierCounters/{eventSlug}__{poolId} — per-pool monotonic counter. */
export interface IdentifierCounterDoc {
  eventSlug:  string
  poolId:     string
  nextNumber: number
  updatedAt:  unknown
}

/** identifierHistory/{autoId} — immutable timeline of every identifier event. */
export interface IdentifierHistoryEntry {
  id?:            string
  eventSlug:      string
  value:          string
  action:         HistoryAction
  actor:          string
  registrationId: string | null
  previousOwner:  string | null
  newOwner:       string | null
  reason:         string | null
  timestamp:      unknown
}

/**
 * registrations/{id}.identifier — the generic mirror carried on each
 * registration. `bibNumber`/`bibCategory` remain as a legacy compatibility
 * mirror until Phase 6 removes legacy reads.
 */
export interface RegistrationIdentifier {
  value:         string
  label:         string
  type:          IdentifierType
  poolId:        string
  templateId:    string | null
  category:      string | null
  state:         IdentifierState
  source:        IdentifierSource
  assignedAt:    unknown
  assignedBy:    string
  everCheckedIn: boolean
}

// ─── Operation inputs / results ─────────────────────────────────────────────

export interface AllocateInput {
  eventSlug:      string
  registrationId: string
  actor:          string
  source:         IdentifierSource
  poolId?:        string           // explicit pool; else resolved from config + reg
  explicitValue?: string           // manual override
  templateId?:    string | null
  category?:      string | null
  reason?:        string | null
  /**
   * RD-EVENT-19A · the registration's pass, used ONLY to resolve which pool the
   * identifier comes from. Optional: every caller that omits it keeps the exact
   * pre-19A behaviour (explicit pool → category matchRule → default pool).
   *
   * The engine never reads a pass document for this — callers supply the id they
   * already hold, so pass-aware allocation costs zero additional Firestore reads.
   */
  passId?:        string | null
  /**
   * RD-EVENT-19E · IDEMPOTENCY for repeat execution.
   *
   * When true, a registration that ALREADY holds an identifier is left exactly as
   * it is: the transaction returns its current value and writes nothing — no
   * counter advance, no lock, no history entry.
   *
   * Without it, allocating for someone who already holds a value takes the next
   * number and SWAPS them onto it. That is correct for an operator who deliberately
   * asked for a new one, and catastrophic for a retried bulk chunk or a double
   * click, which would walk a participant from 5001 to 5002 to 5003.
   *
   * The check happens INSIDE the transaction, against a fresh read, so it also
   * closes the window where two callers both believed the participant was
   * unassigned. Absent/false ⇒ behaviour identical to before this option existed.
   */
  skipIfAssigned?: boolean
}

export interface AllocateResult {
  value:      string
  poolId:     string
  label:      string
  reused:     boolean
  /**
   * RD-EVENT-19E · true when `skipIfAssigned` prevented a write because the
   * registration already held this value. Nothing changed; `value` is what it has.
   */
  alreadyAssigned?: boolean
}

export interface MutateInput {
  eventSlug:      string
  value:          string
  actor:          string
  reason?:        string | null
}

export interface LookupResult {
  exists:        boolean
  lock:          IdentifierLockDoc | null
  registrationId: string | null
}

// ─── Errors ─────────────────────────────────────────────────────────────────

export type IdentifierErrorCode =
  | 'CONFIG_DISABLED'
  | 'REGISTRATION_NOT_FOUND'
  | 'REGISTRATION_TERMINAL'
  | 'POOL_NOT_FOUND'
  | 'POOL_EXHAUSTED'
  | 'VALUE_CONFLICT'
  | 'MANUAL_OVERRIDE_DISABLED'
  | 'INVALID_STATE_TRANSITION'
  | 'IDENTIFIER_NOT_FOUND'
  | 'OUT_OF_RANGE'
  | 'INVALID_VALUE'          // RD-EVENT-19A: empty / over-length manual value
  // RD-BIB-TIMING-01 · a timing device depends on this number, so it cannot be
  // taken away while the device is attached. The device is removed first.
  | 'IDENTIFIER_HELD_BY_TIMING_TAG'

export class IdentifierError extends Error {
  constructor(public readonly code: IdentifierErrorCode, message?: string) {
    super(message ?? code)
    this.name = 'IdentifierError'
  }
}

/**
 * Rejects invalid pool / config values BEFORE they are persisted, so the
 * allocator never reads a corrupt config. The API layer maps it to HTTP 400.
 *
 * RD-EVENT-19A moved this here (from ./config) so the PURE range validator can
 * throw it without importing the Admin SDK. `lib/identifiers/config` still
 * re-exports it, so every existing `from '@/lib/identifiers/config'` import is
 * unchanged.
 */
export class IdentifierConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'IdentifierConfigError'
  }
}
