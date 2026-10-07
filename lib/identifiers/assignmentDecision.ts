// RD-EVENT-19C — Participant Identity Platform: the ASSIGNMENT DECISION MODEL.
//
// PURE. No I/O, no SDK, no Firestore. Facts go in, a decision with a
// machine-readable reason comes out — so the engine, a future assignment UI and a
// future bulk job all answer "may this participant receive this identifier?" with
// ONE implementation that can be tested without a network.
//
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  THIS MODULE DOES NOT INVENT PRODUCT POLICY.                              ║
// ║  Where RegisterDesk already has a rule, it transcribes it and cites where  ║
// ║  the rule lives. Where two rules disagree, it reports `divergent` and      ║
// ║  names both. Where nothing is defined, it reports `unknown` and says what  ║
// ║  is missing. It never guesses, and it never turns an unknown into a yes.   ║
// ╚══════════════════════════════════════════════════════════════════════════╝
//
// Nothing here knows what a bib, a runner or a 5 KM is. A pass is an id, a pool
// is a set of numbers, and the human-readable name of an identifier lives in
// configuration (`config.label`) for every event category alike.

import {
  identifierEligibility, identifierAssignmentBlockedBy, identifierRosterVisible,
  poolAcceptsPass, poolsForPass, ENGINE_TERMINAL_STATUSES, ROSTER_STATUSES,
  KNOWN_STATUSES as KNOWN_REGISTRATION_STATUSES,
} from './eligibility'
import { effectiveRanges, configuredRanges, nextNumberInRanges, rangeCapacity } from './ranges'
// PURE module, deliberately not ./config — that one imports the Admin SDK, and
// this decision layer is consumed by the browser.
import { canReuse } from './reusePolicy'
import type { EligibilitySubject } from './eligibility'
import type {
  IdentifierConfig, IdentifierPool, IdentifierRange, IdentifierState,
  IdentifierLockDoc, RegistrationIdentifier, ReusePolicy,
} from './types'
import type { LifecyclePhase } from './reusePolicy'
import type { IdentifierMetric, IdentifierPoolStat } from './statistics'
import { knownMetric, unavailableMetric } from './statistics'

// ─── The decision vocabulary ────────────────────────────────────────────────

/**
 * `divergent` is a first-class outcome, not an error. Two rules that are BOTH in
 * force today disagree about `pending` and `waitlisted` registrations, and the
 * honest answer is to say so rather than to pick a winner in a refactor.
 */
export type DecisionState = 'eligible' | 'ineligible' | 'unknown' | 'divergent'

export type DecisionReason =
  // ── Event ────────────────────────────────────────────────────────────────
  | 'EVENT_LOCKED'                  // cancelled / archived — the platform's isLocked rule
  | 'EVENT_LIFECYCLE_UNKNOWN'       // missing or unrecognised → fail closed
  | 'IDENTIFIERS_DISABLED'          // config.enabled === false
  // ── Registration ─────────────────────────────────────────────────────────
  | 'REGISTRATION_MISSING'
  | 'REGISTRATION_CANCELLED'
  | 'REGISTRATION_REJECTED'
  | 'REGISTRATION_NOT_ON_ROSTER'    // pending / waitlisted — the known divergence
  | 'REGISTRATION_STATUS_UNKNOWN'
  // ── Pass / pool scope ────────────────────────────────────────────────────
  | 'PASS_MISSING'                  // the registration names no pass
  | 'PASS_OUT_OF_POOL_SCOPE'        // the pool serves other passes only
  | 'POOL_MISSING'                  // no pool with that id in the config
  | 'POOL_PASS_DELETED'             // the pool serves a pass the event no longer has
  // ── Existing identifier ──────────────────────────────────────────────────
  | 'ALREADY_ASSIGNED'              // holds one already; a reassignment is a swap
  | 'IDENTIFIER_OWNED_BY_OTHER'
  | 'IDENTIFIER_BLOCKED'
  | 'IDENTIFIER_RETIRED'
  | 'IDENTIFIER_CONSUMED'
  | 'IDENTIFIER_NOT_REUSABLE'       // released, but policy/everCheckedIn forbids reuse
  | 'LEGACY_MIRROR_WITHOUT_LOCK'    // registration carries a value with no authoritative lock
  | 'LOCK_WITHOUT_MIRROR'           // lock names a registration that does not carry it
  // ── Capacity ─────────────────────────────────────────────────────────────
  | 'POOL_EXHAUSTED'
  | 'POOL_USAGE_UNAVAILABLE'        // statistics could not be read — NEVER "available"
  | 'POOL_INCONSISTENT'             // more in use than the ranges hold

/** What acting on this decision would actually do. */
export type AssignmentAction =
  | 'assign'      // first identifier for this registration
  | 'reuse'       // take a released value back into service (policy-gated)
  | 'swap'        // replace the value this registration already holds
  | 'noop'        // it already holds exactly this value
  | 'blocked'     // nothing may be done

export interface AssignmentDecision {
  state:    DecisionState
  eligible: boolean
  reason:   DecisionReason | null
  action:   AssignmentAction
  /** The pool this decision resolved to, when one was resolved. */
  poolId:   string | null
  /**
   * Present ONLY when `state === 'divergent'`: what each rule in force says, so a
   * caller can act on whichever the product eventually chooses without asking
   * this module to have decided.
   */
  divergence: { engineAllows: boolean; rosterLists: boolean } | null
}

