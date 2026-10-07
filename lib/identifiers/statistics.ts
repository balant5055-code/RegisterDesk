// RD-EVENT-19B — Participant Identity Platform: the statistics READ MODEL.
//
// PURE. No I/O, no SDK, no Firestore. Raw counts go in, an honest read model comes
// out — so the API, a future allocation UI and a future bulk engine all reason
// about capacity through ONE implementation that can be tested without a network.
//
//   Firestore reads → raw nullable counts → THIS → API response
//
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  THE RULE OF THIS MODULE: a number that could not be read is `null`, and   ║
// ║  never 0. "Nobody has an identifier yet" and "we could not find out" are    ║
// ║  different facts, and only one of them is safe to print next to a button    ║
// ║  labelled "Assign".                                                        ║
// ╚══════════════════════════════════════════════════════════════════════════╝
//
// Nothing here knows what a pass, a sport or a bib is. Capacity is arithmetic over
// the ranges an organizer configured; every label is data.

import { effectiveRanges, rangeCapacity } from './ranges'
import { ENGINE_TERMINAL_STATUSES, ROSTER_STATUSES, KNOWN_STATUSES } from './eligibility'
import type { IdentifierConfig, IdentifierPool } from './types'

// ─── The metric contract ────────────────────────────────────────────────────

export type MetricStatus = 'known' | 'unavailable'

/**
 * A number the system either knows or admits it does not.
 *
 * Used where the distinction must survive serialization to the client. Inside the
 * pool/summary shapes the same idea is carried as `number | null`, which is the
 * convention the rest of the platform already uses (see lib/events/eventHome and
 * lib/attendance/attendanceView) — this type exists for the few places that also
 * need to explain WHY.
 */
export interface IdentifierMetric {
  value:  number | null
  status: MetricStatus
  reason: string | null
}

export const knownMetric = (value: number): IdentifierMetric =>
  ({ value, status: 'known', reason: null })

export const unavailableMetric = (reason: string): IdentifierMetric =>
  ({ value: null, status: 'unavailable', reason })

// ─── Capacity ───────────────────────────────────────────────────────────────

export type CapacityKind = 'finite' | 'unlimited'

export interface PoolCapacity {
  kind:     CapacityKind
  /** Total identifiers the configured ranges can provide; null when unlimited. */
  capacity: number | null
  reason:   string | null
}

/**
 * CONFIGURED CAPACITY — what the pool's ranges can provide, and nothing else.
 *
 *   5001–5999                    → 999
 *   5001–5999 + 7000–7500        → 999 + 501 = 1500      (the gap is NOT counted)
 *
 * Never inferred from registrations, from the highest assigned value, or from a
 * counter. Reuses the RD-EVENT-19A range helpers so the arithmetic exists once;
 * overlap is impossible here because `validatePools` rejects it before a config
 * can be stored.
 *
 * A pool with no closed range — none configured, or a half-bounded legacy pool
 * with only a `rangeStart` or only a `rangeEnd` — is UNLIMITED, not zero. There is
 * no honest total to report, and `0` would read as "exhausted".
 */
export function calculatePoolCapacity(pool: IdentifierPool): PoolCapacity {
  const ranges = effectiveRanges(pool)
  if (ranges.length === 0) {
    const halfBounded = pool.rangeStart != null || pool.rangeEnd != null
    return {
      kind: 'unlimited',
      capacity: null,
      reason: halfBounded
        ? 'Only one end of the range is set, so the pool has no configured total.'
        : null,
    }
  }
  return { kind: 'finite', capacity: rangeCapacity(ranges), reason: null }
}

// ─── Utilization ────────────────────────────────────────────────────────────

/**
 * How much of a finite pool is spoken for, as 0–1. Presentation formats it; the
 * domain never returns a percentage string and never returns a fabricated number.
 *
 *   0 / 100        → 0
 *   50 / 100       → 0.5
 *   100 / 100      → 1
 *   120 / 100      → 1.2      ← deliberately NOT clamped; see resolvePoolState
 *   unknown / 100  → null
 *   100 / unknown  → null
 *   unlimited      → null     ← an unlimited pool is not "100% full"
 */
export function calculateUtilization(used: number | null, capacity: number | null): number | null {
  if (used === null || capacity === null) return null
  if (capacity <= 0) return null
  return used / capacity
}

