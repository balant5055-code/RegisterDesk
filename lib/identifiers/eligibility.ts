// RD-EVENT-19A — Participant Identity Platform: the ONE eligibility contract.
//
// PURE. No I/O, no SDK. Reads two structural fields so the server document, a
// projected roster row and a cached shape can all be judged by the same rule.
//
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  THIS MODULE DOES NOT DECIDE PRODUCT POLICY. It states, in one place,      ║
// ║  the two rules that are ALREADY in force and disagree with each other.     ║
// ╚══════════════════════════════════════════════════════════════════════════╝
//
// The RD-EVENT-18 audit found that "who may hold an identifier" has two
// different answers in production today:
//
//   • THE ENGINE (lib/identifiers/engine.allocateIdentifier) refuses exactly two
//     statuses — `cancelled` and `rejected`. Everything else, including
//     `pending` and `waitlisted`, is allocatable.
//
//   • THE ROSTER (/api/organizer/events/[eventId]/bibs) only ever LISTS
//     `confirmed` registrations, so an organizer can neither see nor select
//     anyone else — the narrower rule is enforced by absence, not by a check.
//
// Guessing a single answer here would silently broaden or narrow who gets an
// identifier, which is not a refactor — it is a product decision with printed
// consequences. So both rules are named, both are exposed, and the gap between
// them is reported as `divergent`. RD-EVENT-19C resolves it deliberately.
//
// Until then: `assignable` reproduces the engine's rule EXACTLY, and the engine
// calls it, so there is one implementation rather than two.

import type { IdentifierPool } from './types'

/** The two fields any shape must offer. Both are read defensively. */
export interface EligibilitySubject {
  status?:        unknown
  paymentStatus?: unknown
}

export type IdentifierIneligibility =
  | 'CANCELLED'
  | 'REJECTED'
  | 'NOT_ON_ROSTER'     // a status the roster does not surface (pending / waitlisted / …)
  | 'UNKNOWN_STATUS'    // missing or unrecognised — reported, never silently accepted

/**
 * Statuses the ENGINE refuses. Unchanged from before RD-EVENT-19A: this is a
 * transcription of the existing check, not a new policy.
 */
export const ENGINE_TERMINAL_STATUSES = ['cancelled', 'rejected'] as const

/**
 * Statuses today's identifier ROSTER surfaces. `/bibs` queries
 * `.where('status','==','confirmed')`, so this is that query written down.
 */
export const ROSTER_STATUSES = ['confirmed'] as const

/** Every status the registration model defines. Anything else is UNKNOWN_STATUS. */
export const KNOWN_STATUSES = [
  'confirmed', 'cancelled', 'waitlisted', 'pending', 'rejected',
] as const

export interface IdentifierEligibility {
  /** May the engine allocate to this registration right now? (engine rule) */
  assignable:     boolean
  /** Why not, when `assignable` is false. */
  blockedBy:      IdentifierIneligibility | null
  /** Would today's organizer roster list this registration at all? (roster rule) */
  rosterVisible:  boolean
  /** The two rules disagree — surfaced for RD-EVENT-19C, never auto-resolved. */
  divergent:      boolean
  /** The status is absent or outside the known union. */
  unknownStatus:  boolean
}

const asStatus = (v: unknown): string => (typeof v === 'string' ? v : '')

/**
 * The engine's rule, alone — the exact predicate `allocateIdentifier` enforces.
 * Returns the blocking reason, or null when allocation may proceed.
 */
export function identifierAssignmentBlockedBy(
  reg: EligibilitySubject,
): 'CANCELLED' | 'REJECTED' | null {
  const status = asStatus(reg?.status)
  if (status === 'cancelled') return 'CANCELLED'
  if (status === 'rejected')  return 'REJECTED'
  return null
}

/** Whether today's identifier roster would list this registration. */
export function identifierRosterVisible(reg: EligibilitySubject): boolean {
  return (ROSTER_STATUSES as readonly string[]).includes(asStatus(reg?.status))
}

/**
 * The full picture: both rules and the gap between them.
 *
 * Read `assignable` when you are about to allocate. Read `rosterVisible` when you
 * are deciding what to show. Read `divergent` when you need to know that those
 * two answers are not the same — a `pending` registration is divergent today.
 *
 * `paymentStatus` is accepted and carried but does NOT block: the identifier
 * engine has never consulted it, and check-in's separate `REFUNDED` block
 * (lib/registrations/checkinEligibility) is a gate rule, not an assignment rule.
 * Conflating them here would quietly change who can be issued an identifier.
 */