const decide = (
  state: DecisionState, reason: DecisionReason | null, action: AssignmentAction,
  poolId: string | null = null,
  divergence: AssignmentDecision['divergence'] = null,
): AssignmentDecision =>
  ({ state, eligible: state === 'eligible', reason, action, poolId, divergence })

// ════════════════════════════════════════════════════════════════════════════
// EVENT LIFECYCLE
// ════════════════════════════════════════════════════════════════════════════

/**
 * Lifecycle states in which an organizer may change participant identity.
 *
 * This is the PLATFORM's existing `isLocked` rule (lib/eventSetup/readiness:
 * cancelled and archived are read-only), transcribed — the same rule RD-EVENT-17
 * applied to the conference schedule. It is deliberately NOT the narrower
 * check-in set (`lib/checkin/eventStatus.ACCEPTING_STATUSES`), because refusing
 * assignment on an `unpublished` event would be a NEW restriction nobody asked
 * for, and inventing restrictions is exactly what this phase must not do.
 *
 * A draft never reaches here at all: identifiers are keyed by `eventSlug`, which
 * an event gets at publish, and `resolveIdentifierScope` already refuses a draft.
 *
 * UNKNOWN FAILS CLOSED. A lifecycle value the platform does not define could mean
 * anything, and "anything" must not include handing out printed identifiers.
 */
export const IDENTIFIER_LOCKED_LIFECYCLE = ['cancelled', 'archived'] as const

/** Every lifecycle value the platform defines. Anything else is unknown. */
export const KNOWN_LIFECYCLE = [
  'draft', 'pending_review', 'changes_requested', 'published',
  'registration_closed', 'completed', 'cancelled', 'archived', 'unpublished',
] as const

export interface EventAssignmentGate {
  open:   boolean
  reason: DecisionReason | null
  /** A sentence for a human. Never a raw status string. */
  detail: string | null
}

// ─── Where the event is in the credential workflow ──────────────────────────

/**
 * RD-BIB-TIMING-03 · §3 · which operational phase the event is in, as far as
 * CREDENTIALS are concerned.
 *
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  THIS DOES NOT GATE ANYTHING. It is a description, not a permission.      ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `resolveEventAssignmentGate` above is the ONLY gate, and it still blocks exactly
 * `cancelled` and `archived`. Assignment while registration is still OPEN remains
 * allowed, deliberately: an organizer pre-assigns numbers to early registrants,
 * prints in batches, and hands out packets before the closing date. RD-BIB-TIMING-03
 * audited that rule, found it intentional, and did NOT narrow it — tying assignment
 * to `registration_closed` would break every event that prints early.
 *
 * What was missing was not a restriction but a SIGNAL: `lifecycleStatus` never
 * reached the browser, so the workspace could not say "registration has closed —
 * this is the moment to issue credentials" at the moment that became true.
 */
export type CredentialStage =
  | 'not_open_yet'   // published but registration has not opened / draft-side states
  | 'registering'    // registration is open; assignment is allowed but the roster grows
  | 'closed'         // registration is closed — the roster is final, issue credentials
  | 'completed'      // the event has happened
  | 'locked'         // cancelled / archived — read-only
  | 'unknown'        // an unrecognised value; say so rather than guess

export function resolveCredentialStage(
  lifecycleStatus: string | null | undefined,
): CredentialStage {
  switch (typeof lifecycleStatus === 'string' ? lifecycleStatus : '') {
    case 'registration_closed': return 'closed'
    case 'published':           return 'registering'
    case 'completed':           return 'completed'
    case 'cancelled':
    case 'archived':            return 'locked'
    case 'draft':
    case 'pending_review':
    case 'changes_requested':
    case 'unpublished':         return 'not_open_yet'
    default:                    return 'unknown'
  }
}

/**
 * Whether the roster can still grow underneath an assignment run.
 *
 * The organizer's real question at the top of this workspace is not "what is my
 * lifecycle status" but "if I assign now, will more people arrive afterwards?".
 */
export const rosterCanStillGrow = (stage: CredentialStage): boolean =>
  stage === 'registering' || stage === 'not_open_yet'

export function resolveEventAssignmentGate(
  lifecycleStatus: string | null | undefined,
): EventAssignmentGate {
  const ls = typeof lifecycleStatus === 'string' ? lifecycleStatus : ''

  if (!(KNOWN_LIFECYCLE as readonly string[]).includes(ls)) {
    return {
      open: false,
      reason: 'EVENT_LIFECYCLE_UNKNOWN',
      detail: 'This event is not in a state this workspace recognises, so identifier changes are held.',
    }
  }
  if ((IDENTIFIER_LOCKED_LIFECYCLE as readonly string[]).includes(ls)) {
    return {
      open: false,
      reason: 'EVENT_LOCKED',
      detail: ls === 'cancelled'
        ? 'This event is cancelled, so identifiers are read-only.'
        : 'This event is archived, so identifiers are read-only.',
    }
  }
  return { open: true, reason: null, detail: null }
}

// ════════════════════════════════════════════════════════════════════════════
// REGISTRATION ELIGIBILITY
// ════════════════════════════════════════════════════════════════════════════

