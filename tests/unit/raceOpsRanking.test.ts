// RD-RACEOPS-01 Sprint 3 — ranking engine + tie policy.
//
// Covers the brief's Step 4: overall + pass rank ONLY, and that gender / age / category
// rank are NOT produced. Also pins that the resumable chunk path and the whole-set path
// agree, since a divergence there would silently corrupt published placings.

import { describe, it, expect } from 'vitest'
import { isRankable, rankChunk, rankResults } from '@/features/race-operations/ranking/engine'
import { INITIAL_RANK_STATE, nextRank } from '@/features/race-operations/ranking/ties'
import type { NormalizedRaceResult, RaceResultStatus } from '@/features/race-operations/types/results'

/** Minimal canonical row. */
function row(
  rowNumber: number,
  chipTimeMs: number | null,
  status: RaceResultStatus = 'finished',
): NormalizedRaceResult {
  return {
    rowNumber,
    bibNumber:   String(1000 + rowNumber),
    chipTimeMs,
    gunTimeMs:   null,
    chipTimeRaw: chipTimeMs === null ? null : String(chipTimeMs),
    gunTimeRaw:  null,
    status,
    statusRaw:   null,
    gender:      'M',
    category:    'Open',
    ageGroup:    '30-39',
    rawRow:      {},
    sourceProvider: 'csv',
  }
}

const ranksByRow = (rs: NormalizedRaceResult[]) =>
  Object.fromEntries(rankResults(rs).map(a => [a.rowNumber, a.overallRank]))

describe('nextRank — standard competition ranking (1224)', () => {
  it('assigns sequential ranks for distinct times', () => {
    let s = INITIAL_RANK_STATE
    const out: number[] = []
    for (const t of [1000, 2000, 3000]) {
      const step = nextRank(s, t); s = step.state; out.push(step.rank)
    }
    expect(out).toEqual([1, 2, 3])
  })

  it('shares a rank on a tie and SKIPS the consumed rank', () => {
    let s = INITIAL_RANK_STATE
    const out: number[] = []
    for (const t of [1000, 2000, 2000, 3000]) {
      const step = nextRank(s, t); s = step.state; out.push(step.rank)
    }
    expect(out).toEqual([1, 2, 2, 4])       // 3 is skipped, never reused
  })

  it('handles a three-way tie', () => {
    let s = INITIAL_RANK_STATE
    const out: number[] = []
    for (const t of [1000, 1000, 1000, 2000]) {
      const step = nextRank(s, t); s = step.state; out.push(step.rank)
    }
    expect(out).toEqual([1, 1, 1, 4])
  })

  it('handles a tie at the very front', () => {
    let s = INITIAL_RANK_STATE
    const a = nextRank(s, 500); s = a.state
    const b = nextRank(s, 500)
    expect([a.rank, b.rank]).toEqual([1, 1])
  })
})

describe('isRankable', () => {
  it('requires a finished status AND a positive time', () => {
    expect(isRankable({ status: 'finished', chipTimeMs: 1000 })).toBe(true)
    expect(isRankable({ status: 'finished', chipTimeMs: null })).toBe(false)
    expect(isRankable({ status: 'finished', chipTimeMs: 0 })).toBe(false)
    expect(isRankable({ status: 'dnf', chipTimeMs: 1000 })).toBe(false)
    expect(isRankable({ status: 'dns', chipTimeMs: null })).toBe(false)
    expect(isRankable({ status: 'dq',  chipTimeMs: 1000 })).toBe(false)
  })
})

