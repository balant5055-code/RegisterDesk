// RD-EVENT-19D — Identifier workspace: the PRESENTATION model.
//
// PURE. No I/O, no React, no SDK. Turns the RD-EVENT-19B statistics and the
// RD-EVENT-19C decisions into the handful of judgements the configuration and
// planning screens render — so "are there enough identifiers?" is answered once,
// in a file that can be tested without a browser.
//
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  THE RULE OF THIS MODULE: never turn an unknown into a number, and never   ║
// ║  draw a meter for a proportion that does not exist. An organizer is about  ║
// ║  to print these; "286 remaining" that turns out to be a guess is worse     ║
// ║  than "we cannot tell you yet".                                           ║
// ╚══════════════════════════════════════════════════════════════════════════╝
//
// Nothing here knows what a bib is. The identifier's NAME is configuration and
// travels as data through every function below.

import { rangeCapacity, describeRanges } from './ranges'
import type { IdentifierRange } from './types'
import type { IdentifierPoolStat, IdentifierSummary } from './statistics'
import type { DecisionReason, EventAssignmentGate } from './assignmentDecision'
import type { AccentTone } from '@/lib/dashboard/accents'

// ─── Gaps ───────────────────────────────────────────────────────────────────

/**
 * The stretches BETWEEN configured ranges.
 *
 * 5001–5999 and 7000–7500 leave 6000–6999 unconfigured. The organizer chose that
 * on purpose — those numbers were never printed — so the screen names the gap
 * rather than quietly letting the reader assume 5001–7500 is one block. A gap is
 * NOT capacity and is never added to a total.
 */
export function rangeGaps(ranges: IdentifierRange[]): IdentifierRange[] {
  if (ranges.length < 2) return []
  const sorted = [...ranges].sort((a, b) => a.start - b.start)
  const gaps: IdentifierRange[] = []
  for (let i = 1; i < sorted.length; i++) {
    const prevEnd = sorted[i - 1].end
    const nextStart = sorted[i].start
    if (nextStart > prevEnd + 1) gaps.push({ start: prevEnd + 1, end: nextStart - 1 })
  }
  return gaps
}

/** Identifiers a set of ranges provides. The gap is excluded by construction. */
export const totalRangeCapacity = (ranges: IdentifierRange[]): number => rangeCapacity(ranges)

/**
 * RD-BIB-UX-02 · "a BIB Number", but "an Entry Number".
 *
 * The identifier's name is configuration, so the article in front of it cannot be
 * written into the copy. An event labelled "Entry Number" read "Need a Entry Number"
 * on every card. This is a spelling rule, not a language model: it looks at the first
 * letter, which is right for every label the product can plausibly carry.
 */
export const article = (noun: string): string =>
  /^[aeiou]/i.test(noun.trim()) ? 'an' : 'a'

// ─── The one derivation that IS sound ───────────────────────────────────────

/**
 * A LOWER BOUND on how many eligible participants still need an identifier.
 *
 * RD-EVENT-19B and 19C both refuse to report `unassignedEligible`, and they are
 * right: nothing joins "is eligible" to "holds one" cheaply, so the exact figure
 * is unknown. But a BOUND is not a guess, and this one is provable:
 *
 *   `assigned` counts identifier LOCKS. Each lock belongs to at most one
 *   registration, so the number of ELIGIBLE registrations holding one is at most
 *   `assigned`. Therefore
 *       unassignedEligible = eligible − eligibleHolders ≥ eligible − assigned.
 *
 * It is returned as a floor and must be LABELLED as one ("at least N"). It is
 * never presented as the answer, and `unassignedEligible` stays unknown.
 *
 * Returns null when either input is unknown — a bound built on a guess is a guess.
 */
export function minimumStillNeeding(
  eligible: number | null, assigned: number | null,
): number | null {
  if (eligible === null || assigned === null) return null
  return Math.max(0, eligible - assigned)
}

// ─── Readiness ──────────────────────────────────────────────────────────────

export type ReadinessState =
  | 'not_configured'  // no identifier configuration exists yet
  | 'locked'          // the event's lifecycle forbids assignment
  | 'conflict'        // a pool cannot be used as configured
  | 'unknown'         // statistics could not be read
  | 'insufficient'    // provably not enough identifiers
  | 'warning'         // may be enough; the exact need is unknown
  | 'ready'           // provably enough

export interface Readiness {
  state:       ReadinessState
  /** Short label. Never colour alone — always paired with this word and an icon. */
  label:       string
  /** One sentence a person can act on. */
  explanation: string
  tone:        AccentTone
}