/**
 * Whether this registration may hold an identifier at all.
 *
 * Built on the RD-EVENT-19A eligibility contract, which states the two rules that
 * are in force today rather than choosing between them:
 *
 *   ENGINE  refuses `cancelled` and `rejected`, and nothing else.
 *   ROSTER  lists `confirmed`, and nothing else.
 *
 * So a `pending` registration is allocatable by the engine and invisible to the
 * organizer — a real disagreement, reported here as `divergent` with both
 * answers attached. RD-EVENT-19C does NOT resolve it; a caller that must act
 * picks a side explicitly via `treatDivergentAs`.
 *
 * `paymentStatus` is deliberately not consulted: the identifier engine has never
 * done so, and check-in's separate REFUNDED block is a gate rule, not an
 * assignment rule. Whether a refunded participant keeps their identifier is an
 * open product question, not a bug to be fixed by a decision layer.
 */
export interface RegistrationEligibilityOptions {
  /**
   * How to resolve the known divergence when a yes/no is unavoidable.
   * `'report'` (default) surfaces `divergent`. `'engine'` and `'roster'` collapse
   * it to that rule's answer — an explicit, auditable choice by the caller.
   */
  treatDivergentAs?: 'report' | 'engine' | 'roster'
}

export function decideRegistrationEligibility(
  reg:  EligibilitySubject | null | undefined,
  opts: RegistrationEligibilityOptions = {},
): AssignmentDecision {
  if (!reg) return decide('ineligible', 'REGISTRATION_MISSING', 'blocked')

  const e = identifierEligibility(reg)

  if (e.blockedBy === 'CANCELLED') return decide('ineligible', 'REGISTRATION_CANCELLED', 'blocked')
  if (e.blockedBy === 'REJECTED')  return decide('ineligible', 'REGISTRATION_REJECTED', 'blocked')

  if (e.unknownStatus) {
    // Unknown fails closed for a DECISION, while `identifierAssignmentBlockedBy`
    // keeps the engine's existing permissiveness — the engine's behaviour is not
    // changed by this phase, only described.
    return decide('unknown', 'REGISTRATION_STATUS_UNKNOWN', 'blocked')
  }

  if (e.divergent) {
    const divergence = {
      engineAllows: identifierAssignmentBlockedBy(reg) === null,
      rosterLists:  identifierRosterVisible(reg),
    }
    const mode = opts.treatDivergentAs ?? 'report'
    if (mode === 'engine') {
      return divergence.engineAllows
        ? decide('eligible', null, 'assign', null, divergence)
        : decide('ineligible', 'REGISTRATION_NOT_ON_ROSTER', 'blocked', null, divergence)
    }
    if (mode === 'roster') {
      return divergence.rosterLists
        ? decide('eligible', null, 'assign', null, divergence)
        : decide('ineligible', 'REGISTRATION_NOT_ON_ROSTER', 'blocked', null, divergence)
    }
    return decide('divergent', 'REGISTRATION_NOT_ON_ROSTER', 'blocked', null, divergence)
  }

  return decide('eligible', null, 'assign')
}

// ════════════════════════════════════════════════════════════════════════════
// PASS / POOL SCOPE
// ════════════════════════════════════════════════════════════════════════════

export interface PoolScopeContext {
  /** The event's passes, so a pool naming a deleted one can be reported. */
  passes:      Array<{ id: string; name: string }>
  /** False ⇒ pass data is unavailable; nothing is called deleted on a guess. */
  passesKnown: boolean
}

/**
 * May a registration on `passId` draw from `pool`?
 *
 * THE RULE THAT MATTERS: a pool that names passes serves ONLY those passes. A
 * participant on another pass can never receive one of its identifiers, and an
 * unknown pass matches nothing rather than falling through to the nearest pool.
 * A printed identifier cannot be taken back.
 *
 * A pool that names NO pass is unrestricted and serves any pass — that is the
 * default-pool behaviour RD-EVENT-19A preserved, not a wildcard bolted on here.
 */
export function decidePoolScope(
  pool:   IdentifierPool | null | undefined,
  passId: string | null | undefined,
  ctx:    PoolScopeContext,
): AssignmentDecision {
  if (!pool) return decide('ineligible', 'POOL_MISSING', 'blocked')

  const declared = Array.isArray(pool.passIds) && pool.passIds.length > 0 ? pool.passIds : null
  const legacy   = pool.matchRule?.by === 'pass' && pool.matchRule.values.length > 0
    ? pool.matchRule.values : null
  const scope = declared ?? legacy

  if (!scope) return decide('eligible', null, 'assign', pool.poolId)   // unrestricted

  // A pool wired to a pass the event no longer has cannot receive anybody.
  if (ctx.passesKnown) {
    const known = new Set(ctx.passes.map(p => p.id))
    if (scope.every(id => !known.has(id))) {
      return decide('ineligible', 'POOL_PASS_DELETED', 'blocked', pool.poolId)
    }
  }

  if (!passId) return decide('ineligible', 'PASS_MISSING', 'blocked', pool.poolId)

  const accepted = declared
    ? poolAcceptsPass(pool, passId)
    : (legacy?.includes(passId) ?? false)

  return accepted
    ? decide('eligible', null, 'assign', pool.poolId)
    : decide('ineligible', 'PASS_OUT_OF_POOL_SCOPE', 'blocked', pool.poolId)
}

// ── Selection → pools ───────────────────────────────────────────────────────

/**
 * What the organizer picked. `all_passes` is an explicit selection, never an
 * absent one, so "assign to everybody" can never happen by omission.
 */
export type AssignmentSelection =
  | { kind: 'pass';       passIds: string[] }
  | { kind: 'all_passes' }
  | { kind: 'pool';       poolId: string }

