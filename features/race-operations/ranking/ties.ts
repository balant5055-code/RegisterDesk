// RD-RACEOPS-01 Sprint 3 · Tie policy.
//
// PURE. One explicit, documented rule — never an emergent side effect of sort order.
//
// ─── Standard competition ranking ("1224") ───────────────────────────────────
// Equal times share the better rank, and the next distinct time skips the ranks the tie
// consumed:
//
//   time   01:00  01:10  01:10  01:20
//   rank      1      2      2      4          ← 3 is skipped, not reused
//
// This is what race results publish: two runners genuinely tied for 2nd means nobody
// finished 3rd. The alternative ("1223" / dense ranking) would understate the field size
// behind a tie and is wrong for a race.
//
// Ties are compared on the NORMALISED millisecond value, so `01:00:00` and `1:00:00`
// (and an Excel duration cell for the same instant) tie correctly regardless of how the
// timing provider wrote them.

export interface RankState {
  /** Chip time of the previously ranked finisher; null before the first. */
  lastTimeMs: number | null
  /** Rank assigned to that finisher. */
  lastRank:   number
  /** How many finishers have been ranked so far — drives the skip. */
  processed:  number
}

export const INITIAL_RANK_STATE: RankState = { lastTimeMs: null, lastRank: 0, processed: 0 }

/**
 * Assigns the rank for the next finisher in ascending-time order.
 *
 * Pure: takes the running state, returns the rank plus the next state. That is what makes
 * the ranking pass resumable — the state is small enough to persist on the session as
 * `rankCursor`, so a tie straddling a chunk boundary still resolves correctly.
 */
export function nextRank(state: RankState, timeMs: number): { rank: number; state: RankState } {
  const processed = state.processed + 1

  // Same time as the previous finisher ⇒ share their rank.
  const rank = state.lastTimeMs !== null && timeMs === state.lastTimeMs
    ? state.lastRank
    // Otherwise take this finisher's ordinal position, which naturally skips the ranks a
    // preceding tie consumed.
    : processed

  return { rank, state: { lastTimeMs: timeMs, lastRank: rank, processed } }
}