export interface ReadinessInput {
  configured:      boolean
  gate:            Pick<EventAssignmentGate, 'open' | 'detail'>
  summary:         Pick<IdentifierSummary, 'configuredCapacity' | 'available' | 'assigned'
                        | 'poolsTotal' | 'poolsExhausted' | 'poolsUnavailable'
                        | 'poolsOrphaned' | 'poolsInconsistent' | 'capacityKind'>
  /** Eligible participants for the whole event. null ⇒ unknown. */
  eligible:        number | null
  /** The identifier's configured name, so the copy speaks the organizer's language. */
  label:           string
}

/**
 * The single readiness verdict, in a fixed order of precedence.
 *
 * The order is the order an organizer can act in: there is no point saying "not
 * enough identifiers" about an event that is archived, or about a pool that is
 * wired to a pass that no longer exists.
 */
export function resolveReadiness(input: ReadinessInput): Readiness {
  const { summary, eligible, label } = input
  const noun = label.toLowerCase()

  if (!input.configured) {
    return {
      state: 'not_configured', tone: 'neutral',
      label: 'Not configured',
      explanation: `No identifier system is set up yet. Choose a name and a number range before assigning.`,
    }
  }
  if (!input.gate.open) {
    return {
      state: 'locked', tone: 'neutral',
      label: 'Read-only',
      explanation: input.gate.detail ?? 'Identifiers cannot be changed for this event.',
    }
  }
  if (summary.poolsOrphaned > 0 || summary.poolsInconsistent > 0) {
    const parts: string[] = []
    if (summary.poolsOrphaned > 0) {
      parts.push(`${summary.poolsOrphaned === 1 ? 'A number range is' : `${summary.poolsOrphaned} number ranges are`} linked to a pass this event no longer has`)
    }
    if (summary.poolsInconsistent > 0) {
      parts.push(`${summary.poolsInconsistent === 1 ? 'a number range holds' : `${summary.poolsInconsistent} number ranges hold`} more ${noun}s than its ranges allow`)
    }
    return {
      state: 'conflict', tone: 'critical',
      label: 'Needs attention',
      explanation: `${parts.join(', and ')}. Fix the configuration before assigning.`,
    }
  }
  if (summary.poolsUnavailable > 0 || summary.assigned === null) {
    return {
      state: 'unknown', tone: 'neutral',
      label: 'Cannot verify',
      explanation: `Assignment capacity cannot be checked because ${noun} usage could not be read. Try again in a moment.`,
    }
  }
  if (summary.poolsTotal > 0 && summary.poolsExhausted === summary.poolsTotal) {
    return {
      state: 'insufficient', tone: 'critical',
      label: 'None available',
      explanation: `Every configured range is fully used. Add a range before assigning more ${noun}s.`,
    }
  }

  const available = summary.available
  // An unlimited pool cannot run out, so "enough" is not in question — but the
  // exact number still needing one remains unknown.
  if (summary.capacityKind !== 'finite' || available === null) {
    return {
      state: 'warning', tone: 'pending',
      label: 'Not verifiable',
      // RD-BIB-TIMING-02 · §6 · "pool" is the engine's word and was reaching the
      // organizer in these two sentences — the last place it did. Every other
      // surface has said "range" since RD-BIB-UX-02; these were missed because
      // they are the UNVERIFIABLE branch, which the fixture events never hit.
      explanation: eligible === null
        ? `At least one ${noun} range has no fixed end, so there is no total to check against.`
        : `At least one ${noun} range has no fixed end. ${eligible.toLocaleString('en-IN')} participants are eligible; how many still need a ${noun} is not yet countable.`,
    }
  }

  if (eligible === null) {
    return {
      state: 'warning', tone: 'pending',
      label: 'Partly verified',
      explanation: `${available.toLocaleString('en-IN')} ${noun}s are available, but the number of eligible participants could not be read.`,
    }
  }

  // PROVABLY ENOUGH: at most `eligible` people can ever need one.
  if (available >= eligible) {
    return {
      state: 'ready', tone: 'verify',
      label: 'Ready',
      explanation: `${available.toLocaleString('en-IN')} ${noun}s are available for ${eligible.toLocaleString('en-IN')} eligible participants — enough for every one of them.`,
    }
  }

  // PROVABLY NOT ENOUGH: the floor on those still needing one already exceeds
  // what is left. See minimumStillNeeding for why the bound holds.
  const floor = minimumStillNeeding(eligible, summary.assigned)
  if (floor !== null && floor > available) {
    return {
      state: 'insufficient', tone: 'critical',
      label: 'Not enough',
      explanation: `Only ${available.toLocaleString('en-IN')} ${noun}s are available, and at least ${floor.toLocaleString('en-IN')} eligible participants still need one. Add a range.`,
    }
  }

  return {
    state: 'warning', tone: 'pending',
    label: 'Check before assigning',
    explanation: `${available.toLocaleString('en-IN')} ${noun}s are available for ${eligible.toLocaleString('en-IN')} eligible participants. How many still need one cannot be counted yet, so this may not be enough.`,
  }
}