export function identifierEligibility(reg: EligibilitySubject): IdentifierEligibility {
  const status        = asStatus(reg?.status)
  const unknownStatus = !(KNOWN_STATUSES as readonly string[]).includes(status)
  const engineBlock   = identifierAssignmentBlockedBy(reg)
  const rosterVisible = identifierRosterVisible(reg)
  const assignable    = engineBlock === null

  const blockedBy: IdentifierIneligibility | null =
    engineBlock ?? (unknownStatus ? 'UNKNOWN_STATUS' : rosterVisible ? null : 'NOT_ON_ROSTER')

  return {
    assignable,
    // `blockedBy` names the strictest applicable reason even when `assignable`
    // is true, so a caller that wants the roster rule does not have to re-derive
    // it — and an unknown status is never reported as simply fine.
    blockedBy,
    rosterVisible,
    divergent: assignable !== rosterVisible,
    unknownStatus,
  }
}

// ─── Pass scoping (used with, not instead of, status) ───────────────────────

/**
 * Whether a registration's pass falls inside a pool's declared pass set.
 *
 * An ABSENT or EMPTY `passIds` is "no pass restriction declared" — NOT "all
 * passes" — so this returns false and the caller falls back to the pool's other
 * matching rules. Treating `[]` as a wildcard would let a pass-scoped allocation
 * quietly spill into an unrelated pool, which is exactly the failure a pass-wise
 * range configuration exists to prevent.
 */
export function poolAcceptsPass(
  pool:   Pick<IdentifierPool, 'passIds'>,
  passId: string | null | undefined,
): boolean {
  if (!passId) return false
  const ids = pool?.passIds
  if (!Array.isArray(ids) || ids.length === 0) return false
  return ids.includes(passId)
}

/**
 * RD-BIB-01 · has this event opted into PASS-WISE numbering?
 *
 * ═══ WHY THIS PREDICATE EXISTS ═══════════════════════════════════════════════
 * `resolvePool` ends in a default-pool fallback, and an unrestricted pool (one that
 * names no pass) serves everybody. Together those two facts meant a pass with no
 * range of its own was not refused — it was quietly served from the default pool.
 * Observed in the audit: a 10 KM entrant on an event whose 10 KM pool was missing
 * received number 900 from `default`, and on a freshly-defaulted config the default
 * pool is unbounded, so the number would have been 1.
 *
 * For an event that never configured pass scoping that fallback is CORRECT and must
 * not change: one pool, everybody in it, exactly as it has always worked.
 *
 * The moment any pool names a pass, the organizer has declared that numbers belong
 * to passes. From then on a pass with no pool of its own is a CONFIGURATION GAP, not
 * an invitation to use somebody else's numbers.
 *
 * This is the one predicate that decides which world an event is in, and both the
 * engine and the planner read it, so they cannot drift apart again.
 */
export function eventUsesPassScopedPools(
  pools: readonly Pick<IdentifierPool, 'passIds' | 'matchRule'>[] | null | undefined,
): boolean {
  if (!Array.isArray(pools)) return false
  return pools.some(p =>
    (Array.isArray(p?.passIds) && p.passIds.length > 0) ||
    (p?.matchRule?.by === 'pass' && p.matchRule.values.length > 0),
  )
}

/**
 * RD-BIB-01 · every pool that may serve `passId`, under the rule above.
 *
 * On a pass-scoped event only pools that NAME the pass qualify; an unrestricted pool
 * is not a catch-all. On a legacy event the unrestricted pools are returned, which is
 * the pre-existing behaviour verbatim.
 *
 * Returning an empty array is a real answer — "this pass has no numbers configured" —
 * and every caller is required to treat it as a stop, never as a reason to guess.
 */
export function poolsForPass<T extends Pick<IdentifierPool, 'passIds' | 'matchRule'>>(
  pools:  readonly T[],
  passId: string | null | undefined,
): T[] {
  const scoped = pools.filter(p =>
    poolAcceptsPass(p, passId) ||
    (p?.matchRule?.by === 'pass' && !!passId && p.matchRule.values.includes(passId)),
  )
  if (scoped.length > 0) return scoped
  if (eventUsesPassScopedPools(pools)) return []       // gap, not a fallback
  return pools.filter(p =>
    (!Array.isArray(p?.passIds) || p.passIds.length === 0) && p?.matchRule?.by !== 'pass',
  )
}