/** One resolved target: a pass (or the unrestricted scope) and the pools serving it. */
export interface SelectionScope {
  passId:     string | null
  passName:   string | null
  passExists: boolean
  pools:      IdentifierPool[]
  /** Set when the scope cannot receive an assignment at all. */
  blocked:    DecisionReason | null
}

/**
 * Resolves a selection into per-pass scopes, PRESERVING POOL IDENTITY.
 *
 * ALL PASSES means "every eligible registration, each still drawing from its own
 * pass's pool". It is emphatically NOT "merge every pool into one anonymous
 * bucket": doing that would hand a 10 KM participant a 5 KM number, which is the
 * single failure the whole pass-scoped design exists to prevent.
 *
 * Pool membership follows the RD-EVENT-19A precedence — `pool.passIds` first,
 * then a legacy `matchRule.by === 'pass'`, then the unrestricted/default pool —
 * so the preview and the allocator can never disagree about where a number
 * comes from.
 *
 * ORDER is deterministic: the event's own pass order, then any pass named only
 * by a pool (an orphan), then the unrestricted scope last.
 */
export function resolveSelectionScopes(
  selection: AssignmentSelection,
  config:    IdentifierConfig,
  ctx:       PoolScopeContext,
): SelectionScope[] {
  const nameOf = new Map(ctx.passes.map(p => [p.id, p.name]))

  // An explicit pool selection is one scope: that pool, whatever it serves.
  if (selection.kind === 'pool') {
    const pool = config.pools.find(p => p.poolId === selection.poolId)
    if (!pool) return [{ passId: null, passName: null, passExists: true, pools: [], blocked: 'POOL_MISSING' }]
    const scopeIds = poolPassScope(pool)
    if (!scopeIds) {
      return [{ passId: null, passName: null, passExists: true, pools: [pool], blocked: null }]
    }
    return scopeIds.map(passId => ({
      passId,
      passName:   nameOf.get(passId) ?? null,
      passExists: !ctx.passesKnown || nameOf.has(passId),
      pools:      [pool],
      blocked:    ctx.passesKnown && !nameOf.has(passId) ? 'POOL_PASS_DELETED' as const : null,
    }))
  }

  const wanted: string[] = selection.kind === 'all_passes'
    ? passOrder(config, ctx)
    // Preserve the caller's own order for an explicit pick, de-duplicated.
    : [...new Set(selection.passIds)]

  const scopes: SelectionScope[] = wanted.map(passId => {
    const pools = poolsServingPass(config, passId)
    const exists = !ctx.passesKnown || nameOf.has(passId)
    return {
      passId,
      passName:   nameOf.get(passId) ?? null,
      passExists: exists,
      pools,
      blocked: !exists ? 'POOL_PASS_DELETED'
             : pools.length === 0 ? 'POOL_MISSING'
             : null,
    }
  })

  // An event with no passes at all still has an unrestricted scope to assign into.
  // It is added ONLY here: every pass above already falls back to the unrestricted
  // pools via `poolsServingPass`, so adding a trailing scope as well would report
  // the same pool twice.
  if (selection.kind === 'all_passes' && scopes.length === 0) {
    const unrestricted = config.pools.filter(p => poolPassScope(p) === null)
    if (unrestricted.length > 0) {
      scopes.push({ passId: null, passName: null, passExists: true, pools: unrestricted, blocked: null })
    }
  }
  return scopes
}

/** The passes a pool serves, or null when it is unrestricted. 19A precedence. */
export function poolPassScope(pool: IdentifierPool): string[] | null {
  if (Array.isArray(pool.passIds) && pool.passIds.length > 0) return [...pool.passIds]
  if (pool.matchRule?.by === 'pass' && pool.matchRule.values.length > 0) return [...pool.matchRule.values]
  return null
}

/**
 * Every pool that would serve this pass, in configuration order.
 *
 * A pass may legitimately be served by SEVERAL pools (5001–5999 and 7000–7500),
 * and they stay separate objects.
 *
 * RD-BIB-01 · when no pool names the pass, the answer depends on what kind of event
 * this is, and that question now has ONE owner: `poolsForPass` in ./eligibility, the
 * same predicate `resolvePool` consults. On a legacy event the unrestricted pools
 * serve everybody, exactly as before. On an event that maps numbers to passes, an
 * unmatched pass returns [] — a configuration gap the planner reports, rather than
 * numbers quietly taken from another pass's block.
 */
export function poolsServingPass(config: IdentifierConfig, passId: string): IdentifierPool[] {
  return poolsForPass(config.pools, passId)
}

/**
 * Deterministic pass ordering for ALL PASSES: every pass the EVENT has, in the
 * event's own order, then any pass named only by a pool — an orphan, which must
 * still be listed so an organizer can see the pool that can never be filled.
 */
function passOrder(config: IdentifierConfig, ctx: PoolScopeContext): string[] {
  const fromPools = new Set<string>()
  for (const p of config.pools) for (const id of poolPassScope(p) ?? []) fromPools.add(id)
  const eventOrder = ctx.passes.map(p => p.id)
  const known = new Set(eventOrder)
  return [...eventOrder, ...[...fromPools].filter(id => !known.has(id))]
}

// ════════════════════════════════════════════════════════════════════════════
// EXISTING IDENTIFIER
// ════════════════════════════════════════════════════════════════════════════

/** What the registration currently carries, from the two places it is recorded. */
export interface CurrentIdentifier {
  /** The generic mirror: registrations/{id}.identifier */
  identifier: Pick<RegistrationIdentifier, 'value' | 'poolId' | 'state'> | null
  /** The legacy mirror: registrations/{id}.bibNumber */
  legacyValue: string | null
}