// ─── RD-BIB-UX-03 · the whole event, in the four numbers an organizer asks for ─

/**
 * The at-a-glance answer: how many people, how many hold a number, how many still
 * need one, and how many numbers are left.
 *
 * ═══ WHY THIS REPLACES "THE EXACT NUMBER CANNOT BE ESTABLISHED" ═══════════════
 * RD-EVENT-19B was right at the time: nothing joined "is eligible" to "holds one",
 * so the workspace printed a FLOOR ("at least 48") beside an explicit "Exact
 * number — not countable yet". RD-BIB-UX-02 made `hasIdentifier` a field every
 * registration is born with, so each pass now reports an EXACT `unassignedEligible`
 * and the sum over passes is exact too.
 *
 * Leaving the old note in place would now be the dishonest choice: it would tell an
 * organizer the product cannot answer a question it answers on the same screen.
 *
 * The floor is kept as the FALLBACK for an event whose passes are not all countable
 * — a legacy event before its backfill — and it is still labelled as a minimum.
 * A number that is a bound is never presented as the answer.
 */
export type NeedBasis = 'exact' | 'minimum' | 'unknown'

export interface IdentifierStatus {
  /** Confirmed participants across the event. */
  participants: number | null
  /** Participants holding a number. */
  assigned:     number | null
  /** Participants still without one. */
  need:         number | null
  /** How `need` was arrived at — an exact count, a provable floor, or nothing. */
  needBasis:    NeedBasis
  /** Numbers the configured ranges can still issue. Null when unlimited/unknown. */
  available:    number | null
  /** Total numbers configured. Null when unlimited/unknown. */
  capacity:     number | null
  capacityKind: 'finite' | 'unlimited' | 'mixed'
  /** 0–100 for the usage meter, or null when there is no proportion to draw. */
  percentUsed:  number | null
  /** Provably short: more people need one than there are numbers left. */
  shortBy:      number | null
  state:        IdentifierStatusState
}

export type IdentifierStatusState =
  | 'not_configured'  // no ranges exist yet
  | 'exhausted'       // finite, and nothing is left
  | 'insufficient'    // provably fewer numbers than people who need one
  | 'low'             // under a tenth of the range remains
  | 'healthy'         // enough, and room to spare
  | 'unknown'         // usage could not be read

export const IDENTIFIER_STATUS_TONE: Record<IdentifierStatusState, AccentTone> = {
  not_configured: 'neutral',
  exhausted:      'critical',
  insufficient:   'critical',
  low:            'pending',
  healthy:        'verify',
  unknown:        'neutral',
}

export interface IdentifierStatusInput {
  configured:   boolean
  /**
   * RD-BIB-UX-03 · does ANY range actually exist?
   *
   * `configured` only means a configuration document was stored. An event that has
   * one but has never set a range falls back to the built-in unbounded default
   * pool, which reported "Ready · No fixed limit" — an event that had not been set
   * up at all telling the organizer everything was fine. "No range configured" and
   * "deliberately unlimited" are different answers and only one of them was true.
   */
  hasAnyRange:  boolean
  /** Per-pass figures from the read model. */
  scopes: Array<{
    participants: number | null
    assigned:     number | null
    need:         number | null
    /**
     * RD-BIB-UX-03 · numbers left in THIS pass's own range. Needed because a pass
     * never borrows another pass's numbers, so an event total can look comfortable
     * while one pass is provably short — see `resolveIdentifierStatus`.
     */
    available?:   number | null
    /** True for the unrestricted scope — pools naming no pass. Not a pass. */
    unrestricted?: boolean
  }>
  /** Event-wide eligible count, used only for the fallback floor. */
  eligible:     number | null
  capacity:     number | null
  capacityKind: 'finite' | 'unlimited' | 'mixed'
  available:    number | null
  /** Locks held, for the usage meter and the floor. */
  assignedLocks: number | null
}

/** Sums, refusing to sum when a part is unknown. One unknown makes the total unknown. */
const total = (xs: Array<number | null>): number | null =>
  xs.some(v => v === null) ? null : xs.reduce<number>((a, b) => a + (b ?? 0), 0)