// ─── State ──────────────────────────────────────────────────────────────────

export type PoolUsageState =
  | 'unlimited'     // no finite capacity is configured
  | 'empty'         // finite capacity, nothing used yet
  | 'available'     // finite capacity, room left
  | 'exhausted'     // finite capacity, nothing left
  | 'inconsistent'  // more is in use than the ranges can hold
  | 'unavailable'   // usage could not be read
  | 'orphaned'      // every pass this pool serves is gone from the event

export interface PoolState {
  state:  PoolUsageState
  reason: string | null
}

/**
 * The pool's state, in a fixed order of precedence.
 *
 * `orphaned` outranks everything because a pool wired to a deleted pass cannot
 * receive an automatic allocation at all, whatever its capacity says.
 * `inconsistent` outranks `exhausted` because "120 of 100" is a data problem to
 * be shown, not a full bar to be drawn.
 *
 * DELIBERATELY ABSENT: `near_capacity`. RegisterDesk defines no such threshold
 * today, and inventing one here would establish a user-facing business rule in a
 * read-model phase. `utilization` is returned raw so a later phase can decide.
 */
export function resolvePoolState(args: {
  capacity:        PoolCapacity
  occupied:        number | null
  orphanedPassIds: string[]
  hasPassRestriction: boolean
}): PoolState {
  const { capacity, occupied, orphanedPassIds, hasPassRestriction } = args

  if (hasPassRestriction && orphanedPassIds.length > 0) {
    return {
      state: 'orphaned',
      reason: `No longer linked to a pass on this event (${orphanedPassIds.length} missing).`,
    }
  }
  if (occupied === null) {
    return { state: 'unavailable', reason: 'Identifier usage could not be read.' }
  }
  if (capacity.kind === 'unlimited') {
    return { state: 'unlimited', reason: capacity.reason }
  }
  const total = capacity.capacity ?? 0
  if (occupied > total) {
    return {
      state: 'inconsistent',
      reason: `${occupied} identifiers are in use but the configured ranges hold ${total}.`,
    }
  }
  if (occupied === 0) return { state: 'empty', reason: null }
  if (occupied >= total) return { state: 'exhausted', reason: null }
  return { state: 'available', reason: null }
}

// ─── Raw input ──────────────────────────────────────────────────────────────

/**
 * Per-pool lock counts exactly as the aggregates returned them. EVERY field is
 * independently nullable: one failed aggregate must not take the others with it.
 */
export interface PoolStateCounts {
  assigned: number | null
  consumed: number | null
  reserved: number | null
  blocked:  number | null
  retired:  number | null
  released: number | null
}

export const EMPTY_COUNTS: PoolStateCounts = {
  assigned: null, consumed: null, reserved: null, blocked: null, retired: null, released: null,
}

/** Everything the pure layer needs, gathered by the IO layer. */
export interface IdentifierUsage {
  /** poolId → counts. A pool absent from the map has unknown usage. */
  byPool:      Map<string, PoolStateCounts>
  /** poolId → the pool's next sequence number, or null when unreadable/unstarted. */
  nextNumbers: Map<string, number | null>
  /** Event-wide released-and-never-checked-in locks. */
  reusable:    number | null
  /** Registrations the ROSTER rule considers eligible; see EligibilityReport. */
  eligible:    number | null
  /** Locks recorded only in the pre-platform collection, if countable. */
  legacyLocks: number | null
  /**
   * RD-BIB-01 · passId → participant counts, from three equality-only aggregates.
   * A pass absent from the map was not counted; that is UNKNOWN, never zero.
   */
  byPass?:     Map<string, PassParticipantCounts>
  /**
   * RD-REPORT-03 · the SAME three-way split as a `byPass` row, but event-wide.
   *
   * Deliberately not a sum of `byPass`: that map is keyed by the passes the event
   * declares, so summing it would silently omit any confirmed registration whose
   * pass is missing, renamed or absent from the configuration. This is counted
   * directly against the roster instead.
   */
  roster?:     PassParticipantCounts
}

/**
 * RD-BIB-01 · what the roster says about ONE pass.
 *
 * `withIdentifier + withoutIdentifier < total` means some registrations carry no
 * `hasIdentifier` field at all — they predate it — so this pass cannot yet be
 * answered for exactly. That difference is reported, not absorbed.
 */
