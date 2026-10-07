// RD-RACEOPS-RESULTS-04 · Gender and age-group ranking — PURE.
//
// No SDK, no I/O. Extends the existing overall pass rather than replacing it: the same
// `nextRank` tie rule from ./ties.ts decides every dimension, so a tie is a tie whichever
// column it appears in.
//
// ═══ WHY THIS NEEDS NO NEW INDEX AND NO SECOND QUERY ═════════════════════════
// The ranking pass already walks every finisher in ascending chip time, resumably, through
// ONE declared index (`status, chipTimeMs, rowNumber`). A group rank is the participant's
// position among the members of their own group — and because the walk is already in the
// only order that matters, a group rank can be assigned in the SAME pass by keeping one
// small `RankState` per group instead of one for the field.
//
// The alternative — a query per group — would need an index per dimension and a cursor per
// group, and would read the same rows several times. This reads them once.
//
// The per-group states are persisted with the cursor on the session document, so the pass
// stays resumable and a tie straddling a chunk boundary still resolves to one shared rank.
//
// ═══ WHAT A GROUP IS ═════════════════════════════════════════════════════════
// Whatever the FILE said, normalised for comparison only: "Male" / "MALE" / "male" are one
// group, "Below 35yrs - Men" is another. RegisterDesk does not interpret, translate or
// bucket these values — it has no basis to decide that "M" and "Male" are the same thing in
// every organizer's vocabulary, and guessing would move people between rankings. A row whose
// group value is blank is ranked overall and simply has no group rank.

import { INITIAL_RANK_STATE, nextRank, type RankState } from './ties'

/** The dimensions ranked beyond overall. Extending this list is the whole extension point. */
export const RANK_DIMENSIONS = ['gender', 'ageGroup'] as const
export type RankDimension = typeof RANK_DIMENSIONS[number]

/**
 * How many distinct groups one dimension may have before ranking it is abandoned.
 *
 * Bounds the state carried on the session document. A real race has two or three genders
 * and a dozen age bands; a hundred distinct values means the column is not a group at all
 * (a mis-mapped name or time column), and ranking it would produce a page of "1 / 1".
 */
export const MAX_GROUPS_PER_DIMENSION = 64

/**
 * Comparison key for a group value, or '' when there is nothing to group by.
 *
 * Alphanumeric and lower-cased, so it is safe as a Firestore MAP KEY (no dots, slashes or
 * reserved characters) and stable across the spacing and punctuation a timing export varies.
 */
export function groupKey(value: string | null | undefined): string {
  return (value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40)
}

/** Per-dimension, per-group tie state. Persisted with the rank cursor. */
export type GroupRankState = Record<string, RankState>
export type GroupRankStates = Record<RankDimension, GroupRankState>

export const INITIAL_GROUP_STATES: GroupRankStates = { gender: {}, ageGroup: {} }

/** One finisher, as the group pass needs to see them. */
export interface GroupRankRow {
  rowNumber:  number
  chipTimeMs: number
  gender:     string | null
  ageGroup:   string | null
}

export interface GroupRankAssignment {
  rowNumber:     number
  genderRank:    number | null
  ageGroupRank:  number | null
}

export interface GroupRankChunkResult {
  assignments: GroupRankAssignment[]
  states:      GroupRankStates
  /** True when a dimension exceeded MAX_GROUPS_PER_DIMENSION and was abandoned. */
  abandoned:   RankDimension[]
}

const valueFor = (row: GroupRankRow, dimension: RankDimension): string | null =>
  dimension === 'gender' ? row.gender : row.ageGroup

/**
 * Ranks one page of ALREADY-SORTED finishers within their groups, continuing from `states`.
 *
 * The rows must arrive in the same ascending chip-time order the overall pass uses — that
 * ordering is what makes a single sequential pass correct for every dimension at once.
 *
 * A dimension that grows past `MAX_GROUPS_PER_DIMENSION` is abandoned: its state is cleared,
 * it stops assigning, and the caller records that no ranking exists for it. Abandoning is
 * better than truncating — a partial gender ranking is worse than none, because a
 * participant cannot tell which they are looking at.
 */
export function rankGroupChunk(
  rows:   readonly GroupRankRow[],
  states: GroupRankStates,
): GroupRankChunkResult {
  const next: GroupRankStates = {
    gender:   { ...states.gender },
    ageGroup: { ...states.ageGroup },
  }
  const abandoned: RankDimension[] = []
  const assignments: GroupRankAssignment[] = []

  for (const row of rows) {
    const ranks: Partial<Record<RankDimension, number | null>> = {}

    for (const dimension of RANK_DIMENSIONS) {
      if (abandoned.includes(dimension)) { ranks[dimension] = null; continue }
      const key = groupKey(valueFor(row, dimension))
      if (key === '') { ranks[dimension] = null; continue }

      const lane = next[dimension]
      if (lane[key] === undefined && Object.keys(lane).length >= MAX_GROUPS_PER_DIMENSION) {
        // Too many distinct values for this to be a group. Give up on the dimension
        // entirely rather than rank part of the field.
        abandoned.push(dimension)
        next[dimension] = {}
        ranks[dimension] = null
        continue
      }

      const step = nextRank(lane[key] ?? INITIAL_RANK_STATE, row.chipTimeMs)
      lane[key] = step.state
      ranks[dimension] = step.rank
    }

    assignments.push({
      rowNumber:    row.rowNumber,
      genderRank:   ranks.gender   ?? null,
      ageGroupRank: ranks.ageGroup ?? null,
    })
  }

  return { assignments, states: next, abandoned }
}

/** Per-dimension group sizes: how many finishers each group ended up with. */
export type GroupTotals = Record<RankDimension, Record<string, number>>

/**
 * The totals a published result shows as the denominator ("4 / 56").
 *
 * Derived from the completed states rather than counted separately, so the denominator and
 * the ranks it sits beside can never come from different passes over different rows.
 */
export function groupTotalsFrom(states: GroupRankStates): GroupTotals {
  const totals: GroupTotals = { gender: {}, ageGroup: {} }
  for (const dimension of RANK_DIMENSIONS) {
    for (const [key, state] of Object.entries(states[dimension])) {
      totals[dimension][key] = state.processed
    }
  }
  return totals
}

/** The size of one row's group, or null when it has none (or the dimension was abandoned). */
export function totalFor(
  totals: GroupTotals | null | undefined, dimension: RankDimension, value: string | null | undefined,
): number | null {
  const key = groupKey(value)
  if (key === '') return null
  const total = totals?.[dimension]?.[key]
  return typeof total === 'number' && total > 0 ? total : null
}