export function resolveIdentifierStatus(input: IdentifierStatusInput): IdentifierStatus {
  // The UNRESTRICTED scope (pools naming no pass) is not a pass and has no
  // participants of its own — its people are already counted under the pass they
  // actually registered for. Including it contributed a permanent `null` and made
  // every total on a defaulted event read "Unknown".
  const passScopes = input.scopes.filter(s => !s.unrestricted)
  const participants = total(passScopes.map(s => s.participants))
  const assigned     = total(passScopes.map(s => s.assigned))

  // EXACT when every pass could be counted; otherwise fall back to the provable
  // floor, which is labelled as a minimum wherever it is rendered.
  const exactNeed = total(passScopes.map(s => s.need))
  const floor     = minimumStillNeeding(input.eligible, input.assignedLocks)
  const need      = exactNeed ?? floor
  const needBasis: NeedBasis =
    exactNeed !== null ? 'exact' : floor !== null ? 'minimum' : 'unknown'

  const finite = input.capacityKind === 'finite'
  const percentUsed = !finite || input.capacity === null || input.capacity <= 0 || input.assignedLocks === null
    ? null
    : Math.round((input.assignedLocks / input.capacity) * 100)

  // Only ever claimed from an EXACT need. A floor could understate the shortfall,
  // and "you are short by at least N" is a different sentence from "short by N".
  //
  // ═══ WHY THE EVENT TOTAL IS NOT ENOUGH ═══════════════════════════════════════
  // A pass draws ONLY from its own range, so 1,108 numbers spread across three
  // ranges do not help the one pass whose range holds 20 for 30 people. Summing to
  // "Ready" would be arithmetically true and operationally false — the organizer
  // would run the assignment and discover the shortfall afterwards.
  //
  // The shortfall is therefore the SUM OF THE PER-PASS shortfalls wherever a pass
  // reports its own remaining capacity, falling back to the event comparison only
  // when it does not.
  const perPassShort = passScopes.reduce<number | null>((acc, s) => {
    if (acc === null) return null
    if (s.available === undefined) return null          // this caller gave no per-pass figure
    if (s.need === null || s.available === null) return acc  // uncountable pass claims nothing
    return acc + Math.max(0, s.need - s.available)
  }, 0)

  const eventShort = finite && input.available !== null && exactNeed !== null
    ? Math.max(0, exactNeed - input.available)
    : null

  const shortBy = perPassShort !== null ? perPassShort : eventShort

  const state: IdentifierStatusState =
    (!input.configured || !input.hasAnyRange)           ? 'not_configured'
    : (finite && input.available === null)              ? 'unknown'
    : (finite && input.available === 0)                 ? 'exhausted'
    : (shortBy !== null && shortBy > 0)                 ? 'insufficient'
    : (finite && input.capacity !== null && input.capacity > 0 &&
       input.available !== null && input.available / input.capacity < 0.1) ? 'low'
    : 'healthy'

  return {
    participants, assigned, need, needBasis,
    available: input.available, capacity: input.capacity,
    capacityKind: input.capacityKind,
    percentUsed,
    shortBy: shortBy && shortBy > 0 ? shortBy : null,
    state,
  }
}

/** The one sentence the status card leads with. `noun` is the configured label. */
export function identifierStatusHeadline(s: IdentifierStatus, noun: string): string {
  const N = (v: number | null) => (v ?? 0).toLocaleString('en-IN')
  switch (s.state) {
    case 'not_configured':
      return `No ${noun} ranges are configured yet. Create one before assigning numbers to participants.`
    case 'unknown':
      return `${noun} usage could not be read just now. Nothing has changed — try refreshing in a moment.`
    case 'exhausted':
      return s.need && s.need > 0
        ? `Every configured ${noun} has been issued, and ${N(s.need)} participant${s.need === 1 ? '' : 's'} still need one. Add another range.`
        : `Every configured ${noun} has been issued.`
    case 'insufficient':
      // Says the shortfall, not just the totals: with per-pass ranges the event
      // total can exceed the need while a single pass is still short.
      return `${N(s.shortBy)} participant${s.shortBy === 1 ? '' : 's'} cannot be given ${article(noun)} ${noun} from the ranges configured today. Add numbers to the ranges that are short.`
    case 'low':
      return `${N(s.available)} ${noun}${s.available === 1 ? '' : 's'} left for ${N(s.need)} participant${s.need === 1 ? '' : 's'} who still need one.`
    default:
      if (s.need === 0) return `Every participant has ${article(noun)} ${noun}.`
      // `available` is null on an unlimited or unreadable range. Rendering it as 0
      // would print "0 are available" beside a figure reading "No fixed limit" —
      // a fabricated number contradicting the card above it.
      if (s.available === null) {
        return `${N(s.need)} participant${s.need === 1 ? '' : 's'} still need one. This range has no fixed end, so there is no total to check against.`
      }
      return `${N(s.need)} participant${s.need === 1 ? '' : 's'} still need one, and ${N(s.available)} ${noun}${s.available === 1 ? '' : 's'} ${s.available === 1 ? 'is' : 'are'} available.`
  }
}