export interface PassParticipantCounts {
  total:             number | null
  withIdentifier:    number | null
  withoutIdentifier: number | null
}

/** Why a pass's "will assign" figure is not yet exact. */
export const PASS_COVERAGE_UNKNOWN_REASON =
  'Some registrations on this pass predate identifier tracking, so the number still needing one cannot be counted exactly.'

/**
 * RD-BIB-UX-02 · why a pass has no figures AT ALL, in words an organizer can act on.
 *
 * This slot used to be filled with `UNASSIGNED_UNKNOWN_REASON`, which is an
 * engineering note about denormalized flags and counter soundness — correct, and
 * addressed to the wrong reader. It reaches the plan card whenever a pass was not
 * counted: past `MAX_STAT_PASSES`, or when its aggregates failed.
 */
export const PASS_NOT_COUNTED_REASON =
  'This pass was not counted on this screen. Reload to try again, or select it on its own to see its figures.'

/**
 * RD-BIB-01 · turns the three raw counts into the four figures the plan shows, and
 * refuses to guess.
 *
 * `willAssign` is NOT `total − withIdentifier`. That subtraction was rejected in
 * RD-EVENT-19B and is rejected again here: it silently treats a registration the
 * field does not cover as one that needs a number, which is how an organizer ends up
 * being promised 600 numbers and issued 583.
 */
export function summarizePassParticipants(
  counts: PassParticipantCounts | undefined,
  absentReason: string,
): { total: IdentifierMetric; assigned: IdentifierMetric; willAssign: IdentifierMetric; uncounted: number | null } {
  if (!counts) {
    return {
      total:      unavailableMetric(absentReason),
      assigned:   unavailableMetric(absentReason),
      willAssign: unavailableMetric(absentReason),
      uncounted:  null,
    }
  }
  const { total, withIdentifier, withoutIdentifier } = counts
  const totalM    = total          === null ? unavailableMetric(absentReason) : knownMetric(total)
  const assignedM = withIdentifier === null ? unavailableMetric(absentReason) : knownMetric(withIdentifier)

  if (total === null || withIdentifier === null || withoutIdentifier === null) {
    return { total: totalM, assigned: assignedM, willAssign: unavailableMetric(absentReason), uncounted: null }
  }
  const uncounted = total - (withIdentifier + withoutIdentifier)
  return {
    total: totalM,
    assigned: assignedM,
    // Exact only when every registration on the pass is accounted for by the field.
    willAssign: uncounted === 0 ? knownMetric(withoutIdentifier) : unavailableMetric(PASS_COVERAGE_UNKNOWN_REASON),
    uncounted: uncounted > 0 ? uncounted : 0,
  }
}

/** Context the read model needs but must never pay a Firestore read to obtain. */
export interface ReadModelContext {
  /** The event's passes, from the draft document the scope resolver already read. */
  passes:      Array<{ id: string; name: string }>
  /** False when the event's passes could not be established (never guess orphans). */
  passesKnown: boolean
}

// ─── Pool summary ───────────────────────────────────────────────────────────

export interface IdentifierPoolStat {
  poolId:     string
  label:      string
  /** The event's identifier name ("Delegate ID", "Bib Number"…). Always data. */
  identifierLabel: string
  isDefault:  boolean
  prefix:     string
  padding:    number
  /** Legacy scalar bounds, echoed unchanged for existing consumers. */
  rangeStart: number | null
  rangeEnd:   number | null
  ranges:     Array<{ start: number; end: number }>
  passIds:    string[] | null
  matchRuleBy: string | null
  capacityKind: CapacityKind
  /** CONFIGURED capacity. null ⇒ unlimited, never "zero". */
  capacity:   number | null
  nextNumber: number | null
  assigned:   number | null
  consumed:   number | null
  reserved:   number | null
  blocked:    number | null
  retired:    number | null
  released:   number | null
  /** assigned + consumed + reserved + blocked + retired — the values not free to issue. */
  occupied:   number | null
  /** capacity − occupied. null when unlimited, unreadable, or inconsistent. */
  available:  number | null
  utilization: number | null
  state:      PoolUsageState
  stateReason: string | null
  /** Passes this pool names that no longer exist on the event. */
  orphanedPassIds: string[]
}

/** Lock states that mean the value is not free to be issued to somebody new. */
const OCCUPYING = ['assigned', 'consumed', 'reserved', 'blocked', 'retired'] as const