describe('rankResults', () => {
  it('ranks by ascending chip time regardless of input order', () => {
    expect(ranksByRow([row(2, 3000), row(3, 1000), row(4, 2000)]))
      .toEqual({ 2: 3, 3: 1, 4: 2 })
  })

  it('gives DNF / DNS / DQ a null rank — never 0, never a place at the back', () => {
    const out = rankResults([
      row(2, 1000),
      row(3, null, 'dnf'),
      row(4, null, 'dns'),
      row(5, 9000, 'dq'),
      row(6, 2000),
    ])
    const by = Object.fromEntries(out.map(a => [a.rowNumber, a]))
    expect(by[2].overallRank).toBe(1)
    expect(by[6].overallRank).toBe(2)
    expect(by[3].overallRank).toBeNull()
    expect(by[4].overallRank).toBeNull()
    expect(by[5].overallRank).toBeNull()   // disqualified, even though a time exists
  })

  it('does not rank a finisher whose time is unreadable', () => {
    const out = rankResults([row(2, 1000), row(3, null)])
    const by = Object.fromEntries(out.map(a => [a.rowNumber, a]))
    expect(by[2].overallRank).toBe(1)
    expect(by[3].overallRank).toBeNull()
  })

  it('applies the tie policy end to end', () => {
    expect(ranksByRow([row(2, 1000), row(3, 2000), row(4, 2000), row(5, 3000)]))
      .toEqual({ 2: 1, 3: 2, 4: 2, 5: 4 })
  })

  it('is deterministic for equal times — file order breaks the display tie', () => {
    const rows = [row(9, 2000), row(4, 2000), row(7, 1000)]
    expect(rankResults(rows)).toEqual(rankResults(rows))
  })

  it('populates passRank alongside overallRank', () => {
    const out = rankResults([row(2, 1000), row(3, 2000)])
    expect(out.map(a => a.passRank)).toEqual([1, 2])
  })

  it('returns one assignment per input row, in input order', () => {
    const rows = [row(5, 3000), row(2, 1000), row(9, null, 'dnf')]
    expect(rankResults(rows).map(a => a.rowNumber)).toEqual([5, 2, 9])
  })

  it('handles an empty set and an all-DNF set', () => {
    expect(rankResults([])).toEqual([])
    const allDnf = rankResults([row(2, null, 'dnf'), row(3, null, 'dns')])
    expect(allDnf.every(a => a.overallRank === null && a.passRank === null)).toBe(true)
  })
})

describe('rankChunk — resumable path agrees with the whole-set path', () => {
  /** Sorted finishers, as Firestore would page them. */
  const sorted = [
    { rowNumber: 2, chipTimeMs: 1000 },
    { rowNumber: 3, chipTimeMs: 2000 },
    { rowNumber: 4, chipTimeMs: 2000 },   // tie
    { rowNumber: 5, chipTimeMs: 3000 },
    { rowNumber: 6, chipTimeMs: 4000 },
  ]

  it('matches the in-memory engine when run as ONE chunk', () => {
    const chunked = rankChunk(sorted, INITIAL_RANK_STATE).assignments
    const whole   = rankResults(sorted.map(r => row(r.rowNumber, r.chipTimeMs)))
    expect(chunked.map(a => a.rank)).toEqual(whole.map(a => a.overallRank))
  })

  it('keeps a tie correct when it STRADDLES a chunk boundary', () => {
    // Split between the two tied rows (3 and 4) — the hard case the cursor exists for.
    const first  = rankChunk(sorted.slice(0, 3), INITIAL_RANK_STATE)
    const second = rankChunk(sorted.slice(3), first.state)
    const all = [...first.assignments, ...second.assignments]
    expect(all.map(a => a.rank)).toEqual([1, 2, 2, 4, 5])
  })

  it('produces the same ranks for every chunk-size split', () => {
    const expected = rankChunk(sorted, INITIAL_RANK_STATE).assignments.map(a => a.rank)
    for (let size = 1; size <= sorted.length; size++) {
      const out: number[] = []
      let state = INITIAL_RANK_STATE
      for (let i = 0; i < sorted.length; i += size) {
        const step = rankChunk(sorted.slice(i, i + size), state)
        state = step.state
        out.push(...step.assignments.map(a => a.rank))
      }
      expect(out, `split size ${size}`).toEqual(expected)
    }
  })

  it('carries `processed` forward so ranks never restart at 1', () => {
    const first  = rankChunk(sorted.slice(0, 2), INITIAL_RANK_STATE)
    const second = rankChunk(sorted.slice(2), first.state)
    expect(second.assignments[0].rank).toBeGreaterThan(1)
    expect(second.state.processed).toBe(sorted.length)
  })

  it('is a no-op for an empty chunk', () => {
    const out = rankChunk([], INITIAL_RANK_STATE)
    expect(out.assignments).toEqual([])
    expect(out.state).toEqual(INITIAL_RANK_STATE)
  })
})

describe('Sprint 3 scope — gender / age / category are NOT ranked', () => {
  it('the assignment shape exposes only overall and pass rank', () => {
    const [a] = rankResults([row(2, 1000)])
    expect(Object.keys(a).sort()).toEqual(['overallRank', 'passRank', 'rowNumber'])
  })
})