// ─── Pool presentation ──────────────────────────────────────────────────────

export interface PoolCardModel {
  poolId:      string
  name:        string
  isDefault:   boolean
  /** Pass names this group covers; empty ⇒ it serves every pass. */
  passLabels:  Array<{ id: string; name: string; missing: boolean }>
  unrestricted: boolean
  ranges:      IdentifierRange[]
  gaps:        IdentifierRange[]
  capacityKind: 'finite' | 'unlimited'
  capacity:    number | null
  assigned:    number | null
  available:   number | null
  /** 0–100 for a meter, or null when there is no proportion to draw. */
  percent:     number | null
  nextValue:   number | null
  state:       IdentifierPoolStat['state']
  stateLabel:  string
  stateTone:   AccentTone
  note:        string | null
}

const POOL_STATE_LABEL: Record<IdentifierPoolStat['state'], string> = {
  unlimited:    'No fixed range',
  empty:        'Nothing used',
  available:    'Available',
  exhausted:    'Fully used',
  inconsistent: 'Over capacity',
  unavailable:  'Cannot be read',
  orphaned:     'Pass removed',
}

const POOL_STATE_TONE: Record<IdentifierPoolStat['state'], AccentTone> = {
  unlimited:    'neutral',
  empty:        'neutral',
  available:    'verify',
  exhausted:    'pending',
  inconsistent: 'critical',
  unavailable:  'neutral',
  orphaned:     'critical',
}

/**
 * One pool as a card.
 *
 * `percent` is null for an unlimited pool and for an unreadable one — a meter is a
 * claim about a proportion, and neither of those has one. An over-capacity pool
 * reports its real percentage (150%), which the meter renders as full plus its own
 * badge, rather than being clamped into looking merely finished.
 */
export function poolCard(
  stat: IdentifierPoolStat,
  passNames: Map<string, string>,
): PoolCardModel {
  const passIds = stat.passIds ?? []
  const passLabels = passIds.map(id => ({
    id,
    name: passNames.get(id) ?? 'Removed pass',
    missing: stat.orphanedPassIds.includes(id),
  }))

  const percent =
    stat.capacityKind === 'unlimited' || stat.capacity === null || stat.occupied === null
      ? null
      : stat.capacity <= 0 ? null : Math.round((stat.occupied / stat.capacity) * 100)

  return {
    poolId: stat.poolId,
    name: stat.label,
    isDefault: stat.isDefault,
    passLabels,
    unrestricted: passIds.length === 0,
    ranges: stat.ranges,
    gaps: rangeGaps(stat.ranges),
    capacityKind: stat.capacityKind,
    capacity: stat.capacity,
    assigned: stat.assigned === null || stat.consumed === null ? null : stat.assigned + stat.consumed,
    available: stat.available,
    percent,
    nextValue: stat.nextNumber,
    state: stat.state,
    stateLabel: POOL_STATE_LABEL[stat.state],
    stateTone: POOL_STATE_TONE[stat.state],
    note: stat.stateReason,
  }
}

// ─── Range editor ───────────────────────────────────────────────────────────

export interface RangeDraftRow {
  /** Stable key for React; not persisted. */
  key:   string
  start: string
  end:   string
}

export interface RangeDraftResult {
  /** Parsed ranges when every row is valid; otherwise null. */
  ranges:    IdentifierRange[] | null
  /** Per-row message, keyed by row key. */
  rowErrors: Record<string, string>
  /** A message about the SET (overlap, duplicates), not one row. */
  setError:  string | null
  /** Capacity of the valid rows so far, so the total updates as you type. */
  capacity:  number | null
  gaps:      IdentifierRange[]
}

const INT_RE = /^-?\d+$/

/**
 * Validates what the organizer has typed, without throwing and without a second
 * rulebook.
 *
 * Row-level problems are reported per row so the editor can point at the offending
 * input. The SET-level rules — overlap, duplicates — are delegated to the
 * RD-EVENT-19A validator, which is also what the server enforces, so the editor
 * can never accept a configuration the API will reject.
 */