/**
 * Sums nullable parts. ANY unknown part makes the sum unknown — a total assembled
 * from half the data is a wrong number wearing a confident face.
 */
export function sumMetrics(parts: Array<number | null>): number | null {
  let total = 0
  for (const p of parts) {
    if (p === null) return null
    total += p
  }
  return total
}

export function summarizePool(
  pool:    IdentifierPool,
  config:  IdentifierConfig,
  counts:  PoolStateCounts,
  ctx:     ReadModelContext,
  nextNumber: number | null = null,
): IdentifierPoolStat {
  const capacity = calculatePoolCapacity(pool)
  const occupied = sumMetrics(OCCUPYING.map(k => counts[k]))

  const declaredPasses = Array.isArray(pool.passIds) && pool.passIds.length > 0 ? pool.passIds : null
  // Only claimable when the event's passes are actually known. If they are not,
  // every pool would look orphaned — the safest answer is "no orphans found".
  const known = new Set(ctx.passes.map(p => p.id))
  const orphanedPassIds = ctx.passesKnown && declaredPasses
    ? declaredPasses.filter(id => !known.has(id))
    : []

  const state = resolvePoolState({
    capacity, occupied, orphanedPassIds, hasPassRestriction: declaredPasses !== null,
  })

  // `available` is reported ONLY when it is a real remainder. An inconsistent pool
  // has no honest "left" figure, so it gets null rather than a clamped 0.
  const available =
    capacity.kind === 'unlimited' || capacity.capacity === null || occupied === null
      ? null
      : state.state === 'inconsistent'
        ? null
        : Math.max(0, capacity.capacity - occupied)

  return {
    poolId: pool.poolId,
    label:  pool.label,
    identifierLabel: config.label,
    isDefault: pool.poolId === config.defaultPoolId,
    prefix:  pool.prefix  ?? config.format.prefix  ?? '',
    padding: pool.padding ?? config.format.padding ?? 0,
    rangeStart: pool.rangeStart ?? null,
    rangeEnd:   pool.rangeEnd ?? null,
    ranges:  effectiveRanges(pool),
    passIds: declaredPasses ? [...declaredPasses] : null,
    matchRuleBy: pool.matchRule?.by ?? null,
    capacityKind: capacity.kind,
    capacity: capacity.capacity,
    nextNumber,
    assigned: counts.assigned,
    consumed: counts.consumed,
    reserved: counts.reserved,
    blocked:  counts.blocked,
    retired:  counts.retired,
    released: counts.released,
    occupied,
    available,
    utilization: calculateUtilization(occupied, capacity.capacity),
    state: state.state,
    stateReason: state.reason,
    orphanedPassIds,
  }
}

// ─── Pass scopes ────────────────────────────────────────────────────────────

export interface PassScopeStat {
  /** null ⇒ the unrestricted scope (pools that name no pass). */
  passId:    string | null
  passName:  string | null
  /** False ⇒ the pool names a pass this event no longer has. */
  passExists: boolean
  poolIds:   string[]
  capacityKind: CapacityKind
  capacity:  number | null
  assigned:  number | null
  consumed:  number | null
  occupied:  number | null
  available: number | null
  utilization: number | null
  /**
   * Registrations on this pass the roster rule would list.
   * UNKNOWN in RD-EVENT-19B — see EligibilityReport.unassignedReason.
   */
  eligible:  IdentifierMetric
  /**
   * Eligible registrations still without an identifier — i.e. how many numbers a run
   * would actually issue. EXACT since RD-BIB-01 when hasIdentifier covers the roster.
   */
  unassignedEligible: IdentifierMetric
  /** RD-BIB-01 · eligible registrations that already hold one. */
  participantsWithIdentifier: IdentifierMetric
  /** RD-BIB-01 · registrations the countable field does not cover yet. 0 ⇒ fully covered. */
  uncountedParticipants: number | null
}

/**
 * Folds pool statistics into per-pass scopes.
 *
 * MULTIPLE POOLS PER PASS is first-class: a pass served by 5001–5999 and
 * 7000–7500 has a scope capacity of 1500, while both pools remain separate
 * objects — the allocator still needs pool identity, so nothing is collapsed.
 *
 * A pass appears here when a pool names it. A pool naming no pass contributes to
 * the single unrestricted scope (`passId: null`).
 *
 * ORDERING is deterministic: the event's own pass order first, then any pool-only
 * (orphaned) pass id in configuration order, then the unrestricted scope last.
 * Never Firestore document order.
 */