/**
 * What an assignment request means for a registration that may already hold one.
 *
 * The two mirrors can disagree, and the disagreement is reported rather than
 * repaired: this phase writes nothing, and a mirror rewritten by a read model
 * would be a migration in disguise.
 *
 *   mirror + lock agree         → noop / swap
 *   legacy value, no identifier → LEGACY_MIRROR_WITHOUT_LOCK (inconsistent)
 *   identifier, no legacy value → reported, but NOT blocking: the generic mirror
 *                                 is the authority and the legacy one is a copy.
 */
export function decideExistingIdentifier(
  current:       CurrentIdentifier,
  requestedValue: string | null,
  targetPoolId:   string | null,
): AssignmentDecision {
  const held = current.identifier?.value ?? null

  if (!held) {
    if (current.legacyValue) {
      // A value nobody can validate: no generic mirror, so no pool, no state and
      // no lock relationship this layer can trust.
      return decide('unknown', 'LEGACY_MIRROR_WITHOUT_LOCK', 'blocked', targetPoolId)
    }
    return decide('eligible', null, 'assign', targetPoolId)
  }

  if (current.identifier?.state === 'consumed') {
    // Already through the gate. Changing it now would invalidate whatever was
    // scanned, so it is a deliberate operator action, never an automatic one.
    return decide('ineligible', 'IDENTIFIER_CONSUMED', 'blocked', targetPoolId)
  }

  if (requestedValue && requestedValue === held) {
    return decide('eligible', null, 'noop', current.identifier?.poolId ?? targetPoolId)
  }

  const samePool = targetPoolId === null || current.identifier?.poolId === targetPoolId
  return decide(
    'ineligible', 'ALREADY_ASSIGNED', 'swap',
    samePool ? (current.identifier?.poolId ?? targetPoolId) : targetPoolId,
  )
}

// ════════════════════════════════════════════════════════════════════════════
// VALUE COLLISION
// ════════════════════════════════════════════════════════════════════════════

/**
 * Whether a specific identifier VALUE may be given to this registration.
 *
 * Transcribes the engine's own lock rules (lib/identifiers/engine.allocate) so a
 * preview cannot promise what the transaction will refuse. The engine remains
 * the authority at write time; this only lets a caller find out first.
 *
 * An unreadable lock is NEVER treated as free. That is the difference between
 * "nobody holds 5001" and "we could not find out", and only one of them is safe.
 */
export function decideValueCollision(args: {
  lock:           Pick<IdentifierLockDoc, 'state' | 'registrationId' | 'everCheckedIn'> | null
  /** True when the lock could not be read at all. */
  lockUnavailable?: boolean
  registrationId: string
  reusePolicy:    ReusePolicy
  phase:          LifecyclePhase
  allowDuplicate: boolean
  /** A value held only in the pre-platform bibLocks collection. */
  legacyOwner?:   string | null
}): AssignmentDecision {
  const { lock, registrationId, reusePolicy, phase, allowDuplicate } = args

  if (args.lockUnavailable) {
    return decide('unknown', 'POOL_USAGE_UNAVAILABLE', 'blocked')
  }

  if (args.legacyOwner && args.legacyOwner !== registrationId && !allowDuplicate) {
    return decide('ineligible', 'IDENTIFIER_OWNED_BY_OTHER', 'blocked')
  }

  if (!lock) return decide('eligible', null, 'assign')

  if (lock.state === 'blocked') return decide('ineligible', 'IDENTIFIER_BLOCKED', 'blocked')
  if (lock.state === 'retired') return decide('ineligible', 'IDENTIFIER_RETIRED', 'blocked')

  const mine = lock.registrationId === registrationId
  if (mine) {
    return lock.state === 'consumed'
      ? decide('eligible', null, 'noop')
      : decide('eligible', null, 'noop')
  }

  if (lock.state === 'released') {
    // The permanent rule: everCheckedIn is never auto-reusable, whatever the
    // policy says. `canReuse` owns that decision; this does not restate it.
    return canReuse(lock, reusePolicy, phase)
      ? decide('eligible', null, 'reuse')
      : decide('ineligible', 'IDENTIFIER_NOT_REUSABLE', 'blocked')
  }

  if (lock.state === 'consumed') return decide('ineligible', 'IDENTIFIER_CONSUMED', 'blocked')

  const occupied: ReadonlySet<IdentifierState> = new Set<IdentifierState>(['assigned', 'reserved'])
  if (occupied.has(lock.state) && !allowDuplicate) {
    return decide('ineligible', 'IDENTIFIER_OWNED_BY_OTHER', 'blocked')
  }

  return decide('eligible', null, 'assign')
}

// ════════════════════════════════════════════════════════════════════════════
// THE COMPOSITE DECISION
// ════════════════════════════════════════════════════════════════════════════

export interface AssignmentDecisionInput {
  config:          IdentifierConfig
  lifecycleStatus: string | null | undefined
  registration:    (EligibilitySubject & { passId?: string | null }) | null
  registrationId:  string
  pool:            IdentifierPool | null
  current:         CurrentIdentifier
  ctx:             PoolScopeContext
  requestedValue?: string | null
  /** Pool usage, when known. `null` ⇒ statistics unavailable, never "room left". */
  poolUsage?:      Pick<IdentifierPoolStat, 'state' | 'available' | 'capacityKind'> | null
  options?:        RegistrationEligibilityOptions
}