export function validateRangeDraft(
  rows: RangeDraftRow[],
  validateSet: (ranges: unknown, poolId: string) => IdentifierRange[],
  poolId = 'this group',
): RangeDraftResult {
  const rowErrors: Record<string, string> = {}
  const parsed: IdentifierRange[] = []

  for (const row of rows) {
    const rawStart = row.start.trim()
    const rawEnd   = row.end.trim()
    if (!rawStart && !rawEnd) continue          // a blank row is simply not a range yet

    if (!INT_RE.test(rawStart) || !INT_RE.test(rawEnd)) {
      rowErrors[row.key] = 'Enter whole numbers for both ends.'
      continue
    }
    const start = Number(rawStart)
    const end   = Number(rawEnd)
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
      rowErrors[row.key] = 'These numbers are too large.'
      continue
    }
    if (start < 0 || end < 0) {
      rowErrors[row.key] = 'Numbers cannot be negative.'
      continue
    }
    if (start > end) {
      rowErrors[row.key] = 'The first number must not be higher than the last.'
      continue
    }
    parsed.push({ start, end })
  }

  if (Object.keys(rowErrors).length > 0) {
    return { ranges: null, rowErrors, setError: null, capacity: null, gaps: [] }
  }
  if (parsed.length === 0) {
    return { ranges: [], rowErrors, setError: null, capacity: 0, gaps: [] }
  }

  try {
    const ranges = validateSet(parsed, poolId)
    return {
      ranges,
      rowErrors,
      setError: null,
      capacity: rangeCapacity(ranges),
      gaps: rangeGaps(ranges),
    }
  } catch (err) {
    return {
      ranges: null, rowErrors,
      setError: err instanceof Error ? err.message : 'These ranges cannot be used together.',
      capacity: null, gaps: [],
    }
  }
}

// ─── Planning ───────────────────────────────────────────────────────────────

/** Human copy for every blocker the decision model can report. */
// ─── RD-BIB-01 · the plan row an organizer reads ────────────────────────────

/**
 * Everything one pass's plan card shows, decided in one place.
 *
 * ═══ WHY THIS IS A FUNCTION AND NOT JSX ══════════════════════════════════════
 * The card answers seven questions — which pass, how many people, how many already
 * have a number, how many will get one, which numbers exist, how many are left, what
 * comes next — and six of them can be UNKNOWN independently. Deciding that inside a
 * component means it can only be checked by looking at a screen. Here it is a pure
 * function with a table of cases.
 *
 * `expectedLast` is deliberately absent when anything is uncertain. Promising
 * "5043–5600" and delivering 5043–5598 because two numbers were manually taken is
 * exactly the kind of confident wrongness this module exists to refuse.
 */
export interface PlanRow {
  passId:      string | null
  passName:    string
  /** "5001–5600", or "5001–5100 + 7001–7050". Null when the pool is unbounded. */
  numbers:     string | null
  ranges:      IdentifierRange[]
  gaps:        IdentifierRange[]
  capacityKind: 'finite' | 'unlimited'
  capacity:    number | null
  available:   number | null
  /** Confirmed participants on this pass. Null ⇒ not countable. */
  participants: number | null
  /** Of those, how many already hold a number. Null ⇒ not countable. */
  alreadyAssigned: number | null
  /** How many a run would issue. Null ⇒ genuinely not knowable; see `willAssignReason`. */
  willAssign:  number | null
  willAssignReason: string | null
  /** The next value the allocator would issue, when it is known. */
  nextValue:   number | null
  /** The last value it would reach IF nothing else is taken. Null unless provable. */
  expectedLast: number | null
  /** True when the run would cross a configured gap; the card says which. */
  crossesGap:  boolean
  /** Anything that stops this pass running at all. */
  blockers:    DecisionReason[]
  runnable:    boolean
  /** True when capacity cannot hold everyone who still needs a number. */
  shortBy:     number | null
  /**
   * RD-BIB-UX-02 · does this pass have a number range wired to it at all?
   *
   * "No range is configured" and "the range's usage could not be read" are different
   * facts that both used to surface as Unknown. An unconfigured pass now says so.
   */
  configured:  boolean
  /**
   * RD-BIB-UX-02 · how many a run would ACTUALLY write, which is not always how many
   * need one: a range holding 310 cannot serve 400 people. Naming the smaller figure
   * is what stops a confirmation promising more than the range can deliver.
   */
  issuable:    number | null
  status:      PlanRowStatus
}

/**
 * RD-BIB-UX-02 · what this pass's badge says, decided once.
 *
 * The card used to show a BINARY — "Ready", or "Needs configuration" for everything
 * else. So a pass whose 400 participants all already held a number was labelled
 * "Needs configuration", which is both alarming and false: it is finished.
 */
export type PlanRowStatus =
  | 'not_configured'  // no number range is wired to this pass
  | 'complete'        // every participant on it already holds one
  | 'blocked'         // something else stops a run (locked event, deleted pass…)
  | 'unknown'         // runnable, but how many need one is not countable
  | 'short'           // runnable, and the range cannot cover everyone who needs one
  | 'ready'           // runnable, counted, and there is room

/**
 * Order matters, and `complete` deliberately outranks `blocked`: a pass whose range
 * is fully used BECAUSE everybody on it has a number is finished, not broken, and
 * "Every number in this range has been used" is the wrong headline for it.
 */