export function summarizePassScopes(
  pools: IdentifierPoolStat[],
  ctx:   ReadModelContext,
  eligibilityReason: string,
  /** RD-BIB-01 · per-pass participant counts. Absent ⇒ every figure stays UNKNOWN. */
  participants?: Map<string, PassParticipantCounts>,
): PassScopeStat[] {
  const byPass = new Map<string, IdentifierPoolStat[]>()
  const unrestricted: IdentifierPoolStat[] = []

  for (const pool of pools) {
    if (!pool.passIds || pool.passIds.length === 0) { unrestricted.push(pool); continue }
    for (const passId of pool.passIds) {
      const list = byPass.get(passId) ?? []
      list.push(pool)
      byPass.set(passId, list)
    }
  }

  const nameOf = new Map(ctx.passes.map(p => [p.id, p.name]))
  // RD-BIB-UX-02 · EVERY pass the event has, not only the ones a range is wired to.
  //
  // This list used to be derived from the POOLS, so a pass with no configured range
  // produced no scope at all. The plan screen looks its stats up by passId, found
  // nothing, and rendered "Total participants —  ·  This pass could not be counted"
  // — for a pass whose participant count had just been counted exactly, two lines
  // earlier, by an aggregate that was then thrown away.
  //
  // "This pass has no numbers configured" and "we could not count this pass" are
  // different facts and only one of them was true. A pool-less scope now carries the
  // real participant figures with an EMPTY `poolIds`, which is what tells a consumer
  // that nothing can be issued here — the decision layer raises POOL_MISSING for it
  // exactly as before, so no pass has become assignable that was not before.
  const ordered: string[] = [
    ...ctx.passes.map(p => p.id),
    ...[...byPass.keys()].filter(id => !nameOf.has(id)),
  ]

  const scope = (passId: string | null, members: IdentifierPoolStat[]): PassScopeStat => {
    const anyUnlimited = members.some(p => p.capacityKind === 'unlimited')
    const capacity  = anyUnlimited ? null : sumMetrics(members.map(p => p.capacity))
    const assigned  = sumMetrics(members.map(p => p.assigned))
    const consumed  = sumMetrics(members.map(p => p.consumed))
    const occupied  = sumMetrics(members.map(p => p.occupied))
    const available = anyUnlimited ? null : sumMetrics(members.map(p => p.available))
    return {
      passId,
      passName: passId === null ? null : (nameOf.get(passId) ?? null),
      passExists: passId === null ? true : (!ctx.passesKnown || nameOf.has(passId)),
      poolIds: members.map(p => p.poolId),
      capacityKind: anyUnlimited ? 'unlimited' : 'finite',
      capacity, assigned, consumed, occupied, available,
      utilization: calculateUtilization(occupied, capacity),
      ...(() => {
        // RD-BIB-01 · exact when the roster is fully covered by hasIdentifier,
        // UNKNOWN — with the reason — when it is not. Never a subtraction.
        const p = passId === null ? undefined : participants?.get(passId)
        const sum = summarizePassParticipants(p, eligibilityReason)
        return {
          eligible:           sum.total,
          participantsWithIdentifier: sum.assigned,
          unassignedEligible: sum.willAssign,
          uncountedParticipants: sum.uncounted,
        }
      })(),
    }
  }

  const out = ordered.map(passId => scope(passId, byPass.get(passId) ?? []))
  if (unrestricted.length > 0) out.push(scope(null, unrestricted))
  return out
}

// ─── Event summary ──────────────────────────────────────────────────────────

export interface IdentifierSummary {
  capacityKind: CapacityKind | 'mixed'
  /** null when any pool is unlimited or any capacity is unknown. */
  configuredCapacity: number | null
  assigned:  number | null
  consumed:  number | null
  reserved:  number | null
  blocked:   number | null
  retired:   number | null
  released:  number | null
  reusable:  number | null
  occupied:  number | null
  available: number | null
  utilization: number | null
  poolsTotal:        number
  poolsExhausted:    number
  poolsUnavailable:  number
  poolsOrphaned:     number
  poolsInconsistent: number
}