/**
 * The whole question, answered in a fixed order of precedence.
 *
 * The order is not arbitrary: the widest reason wins, so an organizer is told
 * "this event is archived" rather than "participant 41 has the wrong pass" when
 * both are true. Capacity is checked LAST because it is the only reason that can
 * change without anybody editing anything.
 */
export function decideAssignment(input: AssignmentDecisionInput): AssignmentDecision {
  const { config, registration, pool, current, ctx } = input

  // 1 — the event
  if (config.enabled === false) return decide('ineligible', 'IDENTIFIERS_DISABLED', 'blocked')
  const gate = resolveEventAssignmentGate(input.lifecycleStatus)
  if (!gate.open) return decide(
    gate.reason === 'EVENT_LIFECYCLE_UNKNOWN' ? 'unknown' : 'ineligible',
    gate.reason, 'blocked',
  )

  // 2 — the participant
  const who = decideRegistrationEligibility(registration, input.options)
  if (!who.eligible) return { ...who, poolId: pool?.poolId ?? null }

  // 3 — the pass ↔ pool relationship
  const scope = decidePoolScope(pool, registration?.passId ?? null, ctx)
  if (!scope.eligible) return scope

  // 4 — what they already hold
  const existing = decideExistingIdentifier(current, input.requestedValue ?? null, pool?.poolId ?? null)
  if (!existing.eligible) return existing

  // 5 — is there anything left to give?
  const usage = input.poolUsage
  if (usage) {
    if (usage.state === 'unavailable') return decide('unknown', 'POOL_USAGE_UNAVAILABLE', 'blocked', pool?.poolId ?? null)
    if (usage.state === 'inconsistent') return decide('unknown', 'POOL_INCONSISTENT', 'blocked', pool?.poolId ?? null)
    if (usage.state === 'exhausted')    return decide('ineligible', 'POOL_EXHAUSTED', 'blocked', pool?.poolId ?? null)
    // An explicit value does not consume the sequence, so a full pool does not
    // block it — but an unlimited pool never blocks either way.
    if (usage.capacityKind === 'finite' && usage.available === 0 && !input.requestedValue) {
      return decide('ineligible', 'POOL_EXHAUSTED', 'blocked', pool?.poolId ?? null)
    }
  }

  return decide('eligible', null, existing.action, pool?.poolId ?? null)
}

// ════════════════════════════════════════════════════════════════════════════
// RANGE PREVIEW
// ════════════════════════════════════════════════════════════════════════════

export interface RangePreview {
  ranges:       IdentifierRange[]
  capacityKind: 'finite' | 'unlimited'
  capacity:     number | null
  /** The next number that would actually be issued, honouring gaps. */
  nextValue:    number | null
  /** The last number `count` sequential allocations would reach. */
  lastValue:    number | null
  /** How many of `count` the ranges can actually hold from `nextValue` on. */
  issuable:     number | null
  exhausted:    boolean
  /** Numbers skipped because they fall in a gap between configured ranges. */
  gapsCrossed:  number
}

/**
 * What a run of sequential allocations would produce, without allocating.
 *
 * Walks the ranges exactly as the engine does (`nextNumberInRanges`) so the
 * preview and the transaction cannot drift. A gap is JUMPED, never filled:
 * 5999 → 7000, and 6000–6999 are never offered because nobody printed them.
 *
 * Capacity comes from the configured ranges alone — never from the highest
 * number already issued, and the ranges are never merged.
 */
export function previewRangeAllocation(
  pool:  IdentifierPool,
  from:  number | null,
  count: number,
): RangePreview {
  const explicit = configuredRanges(pool)
  const all      = effectiveRanges(pool)

  if (all.length === 0) {
    return {
      ranges: [], capacityKind: 'unlimited', capacity: null,
      nextValue: from, lastValue: from === null ? null : from + Math.max(0, count - 1),
      issuable: count, exhausted: false, gapsCrossed: 0,
    }
  }

  const walk = explicit.length > 0 ? explicit : all
  const start = from ?? walk[0].start
  const first = nextNumberInRanges(walk, start)

  if (first === null) {
    return {
      ranges: all, capacityKind: 'finite', capacity: rangeCapacity(all),
      nextValue: null, lastValue: null, issuable: 0, exhausted: true, gapsCrossed: 0,
    }
  }

  let n = first
  let issued = 0
  let last = first
  let gaps = 0
  while (issued < count) {
    const at = nextNumberInRanges(walk, n)
    if (at === null) break
    if (at !== n) gaps += 1
    last = at
    issued += 1
    n = at + 1
  }

  return {
    ranges: all,
    capacityKind: 'finite',
    capacity: rangeCapacity(all),
    nextValue: first,
    lastValue: issued > 0 ? last : null,
    issuable: issued,
    exhausted: issued === 0,
    gapsCrossed: gaps,
  }
}

// ════════════════════════════════════════════════════════════════════════════
// ASSIGNMENT PREVIEW
// ════════════════════════════════════════════════════════════════════════════

export interface SkippedGroup {
  reason: DecisionReason
  count:  IdentifierMetric
}