export function planRowStatus(row: Pick<PlanRow,
  'configured' | 'runnable' | 'willAssign' | 'shortBy'>): PlanRowStatus {
  if (!row.configured)        return 'not_configured'
  if (row.willAssign === 0)   return 'complete'
  if (!row.runnable)          return 'blocked'
  if (row.willAssign === null) return 'unknown'
  if (row.shortBy !== null)   return 'short'
  return 'ready'
}

export const PLAN_STATUS_LABEL: Record<PlanRowStatus, string> = {
  not_configured: 'No number range',
  complete:       'Complete',
  blocked:        'Needs attention',
  unknown:        'Cannot verify',
  short:          'Not enough numbers',
  ready:          'Ready',
}

export const PLAN_STATUS_TONE: Record<PlanRowStatus, AccentTone> = {
  not_configured: 'critical',
  complete:       'verify',
  blocked:        'critical',
  unknown:        'pending',
  short:          'critical',
  ready:          'verify',
}

export interface PlanRowInput {
  passId:   string | null
  passName: string
  ranges:   IdentifierRange[]
  capacityKind: 'finite' | 'unlimited'
  capacity:  number | null
  available: number | null
  participants:    { value: number | null }
  alreadyAssigned: { value: number | null }
  willAssign:      { value: number | null; status: string; reason: string | null }
  nextValue: number | null
  blockers:  DecisionReason[]
  /** RD-BIB-UX-02 · how many number ranges are wired to this pass. 0 ⇒ unconfigured. */
  poolCount: number
}

export function buildPlanRow(input: PlanRowInput): PlanRow {
  const ranges = input.ranges
  const gaps   = rangeGaps(ranges)
  const willAssign = input.willAssign.status === 'known' ? input.willAssign.value : null

  const shortBy = willAssign !== null && input.capacityKind === 'finite' && input.available !== null
    ? Math.max(0, willAssign - input.available)
    : null

  const configured = input.poolCount > 0
  const runnable = input.blockers.length === 0
  // What a run would actually WRITE, which is not the same question as how many need
  // one:
  //   • a pass nothing can run on writes ZERO, however many need a number. A pass
  //     with no configured range reported "will be assigned 50" purely because 50
  //     people lacked one — a promise no range existed to keep.
  //   • a range holding 310 for 400 people writes 310, not 400.
  // An unlimited or unreadable capacity leaves it at the need, which is all that is
  // known.
  const issuable = !runnable
    ? 0
    : willAssign === null
      ? null
      : (input.capacityKind === 'finite' && input.available !== null)
        ? Math.min(willAssign, input.available)
        : willAssign

  // The last number a run would reach, and ONLY when every input is exact: the count
  // to issue, a starting point, enough room, and no gap to cross. A gap makes the end
  // depend on where the blocks sit, and an occupied number in the middle moves it —
  // so the card says "starts at N" instead of naming an end it cannot guarantee.
  //
  // RD-BIB-UX-02 · computed from `issuable`, not from the need. A range of 20 asked
  // for by 30 people used to report "Last number — Unknown", when the last number it
  // would reach is 10020 and the arithmetic is the same as in every other case.
  // Refusing to answer a question you can answer is its own kind of dishonesty.
  let expectedLast: number | null = null
  const crossesGap = issuable !== null && input.nextValue !== null && ranges.length > 1 &&
    (() => {
      const block = ranges.find(r => input.nextValue! >= r.start && input.nextValue! <= r.end)
      return !block || input.nextValue! + issuable - 1 > block.end
    })()
  if (issuable !== null && issuable > 0 && input.nextValue !== null && !crossesGap) {
    const block = ranges.find(r => input.nextValue! >= r.start && input.nextValue! <= r.end)
    const end = input.nextValue + issuable - 1
    if (ranges.length === 0 || (block && end <= block.end)) expectedLast = end
  }

  return {
    configured,
    issuable,
    status: planRowStatus({
      configured, runnable, willAssign,
      shortBy: shortBy && shortBy > 0 ? shortBy : null,
    }),
    passId: input.passId,
    passName: input.passName,
    numbers: ranges.length > 0 ? describeRanges(ranges) : null,
    ranges, gaps,
    capacityKind: input.capacityKind,
    capacity: input.capacity,
    available: input.available,
    participants: input.participants.value,
    alreadyAssigned: input.alreadyAssigned.value,
    willAssign,
    willAssignReason: willAssign === null ? (input.willAssign.reason ?? 'Not countable yet.') : null,
    nextValue: input.nextValue,
    expectedLast,
    crossesGap,
    blockers: input.blockers,
    runnable: input.blockers.length === 0,
    shortBy: shortBy && shortBy > 0 ? shortBy : null,
  }
}