export function summarizeIdentifiers(
  pools:    IdentifierPoolStat[],
  reusable: number | null,
): IdentifierSummary {
  const finite    = pools.filter(p => p.capacityKind === 'finite')
  const unlimited = pools.length - finite.length
  const capacityKind: CapacityKind | 'mixed' =
    pools.length === 0 ? 'finite'
    : unlimited === pools.length ? 'unlimited'
    : unlimited > 0 ? 'mixed'
    : 'finite'

  // An unlimited pool anywhere means the EVENT has no configured total. Summing
  // only the finite pools would understate it and read as a real ceiling.
  const configuredCapacity = unlimited > 0 ? null : sumMetrics(finite.map(p => p.capacity))
  const occupied  = sumMetrics(pools.map(p => p.occupied))
  const available = unlimited > 0 ? null : sumMetrics(pools.map(p => p.available))

  return {
    capacityKind,
    configuredCapacity,
    assigned: sumMetrics(pools.map(p => p.assigned)),
    consumed: sumMetrics(pools.map(p => p.consumed)),
    reserved: sumMetrics(pools.map(p => p.reserved)),
    blocked:  sumMetrics(pools.map(p => p.blocked)),
    retired:  sumMetrics(pools.map(p => p.retired)),
    released: sumMetrics(pools.map(p => p.released)),
    reusable,
    occupied,
    available,
    utilization: calculateUtilization(occupied, configuredCapacity),
    poolsTotal:        pools.length,
    poolsExhausted:    pools.filter(p => p.state === 'exhausted').length,
    poolsUnavailable:  pools.filter(p => p.state === 'unavailable').length,
    poolsOrphaned:     pools.filter(p => p.state === 'orphaned').length,
    poolsInconsistent: pools.filter(p => p.state === 'inconsistent').length,
  }
}

// ─── Eligibility report ─────────────────────────────────────────────────────

/**
 * RD-EVENT-19A established that "who may hold an identifier" has two answers in
 * production and deliberately did not pick one. RD-EVENT-19B does not pick one
 * either — it reports the disagreement so RD-EVENT-19C can resolve it on purpose.
 */
export interface EligibilityReport {
  policy: 'divergent' | 'aligned'
  engineTerminalStatuses: string[]
  rosterStatuses:         string[]
  /** Statuses the engine would allocate to but the roster never lists. */
  divergentStatuses:      string[]
  /** Registrations the ROSTER rule counts. Known — one aggregate, zero documents. */
  eligible:               IdentifierMetric
  /**
   * Eligible registrations with no identifier yet.
   *
   * RD-REPORT-03 · EXACT when the caller supplies the event-wide roster split and
   * `hasIdentifier` covers every confirmed registration. UNKNOWN otherwise — see
   * `unassignedReason`. Never a subtraction across collections.
   */
  unassignedEligible:     IdentifierMetric
  /** RD-REPORT-03 · eligible registrations that already hold one. */
  assignedEligible:       IdentifierMetric
  /**
   * RD-REPORT-03 · confirmed registrations the countable field cannot answer for
   * (written before `hasIdentifier` existed). 0 ⇒ fully covered; null ⇒ not measured.
   * Any value above 0 is why `unassignedEligible` is UNKNOWN.
   */
  uncountedEligible:      number | null
  /** Exactly what is missing, for RD-EVENT-19C. */
  unassignedReason:       string
}

/**
 * The single sentence that explains every UNKNOWN "unassigned" figure in this
 * phase, and names the data-model change that would make it knowable.
 *
 * Firestore cannot count "registrations without an identifier": a registration
 * that never had one has NO `identifier` field, and a missing field is absent
 * from the index, so `where('identifier','==',null)` matches only the rows that
 * were explicitly cleared by a release. Deriving it as eligible − assigned is
 * also wrong, because an identifier lock carries no registration status: a lock
 * held by a cancelled registration would be subtracted from the eligible pool.
 */
export const UNASSIGNED_UNKNOWN_REASON =
  'No authoritative counter exists. Counting registrations without an identifier ' +
  'requires either a queryable denormalized flag on the registration (set in the ' +
  'same transaction as the assignment) or a per-pass assigned counter. Deriving it ' +
  'from eligible minus assigned is unsound because identifier locks carry no ' +
  'registration status.'

