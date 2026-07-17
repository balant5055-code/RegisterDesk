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

export interface IdentifierFormat {
  prefix:      string
  suffix:      string
  padding:     number          // zero-pad width for the numeric body
  startNumber: number          // first number issued for a fresh counter
  pattern?:    string          // for type 'pattern', e.g. "RUN-{YEAR}-{0001}"
  alphabet?:   string          // for type 'random'
  randomLength?: number        // for type 'random'
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
  rangeStart?: number | null   // inclusive; null = unbounded
  rangeEnd?:   number | null   // inclusive; null = unbounded
  templateId?: string | null
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
  allowManualOverride: boolean
  allowDuplicate:      boolean            // default false
  pools:               IdentifierPool[]
  templates:           IdentifierTemplate[]
  defaultPoolId:       string
  visibility:          IdentifierVisibility
  version:             number
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
}

export interface AllocateResult {
  value:      string
  poolId:     string
  label:      string
  reused:     boolean
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

export class IdentifierError extends Error {
  constructor(public readonly code: IdentifierErrorCode, message?: string) {
    super(message ?? code)
    this.name = 'IdentifierError'
  }
}