/**
 * RD-BIB-UX-01 · the FIRST button an organizer sees, and it does not assign.
 *
 * ═══ WHY THIS WORDING MATTERS ════════════════════════════════════════════════
 * The primary action used to read "Assign 48 bib numbers" and sat immediately under
 * the pass selector, with the reassurance that nothing would be written placed BELOW
 * it. An organizer reads a button before they read the sentence under it, so the
 * screen said "this click assigns" and then explained, too late, that it does not.
 *
 * The first click now previews, and the button says so. The word "Assign" appears
 * exactly once in this flow — on the final confirmation — and it carries the count.
 */
export function previewButtonLabel(rows: PlanRow[], noun: string): string {
  const runnable = rows.filter(r => r.runnable)
  if (runnable.length === 0) return `Preview ${noun} assignment`
  return runnable.length === 1
    ? `Preview ${noun} assignment`
    : `Preview ${noun} assignment for ${runnable.length} passes`
}

/**
 * The FINAL confirmation button's label — the only control in this flow that writes.
 *
 * Says the number ONLY when every runnable pass can prove it. "Assign 310 BIB Numbers"
 * is a promise; when even one scope cannot be counted the button names the scope
 * instead of inventing a figure.
 *
 * `noun` is the event's CONFIGURED label, verbatim — "BIB Number", "Delegate Number",
 * "Badge Number" — so the button reads in the organizer's own vocabulary without this
 * module knowing what kind of event it is.
 */
export function assignButtonLabel(rows: PlanRow[], noun: string): string {
  const runnable = rows.filter(r => r.runnable)
  if (runnable.length === 0) return `Assign ${noun}s`
  // RD-BIB-UX-02 · the figure is `issuable`, not `willAssign`. When 400 people need a
  // number and the range holds 310, a run writes 310 — so a button reading "Assign
  // 400 BIB Numbers" would be a promise the range cannot keep.
  const exact = runnable.every(r => r.issuable !== null)
  if (exact) {
    const total = runnable.reduce((n, r) => n + (r.issuable ?? 0), 0)
    if (total === 0) return 'Everyone already has one'
    return `Assign ${total} ${noun}${total === 1 ? '' : 's'}`
  }
  return runnable.length === 1
    ? `Assign ${noun}s for ${runnable[0].passName}`
    : `Assign ${noun}s for ${runnable.length} passes`
}

export const BLOCKER_COPY: Record<DecisionReason, string> = {
  EVENT_LOCKED:              'This event is read-only, so identifiers cannot be assigned.',
  EVENT_LIFECYCLE_UNKNOWN:   'This event is in a state that is not recognised, so assignment is held.',
  IDENTIFIERS_DISABLED:      'Identifiers are switched off for this event.',
  REGISTRATION_MISSING:      'That registration could not be found.',
  REGISTRATION_CANCELLED:    'Cancelled registrations do not receive identifiers.',
  REGISTRATION_REJECTED:     'Rejected registrations do not receive identifiers.',
  REGISTRATION_NOT_ON_ROSTER:'This registration is not confirmed, so it is not on the assignment roster.',
  REGISTRATION_STATUS_UNKNOWN:'This registration is in a state that is not recognised.',
  PASS_MISSING:              'This registration has no pass, so no number range applies to it.',
  PASS_OUT_OF_POOL_SCOPE:    'That number range belongs to a different pass.',
  POOL_MISSING:              'This pass has no participant-number range configured. Add one before assigning.',
  POOL_PASS_DELETED:         'This number range is linked to a pass the event no longer has.',
  ALREADY_ASSIGNED:          'This participant already holds one. Changing it is a swap.',
  IDENTIFIER_OWNED_BY_OTHER: 'That value already belongs to somebody else.',
  IDENTIFIER_BLOCKED:        'That value is blocked and cannot be issued.',
  IDENTIFIER_RETIRED:        'That value is retired and cannot be issued.',
  IDENTIFIER_CONSUMED:       'That value has already been used at check-in.',
  IDENTIFIER_NOT_REUSABLE:   'That value was released but cannot be reused under the current policy.',
  LEGACY_MIRROR_WITHOUT_LOCK:'This participant has an older record that cannot be verified.',
  LOCK_WITHOUT_MIRROR:       'A value is recorded without a matching participant record.',
  POOL_EXHAUSTED:            'Every number in this range has been used.',
  POOL_USAGE_UNAVAILABLE:    'This range’s usage could not be read.',
  POOL_INCONSISTENT:         'More identifiers are in use than this range allows.',
}

export const blockerCopy = (reason: DecisionReason): string =>
  BLOCKER_COPY[reason] ?? 'This cannot be assigned right now.'