/**
 * RD-REPORT-03 · `roster` is OPTIONAL and every existing caller omits it, keeping
 * byte-identical behaviour: without it the unassigned figure stays UNKNOWN with the
 * same reason it has always carried.
 *
 * With it, the figure becomes exact — and the objection recorded in
 * UNASSIGNED_UNKNOWN_REASON no longer applies, because these counts come from the
 * REGISTRATION side. Both halves are drawn from one population (this organizer,
 * this event, status confirmed), so nothing is subtracted across collections and no
 * lock held by a cancelled entrant can enter the arithmetic.
 */
export function buildEligibilityReport(
  eligible: number | null,
  roster?:  PassParticipantCounts,
): EligibilityReport {
  const engine = [...ENGINE_TERMINAL_STATUSES]
  const rosterStatusList = [...ROSTER_STATUSES]
  // A status the engine would allocate to, that the roster never surfaces.
  const divergentStatuses = KNOWN_STATUSES
    .filter(s => !engine.includes(s as typeof engine[number]))
    .filter(s => !rosterStatusList.includes(s as typeof rosterStatusList[number]))

  // Reuses the per-pass fold, so the event-wide row and a pass row can never apply
  // different rules to the same three numbers.
  const split = roster
    ? summarizePassParticipants(roster, UNASSIGNED_UNKNOWN_REASON)
    : null

  return {
    policy: divergentStatuses.length > 0 ? 'divergent' : 'aligned',
    engineTerminalStatuses: engine,
    rosterStatuses:         rosterStatusList,
    divergentStatuses,
    eligible: eligible === null
      ? unavailableMetric('The eligible registration count could not be read.')
      : knownMetric(eligible),
    unassignedEligible: split ? split.willAssign : unavailableMetric(UNASSIGNED_UNKNOWN_REASON),
    assignedEligible:   split ? split.assigned   : unavailableMetric(UNASSIGNED_UNKNOWN_REASON),
    uncountedEligible:  split ? split.uncounted  : null,
    unassignedReason:   UNASSIGNED_UNKNOWN_REASON,
  }
}

// ─── The whole read model ───────────────────────────────────────────────────

export interface IdentifierReadModel {
  eventSlug:   string
  label:       string
  configured:  boolean
  pools:       IdentifierPoolStat[]
  summary:     IdentifierSummary
  passScopes:  PassScopeStat[]
  eligibility: EligibilityReport
  /** Locks recorded only in the pre-platform collection. Reported, never summed. */
  legacyLocks: IdentifierMetric
  /** False ⇒ orphaned-pass detection was skipped rather than guessed. */
  passesKnown: boolean
}

/**
 * Assembles the read model. Pure: every Firestore read has already happened.
 *
 * Pool order follows the CONFIGURATION array, never Firestore document order, so
 * two identical requests always produce identical output.
 */
export function buildIdentifierReadModel(args: {
  eventSlug:  string
  config:     IdentifierConfig
  configured: boolean
  usage:      IdentifierUsage
  ctx:        ReadModelContext
}): IdentifierReadModel {
  const { eventSlug, config, configured, usage, ctx } = args

  const pools = config.pools.map(pool => summarizePool(
    pool, config,
    usage.byPool.get(pool.poolId) ?? EMPTY_COUNTS,
    ctx,
    usage.nextNumbers.get(pool.poolId) ?? null,
  ))

  const eligibility = buildEligibilityReport(usage.eligible, usage.roster)

  return {
    eventSlug,
    label:  config.label,
    configured,
    pools,
    summary: summarizeIdentifiers(pools, usage.reusable),
    // RD-BIB-01 · the per-pass counts, when the caller read them. Without them every
    // per-pass figure reports UNKNOWN with the 19B reason, exactly as before.
    // RD-BIB-UX-02 · the PER-PASS absent reason is read by a person on the plan card,
    // so it is the human sentence. `eligibility.unassignedReason` below still carries
    // the engineering note verbatim — that field is documentation for an API reader
    // and nothing about it has changed.
    passScopes: summarizePassScopes(pools, ctx, PASS_NOT_COUNTED_REASON, usage.byPass),
    eligibility,
    legacyLocks: usage.legacyLocks === null
      ? unavailableMetric('The legacy identifier lock count could not be read.')
      : knownMetric(usage.legacyLocks),
    passesKnown: ctx.passesKnown,
  }
}
