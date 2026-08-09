// RD-RACEOPS-01 Sprint 3 · Ranking engine.
//
// PURE. No SDK, no I/O, no Firestore. Consumes only the canonical model, so a future
// vendor parser needs no change here.
//
// ─── Scope (Sprint 3 Step 4) ─────────────────────────────────────────────────
// Computes ONLY:
//   • overallRank — position among all finishers in the session
//   • passRank    — position among finishers of the same passId
// Deliberately NOT computed: gender rank, age rank, category rank. Those need approved
// data sources (Phase 0 · D4 — gender/age exist only as optional, unindexed free text in
// `registrations.attendee.formResponses`, or as whatever column the timing file happened
// to carry). Storing them un-ranked keeps the door open without guessing.
//
// ─── Ranking rules ───────────────────────────────────────────────────────────
//   1. Only `status === 'finished'` rows are ranked. DNF / DNS / DQ get `null` — never 0,
//      never a rank at the end of the field.
//   2. A finisher with no readable chip time cannot be ranked (`null`). Validation flags
//      that row as an error, so a published session should not contain one; the engine is
//      defensive rather than trusting.
//   3. Ascending chip time. Gun time is never used for placing — chip (net) time is the
//      participant's own elapsed time and is what a race places on.
//   4. Ties: standard competition ranking — see ./ties.ts.
//   5. Order is stable for identical times: input order (i.e. file row order) breaks the
//      display tie, so the same file always produces the same output.

import type { NormalizedRaceResult } from '@/features/race-operations/types/results'
import { INITIAL_RANK_STATE, nextRank, type RankState } from './ties'

export interface RankAssignment {
  rowNumber:   number
  overallRank: number | null
  passRank:    number | null
}

/** A row is rankable only if it finished AND carries a usable time. */
export function isRankable(r: Pick<NormalizedRaceResult, 'status' | 'chipTimeMs'>): boolean {
  return r.status === 'finished' && typeof r.chipTimeMs === 'number' && r.chipTimeMs > 0
}

/**
 * Ranks a complete set of results in memory.
 *
 * Used by the tests and by any caller that already holds the whole set. The server's
 * chunked pass uses `rankChunk` below so it can resume, but both share ./ties.ts, so the
 * two paths cannot drift.
 */
export function rankResults(results: readonly NormalizedRaceResult[]): RankAssignment[] {
  const byRow = new Map<number, RankAssignment>(
    results.map(r => [r.rowNumber, { rowNumber: r.rowNumber, overallRank: null, passRank: null }]),
  )

  const rankable = results
    .filter(isRankable)
    // Stable: equal times keep file order, so output is deterministic for a given file.
    .map((r, i) => ({ r, i }))
    .sort((a, b) => (a.r.chipTimeMs! - b.r.chipTimeMs!) || (a.i - b.i))
    .map(x => x.r)

  // ── One sequence, assigned to BOTH ranks ──
  //
  // An Import Session is scoped to exactly one (event, pass) — see
  // docs/RD-RACEOPS-FIRESTORE.md §1 — so every row here belongs to the same race, and
  // "position among this session's finishers" IS "position in this race". overallRank and
  // passRank are therefore the same number in Sprint 3, and are written from one sequence
  // rather than computed twice: two independent loops over identical inputs could drift,
  // and a reader comparing the fields would not be able to tell which was authoritative.
  //
  // They are kept as SEPARATE FIELDS because they will diverge as soon as either
  // (a) "overall" comes to mean event-wide across every race, or (b) a session is allowed
  // to span passes. Both need a decision that Sprint 3 does not make — recorded in
  // docs/RD-RACEOPS-IMPORT-LIFECYCLE.md.
  let state: RankState = INITIAL_RANK_STATE
  for (const r of rankable) {
    const step = nextRank(state, r.chipTimeMs!)
    state = step.state
    const assignment = byRow.get(r.rowNumber)!
    assignment.overallRank = step.rank
    assignment.passRank    = step.rank
  }

  // Return in input order so callers can zip against their own rows.
  return results.map(r => byRow.get(r.rowNumber)!)
}

// ─── Resumable chunk ranking (what the server actually runs) ───────────────────

export interface ChunkRow {
  rowNumber:  number
  chipTimeMs: number
}

export interface RankChunkResult {
  assignments: Array<{ rowNumber: number; rank: number }>
  state:       RankState
}

/**
 * Ranks one page of ALREADY-SORTED finishers, continuing from `state`.
 *
 * The caller supplies rows in ascending `chipTimeMs` (Firestore's own ordering) and
 * persists the returned state as `session.rankCursor`. Because the state carries the last
 * time and last rank, a tie split across two pages still resolves to one shared rank.
 */
export function rankChunk(rows: readonly ChunkRow[], state: RankState): RankChunkResult {
  const assignments: Array<{ rowNumber: number; rank: number }> = []
  let running = state

  for (const row of rows) {
    const step = nextRank(running, row.chipTimeMs)
    running = step.state
    assignments.push({ rowNumber: row.rowNumber, rank: step.rank })
  }

  return { assignments, state: running }
}