export interface AssignmentPreviewScope {
  passId:     string | null
  passName:   string | null
  passExists: boolean
  poolIds:    string[]
  /** Registrations on this pass the ROSTER rule counts. */
  eligible:   IdentifierMetric
  /** Identifiers from these pools that are currently held. */
  alreadyAssigned: IdentifierMetric
  /**
   * Eligible participants still without an identifier.
   * UNKNOWN by construction — see UNASSIGNED_REQUIREMENT.
   */
  remaining:  IdentifierMetric
  capacityKind: 'finite' | 'unlimited'
  capacity:   number | null
  capacityAvailable: number | null
  /** How many would be assigned. UNKNOWN whenever `remaining` is. */
  wouldAssign: IdentifierMetric
  range:      RangePreview | null
  blockers:   Array<{ reason: DecisionReason; detail: string | null }>
  skipped:    SkippedGroup[]
}

export interface AssignmentPreview {
  selection: AssignmentSelection
  scopes:    AssignmentPreviewScope[]
  totals: {
    eligible:          IdentifierMetric
    alreadyAssigned:   IdentifierMetric
    remaining:         IdentifierMetric
    capacityAvailable: number | null
    wouldAssign:       IdentifierMetric
  }
  /** False when anything at all would stop a run. */
  ready:    boolean
  blockers: Array<{ scope: string | null; reason: DecisionReason; detail: string | null }>
  /** The eligibility disagreement, restated so a UI cannot omit it. */
  eligibilityPolicy: 'divergent' | 'aligned'
}

/**
 * RD-EVENT-19C · exactly what is missing before "assign to everyone who needs
 * one" can report a number instead of a guess.
 *
 * Firestore cannot count registrations WITHOUT an identifier: a registration that
 * never had one has no `identifier` field at all, and a missing field is absent
 * from the index, so `where('identifier','==',null)` matches only rows an
 * explicit release cleared. `eligible − assigned` is also unsound, because an
 * identifier lock carries no registration status — a lock held by a cancelled
 * registration would be subtracted from the eligible pool.
 *
 * THE PROPOSAL: a queryable boolean written in the SAME transaction as the
 * assignment (see `HAS_IDENTIFIER_FIELD`), which makes
 * `where(status).where(passId).where(hasIdentifier,'==',false).count()` exact and
 * bounded. It is additive and costs no extra write.
 *
 * IT IS NOT AUTHORITATIVE UNTIL BACKFILLED. Registrations that predate the field
 * are absent from the index, so the count would silently under-report — which is
 * precisely the false number this platform forbids. The backfill is a migration
 * and is therefore out of scope here; until it runs, every derived count stays
 * UNKNOWN.
 */
export const UNASSIGNED_REQUIREMENT =
  'Counting eligible participants without an identifier needs a queryable ' +
  'boolean on the registration, written in the same transaction as the ' +
  'assignment, plus a one-time backfill for registrations that predate it. ' +
  'Until that backfill runs the count is not authoritative and is reported as ' +
  'unknown; deriving it from eligible minus assigned is unsound because an ' +
  'identifier lock carries no registration status.'

/** The additive field name, declared once so nothing hardcodes a string. */
export const HAS_IDENTIFIER_FIELD = 'hasIdentifier'

/**
 * Builds the preview a future assignment UI consumes.
 *
 * Pure: every figure is supplied by the caller from bounded reads (RD-EVENT-19B
 * aggregates). It performs no I/O, so it can never become a registration scan.
 *
 * `remaining` and `wouldAssign` are UNKNOWN in this phase and say why — a preview
 * that guessed would be a preview that lied about how many people are about to
 * receive a printed identifier.
 */
export function buildAssignmentPreview(args: {
  selection: AssignmentSelection
  config:    IdentifierConfig
  lifecycleStatus: string | null | undefined
  /**
   * RD-EVENT-19E · the gate the SERVER already computed, used verbatim when
   * supplied. The browser is given `assignmentGate` rather than the raw lifecycle,
   * so without this it had to fabricate a lifecycle string to get a gate back —
   * a second lifecycle policy in the client, which is exactly what must not exist.
   */
  gate?:     EventAssignmentGate
  ctx:       PoolScopeContext
  /** Per-pool statistics from RD-EVENT-19B, keyed by poolId. */
  poolStats: Map<string, Pick<IdentifierPoolStat,
    'state' | 'capacity' | 'capacityKind' | 'available' | 'assigned' | 'consumed' | 'nextNumber' | 'stateReason'>>
  /** Per-pass eligible counts, when the caller has them. Absent ⇒ unknown. */
  eligibleByPass?: Map<string | null, number | null>
}): AssignmentPreview {
  const { selection, config, ctx, poolStats } = args

  const gate = args.gate ?? resolveEventAssignmentGate(args.lifecycleStatus)
  const blockers: AssignmentPreview['blockers'] = []
  if (!gate.open) blockers.push({ scope: null, reason: gate.reason!, detail: gate.detail })
  if (config.enabled === false) {
    blockers.push({ scope: null, reason: 'IDENTIFIERS_DISABLED', detail: 'Identifiers are switched off for this event.' })
  }

  const scopes = resolveSelectionScopes(selection, config, ctx).map<AssignmentPreviewScope>(scope => {
    const stats = scope.pools.map(p => poolStats.get(p.poolId)).filter(Boolean) as Array<NonNullable<ReturnType<typeof poolStats.get>>>
    const anyUnlimited = stats.some(s => s.capacityKind === 'unlimited') || stats.length < scope.pools.length
    const anyUnavailable = stats.some(s => s.state === 'unavailable')

    const sumOrNull = (pick: (s: typeof stats[number]) => number | null): number | null => {
      if (stats.length === 0 || stats.length < scope.pools.length) return null
      let total = 0
      for (const s of stats) { const v = pick(s); if (v === null) return null; total += v }
      return total
    }

    const capacity  = anyUnlimited ? null : sumOrNull(s => s.capacity)
    const available = anyUnlimited ? null : sumOrNull(s => s.available)
    const assigned  = sumOrNull(s => (s.assigned === null || s.consumed === null) ? null : s.assigned + s.consumed)

    const eligibleRaw = args.eligibleByPass?.get(scope.passId)
    const eligible: IdentifierMetric = typeof eligibleRaw === 'number'
      ? knownMetric(eligibleRaw)
      : unavailableMetric('The eligible participant count for this scope was not supplied.')

    const scopeBlockers: AssignmentPreviewScope['blockers'] = []
    if (scope.blocked) {
      scopeBlockers.push({
        reason: scope.blocked,
        detail: scope.blocked === 'POOL_PASS_DELETED'
          // RD-BIB-UX-02 · "pool" is an implementation word. The organizer configured
          // a number RANGE, and that is what the sentence has to name.
          ? 'This number range is linked to a pass that no longer exists on the event.'
          : 'No number range is configured for this pass, so nothing can be assigned to it.',
      })
    }
    for (const s of stats) {
      if (s.state === 'exhausted')    scopeBlockers.push({ reason: 'POOL_EXHAUSTED', detail: s.stateReason })
      if (s.state === 'unavailable')  scopeBlockers.push({ reason: 'POOL_USAGE_UNAVAILABLE', detail: s.stateReason })
      if (s.state === 'inconsistent') scopeBlockers.push({ reason: 'POOL_INCONSISTENT', detail: s.stateReason })
      if (s.state === 'orphaned')     scopeBlockers.push({ reason: 'POOL_PASS_DELETED', detail: s.stateReason })
    }
    for (const b of scopeBlockers) blockers.push({ scope: scope.passId, reason: b.reason, detail: b.detail })

    const firstPool = scope.pools[0] ?? null
    const firstStat = firstPool ? poolStats.get(firstPool.poolId) : undefined
    const range = firstPool
      ? previewRangeAllocation(firstPool, firstStat?.nextNumber ?? null, available ?? 0)
      : null

    const unknownRemaining = unavailableMetric(UNASSIGNED_REQUIREMENT)

    return {
      passId: scope.passId,
      passName: scope.passName,
      passExists: scope.passExists,
      poolIds: scope.pools.map(p => p.poolId),
      eligible,
      alreadyAssigned: assigned === null
        ? unavailableMetric('Identifier usage for this scope could not be read.')
        : knownMetric(assigned),
      remaining:   unknownRemaining,
      capacityKind: anyUnlimited ? 'unlimited' : 'finite',
      capacity,
      capacityAvailable: available,
      wouldAssign: unknownRemaining,
      range,
      blockers: scopeBlockers,
      skipped: anyUnavailable
        ? [{ reason: 'POOL_USAGE_UNAVAILABLE', count: unavailableMetric('Usage unreadable.') }]
        : [],
    }
  })

  const foldMetric = (pick: (s: AssignmentPreviewScope) => IdentifierMetric): IdentifierMetric => {
    let total = 0
    for (const s of scopes) {
      const m = pick(s)
      if (m.status !== 'known' || m.value === null) return unavailableMetric(m.reason ?? 'Unknown')
      total += m.value
    }
    return knownMetric(total)
  }

  // Totals are folded over the DISTINCT pools, never by adding up the scopes:
  // several passes may legitimately share one unrestricted pool, and summing the
  // scopes would count its capacity once per pass.
  const seenPools = new Set<string>()
  let capacityAvailable: number | null = 0
  let assignedTotal: number | null = 0
  for (const scope of scopes) {
    for (const poolId of scope.poolIds) {
      if (seenPools.has(poolId)) continue
      seenPools.add(poolId)
      const s = poolStats.get(poolId)
      if (!s || s.capacityKind === 'unlimited' || s.available === null) capacityAvailable = null
      else if (capacityAvailable !== null) capacityAvailable += s.available
      if (!s || s.assigned === null || s.consumed === null) assignedTotal = null
      else if (assignedTotal !== null) assignedTotal += s.assigned + s.consumed
    }
  }

  return {
    selection,
    scopes,
    totals: {
      eligible:        foldMetric(s => s.eligible),
      alreadyAssigned: assignedTotal === null
        ? unavailableMetric('Identifier usage could not be read for every pool in this selection.')
        : knownMetric(assignedTotal),
      remaining:       unavailableMetric(UNASSIGNED_REQUIREMENT),
      capacityAvailable,
      wouldAssign:     unavailableMetric(UNASSIGNED_REQUIREMENT),
    },
    ready: blockers.length === 0 && scopes.length > 0,
    blockers,
    // Taken from the 19A contract, not recomputed, so the two cannot drift.
    eligibilityPolicy: identifierPolicyIsDivergent() ? 'divergent' : 'aligned',
  }
}

/**
 * Whether any KNOWN registration status is treated differently by the engine and
 * the roster. Derived from the 19A constants so this file states no policy of
 * its own.
 */
export function identifierPolicyIsDivergent(): boolean {
  const engine = ENGINE_TERMINAL_STATUSES as readonly string[]
  const roster = ROSTER_STATUSES as readonly string[]
  return KNOWN_REGISTRATION_STATUSES.some(s => !engine.includes(s) && !roster.includes(s))
}
