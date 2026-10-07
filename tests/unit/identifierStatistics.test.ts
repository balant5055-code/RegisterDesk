// RD-EVENT-19B — Identifier allocation read model & authoritative statistics.
//
// THE RULE. Every number this layer produces is either measured or admitted to be
// unknown. There is no third option, and `0` is never the fallback for a failed
// read — "nobody has an identifier yet" and "we could not find out" lead to
// opposite decisions, and one of them is printed next to a button labelled
// "Assign".
//
// What is pinned here, and why each matters:
//   1. CAPACITY comes from configured ranges. Never from registrations, never
//      from the highest assigned value, never from a counter.
//   2. UNLIMITED is not 0 and not 100%. An unbounded pool has no meter.
//   3. INCONSISTENT (120 of 100) is shown, not clamped. Clamping hides the data
//      problem that caused it.
//   4. ONE BAD POOL cannot erase the healthy ones, and a partial total is
//      reported as unknown rather than as a confident wrong number.
//   5. UNASSIGNED counts are UNKNOWN, on purpose, with the missing data model
//      named — 19A refused to invent an eligibility policy and 19B refuses to
//      invent a counter.
//   6. NO REGISTRATION SCAN. The statistics must not need 20,000 documents.
//
// Source-level assertions are comment-stripped so prose ABOUT the code can never
// satisfy them.

import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

vi.mock('@/lib/firebase/admin', () => ({ adminDb: {} }))

import {
  calculatePoolCapacity, calculateUtilization, resolvePoolState, sumMetrics,
  summarizePool, summarizePassScopes, summarizeIdentifiers, buildEligibilityReport,
  buildIdentifierReadModel, knownMetric, EMPTY_COUNTS,
  UNASSIGNED_UNKNOWN_REASON,
} from '@/lib/identifiers/statistics'
import type {
  PoolStateCounts, ReadModelContext, IdentifierUsage,
} from '@/lib/identifiers/statistics'
import { defaultIdentifierConfig, DEFAULT_POOL_ID, MAX_STAT_POOLS } from '@/lib/identifiers/config'
import type { IdentifierConfig, IdentifierPool } from '@/lib/identifiers/types'

// ─── Source helpers ─────────────────────────────────────────────────────────

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

const STATS  = code(read('lib/identifiers/statistics.ts'))
const CONFIG = code(read('lib/identifiers/config.ts'))
const SCOPE  = code(read('lib/identifiers/organizerScope.ts'))
const ROUTE  = code(read('app/api/organizer/events/[eventId]/identifiers/route.ts'))
const TAB    = code(read('app/(dashboard)/dashboard/events/[eventId]/tabs/SportsTab.tsx'))

// ─── Fixtures ───────────────────────────────────────────────────────────────

const CTX: ReadModelContext = { passes: [], passesKnown: true }
const ctxWith = (passes: Array<{ id: string; name: string }>): ReadModelContext =>
  ({ passes, passesKnown: true })

const counts = (over: Partial<PoolStateCounts> = {}): PoolStateCounts => ({
  assigned: 0, consumed: 0, reserved: 0, blocked: 0, retired: 0, released: 0, ...over,
})

const cfg = (pools: IdentifierPool[], over: Partial<IdentifierConfig> = {}): IdentifierConfig =>
  ({ ...defaultIdentifierConfig('evt'), pools, defaultPoolId: pools[0]?.poolId ?? DEFAULT_POOL_ID, ...over })

const usageOf = (
  byPool: Record<string, PoolStateCounts>,
  over: Partial<IdentifierUsage> = {},
): IdentifierUsage => ({
  byPool: new Map(Object.entries(byPool)),
  nextNumbers: new Map(),
  reusable: 0, eligible: 0, legacyLocks: 0,
  ...over,
})

// ════════════════════════════════════════════════════════════════════════════
// 1 — CAPACITY
// ════════════════════════════════════════════════════════════════════════════

describe('1 — configured capacity is arithmetic over the configured ranges', () => {
  it('a single range', () => {
    expect(calculatePoolCapacity({ poolId: 'p', label: 'P', ranges: [{ start: 5001, end: 5999 }] }))
      .toMatchObject({ kind: 'finite', capacity: 999 })
  })

  it('multiple ranges SUM, and the gap is not counted', () => {
    const c = calculatePoolCapacity({
      poolId: 'p', label: 'P', ranges: [{ start: 5001, end: 5999 }, { start: 7000, end: 7500 }],
    })
    expect(c.capacity).toBe(1500)
    expect(c.capacity).not.toBe(7500 - 5001)   // 2499 — the gap-inclusive lie
    expect(c.capacity).not.toBe(2500)
  })

  it('adjacent ranges sum without overlap', () => {
    expect(calculatePoolCapacity({
      poolId: 'p', label: 'P', ranges: [{ start: 1, end: 100 }, { start: 101, end: 200 }],
    }).capacity).toBe(200)
  })

  it('a legacy scalar range still reports its capacity', () => {
    expect(calculatePoolCapacity({ poolId: 'p', label: 'P', rangeStart: 100, rangeEnd: 199 }))
      .toMatchObject({ kind: 'finite', capacity: 100 })
  })

  it('a single-number range has capacity 1', () => {
    expect(calculatePoolCapacity({ poolId: 'p', label: 'P', ranges: [{ start: 7, end: 7 }] }).capacity).toBe(1)
  })

  it('UNLIMITED · no range configured is null, never 0', () => {
    const c = calculatePoolCapacity({ poolId: 'p', label: 'P' })
    expect(c).toMatchObject({ kind: 'unlimited', capacity: null })
    expect(c.capacity).not.toBe(0)
  })

  it('UNLIMITED · a half-bounded legacy pool has no configured total, and says why', () => {
    const c = calculatePoolCapacity({ poolId: 'p', label: 'P', rangeStart: 5001 })
    expect(c.kind).toBe('unlimited')
    expect(c.reason).toMatch(/one end/i)
  })

  it('never serializes Infinity', () => {
    const c = calculatePoolCapacity({ poolId: 'p', label: 'P' })
    expect(Number.isFinite(c.capacity as number)).toBe(false)
    expect(JSON.stringify(c)).not.toContain('Infinity')
    expect(JSON.stringify(c)).toContain('null')
  })

  it('capacity is never derived from usage', () => {
    const pool = { poolId: 'p', label: 'P', ranges: [{ start: 1, end: 10 }] }
    const a = summarizePool(pool, cfg([pool]), counts({ assigned: 0 }), CTX)
    const b = summarizePool(pool, cfg([pool]), counts({ assigned: 9 }), CTX)
    expect(a.capacity).toBe(10)
    expect(b.capacity).toBe(10)
  })

  it('the range arithmetic is not duplicated — it reuses the 19A helpers', () => {
    expect(STATS).toContain("from './ranges'")
    expect(STATS).toContain('rangeCapacity')
    expect(STATS).not.toContain('end - r.start + 1')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 2 — UTILIZATION
// ════════════════════════════════════════════════════════════════════════════

describe('2 — utilization is a ratio or nothing', () => {
  it('0 of 100 is 0', () => expect(calculateUtilization(0, 100)).toBe(0))
  it('50 of 100 is 0.5', () => expect(calculateUtilization(50, 100)).toBe(0.5))
  it('100 of 100 is 1', () => expect(calculateUtilization(100, 100)).toBe(1))
  it('120 of 100 is 1.2 — NOT clamped', () => expect(calculateUtilization(120, 100)).toBeCloseTo(1.2))
  it('unknown of 100 is null, not 0', () => {
    expect(calculateUtilization(null, 100)).toBeNull()
    expect(calculateUtilization(null, 100)).not.toBe(0)
  })
  it('100 of unknown is null, not 1', () => {
    expect(calculateUtilization(100, null)).toBeNull()
    expect(calculateUtilization(100, null)).not.toBe(1)
  })
  it('UNLIMITED is null — an unbounded pool is never "100% full"', () => {
    expect(calculateUtilization(5000, null)).toBeNull()
  })
  it('a zero denominator is null, not NaN or Infinity', () => {
    const u = calculateUtilization(5, 0)
    expect(u).toBeNull()
    expect(Number.isNaN(u as number)).toBe(false)
  })
  it('the domain returns a number, never a formatted string', () => {
    expect(typeof calculateUtilization(1, 2)).toBe('number')
    expect(STATS).not.toContain('toFixed')
    expect(STATS).not.toContain("+ '%'")
  })
  it('no near-capacity threshold is invented in the domain layer', () => {
    expect(STATS).not.toContain('near_capacity')
    expect(STATS).not.toMatch(/0\.[89]\d*\s*\)/)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 3 — STATE
// ════════════════════════════════════════════════════════════════════════════

describe('3 — a pool state distinguishes every reason it is not simply "available"', () => {
  const base = { orphanedPassIds: [] as string[], hasPassRestriction: false }
  const finite = (n: number) => ({ kind: 'finite' as const, capacity: n, reason: null })
  const unlimited = { kind: 'unlimited' as const, capacity: null, reason: null }

  it('empty · finite capacity, nothing used', () =>
    expect(resolvePoolState({ ...base, capacity: finite(100), occupied: 0 }).state).toBe('empty'))

  it('available · room left', () =>
    expect(resolvePoolState({ ...base, capacity: finite(100), occupied: 50 }).state).toBe('available'))

  it('exhausted · nothing left', () =>
    expect(resolvePoolState({ ...base, capacity: finite(100), occupied: 100 }).state).toBe('exhausted'))

  it('inconsistent · more in use than configured, and it SAYS so', () => {
    const s = resolvePoolState({ ...base, capacity: finite(100), occupied: 120 })
    expect(s.state).toBe('inconsistent')
    expect(s.reason).toMatch(/120/)
    expect(s.reason).toMatch(/100/)
    expect(s.state).not.toBe('exhausted')
  })

  it('unlimited · no finite capacity', () =>
    expect(resolvePoolState({ ...base, capacity: unlimited, occupied: 9999 }).state).toBe('unlimited'))

  it('unavailable · usage could not be read — NOT empty', () => {
    const s = resolvePoolState({ ...base, capacity: finite(100), occupied: null })
    expect(s.state).toBe('unavailable')
    expect(s.state).not.toBe('empty')
  })

  it('orphaned outranks everything, because the pool cannot receive an allocation', () => {
    const s = resolvePoolState({
      capacity: finite(100), occupied: 0, orphanedPassIds: ['gone'], hasPassRestriction: true,
    })
    expect(s.state).toBe('orphaned')
    expect(s.state).not.toBe('empty')
  })

  it('an unrestricted pool is never orphaned', () => {
    expect(resolvePoolState({
      capacity: finite(100), occupied: 0, orphanedPassIds: ['gone'], hasPassRestriction: false,
    }).state).toBe('empty')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 4 — POOL SUMMARY
// ════════════════════════════════════════════════════════════════════════════

describe('4 — a pool summary is exact or honest', () => {
  const pool: IdentifierPool = { poolId: 'a', label: 'A', ranges: [{ start: 1, end: 100 }] }

  it('occupied excludes released — a released value IS free to issue again', () => {
    const s = summarizePool(pool, cfg([pool]),
      counts({ assigned: 10, consumed: 5, reserved: 2, blocked: 1, retired: 1, released: 50 }), CTX)
    expect(s.occupied).toBe(19)
    expect(s.available).toBe(81)
  })

  it('assigned and consumed are reported separately — they are not the same fact', () => {
    const s = summarizePool(pool, cfg([pool]), counts({ assigned: 10, consumed: 5 }), CTX)
    expect(s.assigned).toBe(10)
    expect(s.consumed).toBe(5)
  })

  it('one unreadable state makes occupied unknown, but the readable ones survive', () => {
    const s = summarizePool(pool, cfg([pool]),
      counts({ assigned: 10, consumed: null, reserved: 3 }), CTX)
    expect(s.assigned).toBe(10)
    expect(s.reserved).toBe(3)
    expect(s.consumed).toBeNull()
    expect(s.occupied).toBeNull()
    expect(s.available).toBeNull()
    expect(s.utilization).toBeNull()
    expect(s.state).toBe('unavailable')
  })

  it('a pool with NO counts at all is unavailable, never a row of zeroes', () => {
    const s = summarizePool(pool, cfg([pool]), EMPTY_COUNTS, CTX)
    expect(s.assigned).toBeNull()
    expect(s.state).toBe('unavailable')
    expect(s.assigned).not.toBe(0)
  })

  it('an INCONSISTENT pool reports no "available" — there is no honest remainder', () => {
    const s = summarizePool(pool, cfg([pool]), counts({ assigned: 120 }), CTX)
    expect(s.state).toBe('inconsistent')
    expect(s.available).toBeNull()
    expect(s.available).not.toBe(0)
    expect(s.utilization).toBeCloseTo(1.2)
  })

  it('an unlimited pool has null capacity, null available and null utilization', () => {
    const open: IdentifierPool = { poolId: 'o', label: 'O' }
    const s = summarizePool(open, cfg([open]), counts({ assigned: 9999 }), CTX)
    expect(s.capacityKind).toBe('unlimited')
    expect(s.capacity).toBeNull()
    expect(s.available).toBeNull()
    expect(s.utilization).toBeNull()
    expect(s.assigned).toBe(9999)
  })

  it('the identifier label rides along, so no consumer hardcodes one', () => {
    const s = summarizePool(pool, cfg([pool], { label: 'Delegate ID' }), counts(), CTX)
    expect(s.identifierLabel).toBe('Delegate ID')
  })

  it('the default pool is flagged', () => {
    const s = summarizePool(pool, cfg([pool], { defaultPoolId: 'a' }), counts(), CTX)
    expect(s.isDefault).toBe(true)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 5 — ORPHANED PASS POOLS
// ════════════════════════════════════════════════════════════════════════════

describe('5 — a pool wired to a deleted pass is reported, never repaired', () => {
  const pool: IdentifierPool = { poolId: 'a', label: 'A', passIds: ['gone'], ranges: [{ start: 1, end: 10 }] }

  it('names the missing pass', () => {
    const s = summarizePool(pool, cfg([pool]), counts(), ctxWith([{ id: 'alive', name: 'Alive' }]))
    expect(s.state).toBe('orphaned')
    expect(s.orphanedPassIds).toEqual(['gone'])
  })

  it('a pool whose pass still exists is NOT orphaned', () => {
    const ok: IdentifierPool = { poolId: 'a', label: 'A', passIds: ['alive'], ranges: [{ start: 1, end: 10 }] }
    const s = summarizePool(ok, cfg([ok]), counts(), ctxWith([{ id: 'alive', name: 'Alive' }]))
    expect(s.state).not.toBe('orphaned')
    expect(s.orphanedPassIds).toEqual([])
  })

  it('a partially-orphaned pool is still flagged', () => {
    const mixed: IdentifierPool = { poolId: 'a', label: 'A', passIds: ['alive', 'gone'] }
    const s = summarizePool(mixed, cfg([mixed]), counts(), ctxWith([{ id: 'alive', name: 'Alive' }]))
    expect(s.orphanedPassIds).toEqual(['gone'])
  })

  it('when the passes are UNKNOWN nothing is called orphaned — a guess would condemn every pool', () => {
    const s = summarizePool(pool, cfg([pool]), counts(), { passes: [], passesKnown: false })
    expect(s.orphanedPassIds).toEqual([])
    expect(s.state).not.toBe('orphaned')
  })

  it('detection is REPORTING only — the read model cannot release or delete', () => {
    // It holds no writer of any kind: no SDK, no transaction, no document handle.
    // (`Map.set` on a local accumulator is not a Firestore write and is expected.)
    for (const banned of ['releaseIdentifier', 'runTransaction', 'FieldValue',
                          'adminDb', '.doc(', '.collection(', 'batch']) {
      expect(STATS, banned).not.toContain(banned)
    }
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 6 — PASS SCOPES
// ════════════════════════════════════════════════════════════════════════════

describe('6 — pass scopes answer "how is this pass doing" without touching a registration', () => {
  const pools: IdentifierPool[] = [
    { poolId: 'a1', label: 'A one', passIds: ['5k'],  ranges: [{ start: 5001, end: 5999 }] },
    { poolId: 'a2', label: 'A two', passIds: ['5k'],  ranges: [{ start: 7000, end: 7500 }] },
    { poolId: 'b',  label: 'B',     passIds: ['10k'], ranges: [{ start: 8000, end: 8799 }] },
    { poolId: 'def', label: 'Default' },
  ]
  const config = cfg(pools, { defaultPoolId: 'def' })
  const ctx = ctxWith([{ id: '5k', name: 'Five' }, { id: '10k', name: 'Ten' }])

  const build = (over: Record<string, PoolStateCounts> = {}) => {
    const stats = pools.map(p => summarizePool(p, config, over[p.poolId] ?? counts(), ctx))
    return summarizePassScopes(stats, ctx, 'unknown')
  }

  it('MULTIPLE POOLS FOR ONE PASS sum into one pass capacity', () => {
    const five = build().find(s => s.passId === '5k')!
    expect(five.capacity).toBe(999 + 501)
    expect(five.poolIds).toEqual(['a1', 'a2'])
  })

  it('the physical pools are NOT collapsed — the allocator still needs pool identity', () => {
    const stats = pools.map(p => summarizePool(p, config, counts(), ctx))
    expect(stats.map(s => s.poolId)).toEqual(['a1', 'a2', 'b', 'def'])
  })

  it('assigned and available fold across a pass\'s pools', () => {
    const scopes = build({ a1: counts({ assigned: 100 }), a2: counts({ assigned: 1 }) })
    const five = scopes.find(s => s.passId === '5k')!
    expect(five.assigned).toBe(101)
    expect(five.available).toBe(1500 - 101)
    expect(five.utilization).toBeCloseTo(101 / 1500)
  })

  it('an unreadable pool makes only ITS pass unknown, not the others', () => {
    const scopes = build({ a1: EMPTY_COUNTS, b: counts({ assigned: 7 }) })
    expect(scopes.find(s => s.passId === '5k')!.assigned).toBeNull()
    expect(scopes.find(s => s.passId === '10k')!.assigned).toBe(7)
  })

  it('an unrestricted pool becomes the trailing null scope', () => {
    const scopes = build()
    const last = scopes[scopes.length - 1]
    expect(last.passId).toBeNull()
    expect(last.poolIds).toEqual(['def'])
  })

  it('a pass scope containing an unlimited pool has no capacity and no meter', () => {
    const openPools: IdentifierPool[] = [
      { poolId: 'x', label: 'X', passIds: ['5k'], ranges: [{ start: 1, end: 10 }] },
      { poolId: 'y', label: 'Y', passIds: ['5k'] },
    ]
    const c = cfg(openPools, { defaultPoolId: 'x' })
    const stats = openPools.map(p => summarizePool(p, c, counts(), ctx))
    const scope = summarizePassScopes(stats, ctx, 'unknown')[0]
    expect(scope.capacityKind).toBe('unlimited')
    expect(scope.capacity).toBeNull()
    expect(scope.utilization).toBeNull()
  })

  it('ORDERING follows the event\'s pass order, then orphans, then unrestricted', () => {
    const withOrphan: IdentifierPool[] = [
      { poolId: 'z', label: 'Z', passIds: ['ghost'] },
      { poolId: 'b', label: 'B', passIds: ['10k'] },
      { poolId: 'a', label: 'A', passIds: ['5k'] },
      { poolId: 'def', label: 'D' },
    ]
    const c = cfg(withOrphan, { defaultPoolId: 'def' })
    const stats = withOrphan.map(p => summarizePool(p, c, counts(), ctx))
    const scopes = summarizePassScopes(stats, ctx, 'unknown')
    expect(scopes.map(s => s.passId)).toEqual(['5k', '10k', 'ghost', null])
  })

  it('ORDERING is stable across repeated calls', () => {
    const a = build().map(s => s.passId)
    const b = build().map(s => s.passId)
    expect(a).toEqual(b)
  })

  it('an orphaned pass scope is marked, and carries no invented name', () => {
    const orphan: IdentifierPool[] = [{ poolId: 'z', label: 'Z', passIds: ['ghost'] }]
    const c = cfg(orphan)
    const scopes = summarizePassScopes(orphan.map(p => summarizePool(p, c, counts(), ctx)), ctx, 'unknown')
    // RD-BIB-UX-02 · re-anchored from POSITION to IDENTITY, not weakened. Scopes are
    // now emitted for every pass the EVENT has — a pass with no number range used to
    // vanish from this list, taking its known participant count with it — so the
    // event's own passes come first and the orphan follows them. The property under
    // test is unchanged: the orphan is present, marked, and given no invented name.
    const ghost = scopes.find(s => s.passId === 'ghost')
    expect(ghost).toMatchObject({ passId: 'ghost', passExists: false, passName: null })
  })

  it('eligible and unassigned are UNKNOWN in this phase, with the reason attached', () => {
    const five = build().find(s => s.passId === '5k')!
    expect(five.eligible.status).toBe('unavailable')
    expect(five.unassignedEligible.status).toBe('unavailable')
    expect(five.eligible.value).toBeNull()
    expect(five.eligible.value).not.toBe(0)
  })

  it('pass statistics are computed from POOL data — no registration is consulted', () => {
    // `summarizePassScopes` takes IdentifierPoolStat[] and nothing else: there is
    // no registration input it could scan even if it wanted to.
    const fn = STATS.slice(
      STATS.indexOf('export function summarizePassScopes'),
      STATS.indexOf('export interface IdentifierSummary'),
    )
    expect(fn).not.toContain('registration')
    expect(fn).not.toContain('passCounts')
    expect(STATS).toContain('pools: IdentifierPoolStat[]')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 7 — EVENT SUMMARY
// ════════════════════════════════════════════════════════════════════════════

describe('7 — the event summary never assembles a total from partial data', () => {
  const finitePools: IdentifierPool[] = [
    { poolId: 'a', label: 'A', ranges: [{ start: 1, end: 100 }] },
    { poolId: 'b', label: 'B', ranges: [{ start: 200, end: 299 }] },
  ]
  const config = cfg(finitePools)
  const statsOf = (by: Record<string, PoolStateCounts>) =>
    finitePools.map(p => summarizePool(p, config, by[p.poolId] ?? counts(), CTX))

  it('sums a healthy event', () => {
    const s = summarizeIdentifiers(statsOf({ a: counts({ assigned: 10 }), b: counts({ assigned: 5 }) }), 3)
    expect(s.configuredCapacity).toBe(200)
    expect(s.assigned).toBe(15)
    expect(s.available).toBe(185)
    expect(s.reusable).toBe(3)
    expect(s.utilization).toBeCloseTo(15 / 200)
  })

  it('ONE unreadable pool makes the TOTAL unknown but leaves the healthy pool exact', () => {
    const pools = statsOf({ a: counts({ assigned: 10 }), b: EMPTY_COUNTS })
    const s = summarizeIdentifiers(pools, null)
    expect(pools[0].assigned).toBe(10)          // healthy pool survives
    expect(s.assigned).toBeNull()               // the total does not pretend
    expect(s.assigned).not.toBe(10)
    expect(s.poolsUnavailable).toBe(1)
  })

  it('an unlimited pool anywhere means the EVENT has no configured total', () => {
    const mixed: IdentifierPool[] = [
      { poolId: 'a', label: 'A', ranges: [{ start: 1, end: 100 }] },
      { poolId: 'o', label: 'O' },
    ]
    const c = cfg(mixed)
    const s = summarizeIdentifiers(mixed.map(p => summarizePool(p, c, counts(), CTX)), 0)
    expect(s.capacityKind).toBe('mixed')
    expect(s.configuredCapacity).toBeNull()
    expect(s.available).toBeNull()
    expect(s.utilization).toBeNull()
  })

  it('counts pools by state so a UI can explain a missing total', () => {
    const many: IdentifierPool[] = [
      { poolId: 'ok',   label: 'Ok',   ranges: [{ start: 1, end: 10 }] },
      { poolId: 'full', label: 'Full', ranges: [{ start: 20, end: 29 }] },
      { poolId: 'over', label: 'Over', ranges: [{ start: 40, end: 49 }] },
      { poolId: 'dark', label: 'Dark', ranges: [{ start: 60, end: 69 }] },
    ]
    const c = cfg(many)
    const s = summarizeIdentifiers([
      summarizePool(many[0], c, counts({ assigned: 1 }), CTX),
      summarizePool(many[1], c, counts({ assigned: 10 }), CTX),
      summarizePool(many[2], c, counts({ assigned: 40 }), CTX),
      summarizePool(many[3], c, EMPTY_COUNTS, CTX),
    ], null)
    expect(s.poolsTotal).toBe(4)
    expect(s.poolsExhausted).toBe(1)
    expect(s.poolsInconsistent).toBe(1)
    expect(s.poolsUnavailable).toBe(1)
  })

  it('sumMetrics refuses to add around a hole', () => {
    expect(sumMetrics([1, 2, 3])).toBe(6)
    expect(sumMetrics([1, null, 3])).toBeNull()
    expect(sumMetrics([])).toBe(0)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 8 — ELIGIBILITY
// ════════════════════════════════════════════════════════════════════════════

describe('8 — eligibility is reported, not decided', () => {
  it('the divergence 19A found is stated explicitly', () => {
    const r = buildEligibilityReport(100)
    expect(r.policy).toBe('divergent')
    expect(r.engineTerminalStatuses).toEqual(['cancelled', 'rejected'])
    expect(r.rosterStatuses).toEqual(['confirmed'])
    expect(r.divergentStatuses.sort()).toEqual(['pending', 'waitlisted'])
  })

  it('the eligible count IS known — one aggregate, zero documents', () => {
    expect(buildEligibilityReport(1500).eligible).toEqual(knownMetric(1500))
  })

  it('a genuine zero stays a zero', () => {
    expect(buildEligibilityReport(0).eligible.value).toBe(0)
    expect(buildEligibilityReport(0).eligible.status).toBe('known')
  })

  it('an unreadable eligible count is unavailable, not zero', () => {
    const r = buildEligibilityReport(null)
    expect(r.eligible.value).toBeNull()
    expect(r.eligible.status).toBe('unavailable')
    expect(r.eligible.value).not.toBe(0)
  })

  it('UNASSIGNED is UNKNOWN, and names the missing data model rather than guessing', () => {
    const r = buildEligibilityReport(1500)
    expect(r.unassignedEligible.status).toBe('unavailable')
    expect(r.unassignedEligible.value).toBeNull()
    expect(r.unassignedReason).toBe(UNASSIGNED_UNKNOWN_REASON)
    expect(r.unassignedReason).toMatch(/denormalized flag|per-pass assigned counter/)
  })

  it('it is NOT derived as eligible minus assigned, which would be unsound', () => {
    // A lock carries no registration status, so subtracting locks from eligible
    // registrations would deduct identifiers held by cancelled registrations.
    expect(r_unassignedIsNotDerived()).toBe(true)
    expect(UNASSIGNED_UNKNOWN_REASON).toMatch(/unsound/)
  })

  function r_unassignedIsNotDerived(): boolean {
    const r = buildEligibilityReport(1000)
    return r.unassignedEligible.value === null
  }

  it('19B does not resolve the product decision', () => {
    expect(STATS).not.toContain("policy: 'aligned' as const")
    expect(buildEligibilityReport(1).policy).toBe('divergent')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 9 — THE ASSEMBLED READ MODEL
// ════════════════════════════════════════════════════════════════════════════

describe('9 — the whole model', () => {
  const pools: IdentifierPool[] = [
    { poolId: 'def', label: 'Default' },
    { poolId: 'a', label: 'A', passIds: ['5k'], ranges: [{ start: 5001, end: 5999 }] },
  ]
  const config = cfg(pools, { defaultPoolId: 'def', label: 'Bib Number' })

  const model = () => buildIdentifierReadModel({
    eventSlug: 'evt', config, configured: true,
    usage: usageOf(
      { def: counts({ assigned: 2 }), a: counts({ assigned: 100 }) },
      { nextNumbers: new Map([['a', 5101]]), reusable: 4, eligible: 900, legacyLocks: 7 },
    ),
    ctx: ctxWith([{ id: '5k', name: 'Five' }]),
  })

  it('pool ORDER follows the configuration array, never document order', () => {
    expect(model().pools.map(p => p.poolId)).toEqual(['def', 'a'])
  })

  it('is deterministic across identical calls', () => {
    expect(JSON.stringify(model())).toBe(JSON.stringify(model()))
  })

  it('carries the next number through', () => {
    expect(model().pools.find(p => p.poolId === 'a')!.nextNumber).toBe(5101)
  })

  it('a pool with no counter reports null, not the range start', () => {
    expect(model().pools.find(p => p.poolId === 'def')!.nextNumber).toBeNull()
  })

  it('legacy locks are reported SEPARATELY and never folded into assigned', () => {
    const m = model()
    expect(m.legacyLocks).toEqual(knownMetric(7))
    expect(m.summary.assigned).toBe(102)     // 2 + 100, the legacy 7 is not added
  })

  it('a serialized model contains no Infinity and no NaN', () => {
    const json = JSON.stringify(model())
    expect(json).not.toContain('Infinity')
    expect(json).not.toContain('NaN')
  })

  it('carries ZERO personally identifying information', () => {
    const json = JSON.stringify(model()).toLowerCase()
    for (const field of ['email', 'phone', 'attendee', 'firstname', 'lastname', 'address', 'formresponses']) {
      expect(json, field).not.toContain(field)
    }
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 10 — READ COST CONTRACTS (structural)
// ════════════════════════════════════════════════════════════════════════════

describe('10 — the statistics cannot be produced by scanning registrations', () => {
  it('the unbounded lock scan is GONE', () => {
    // BEFORE: identifierLocks.where('eventSlug','==',slug).get() — every document
    // of every lock, just to produce seven numbers.
    expect(CONFIG).not.toContain(".collection('identifierLocks').where('eventSlug', '==', eventSlug).get()")

    const body = CONFIG.slice(
      CONFIG.indexOf('export async function fetchIdentifierUsage'),
      CONFIG.indexOf('export async function getPoolStatistics'),
    )
    // No QUERY in the usage reader is materialised: every `.where(...)` chain ends
    // in `.count()`. A single `.doc(...).get()` (the per-pool counter) is a
    // one-document read and is not a scan.
    expect(body).not.toMatch(/\.where\([^)]*\)\s*\)?\s*\.get\(\)/)
    // Every query goes through the single aggregate helper.
    expect(body).toContain('countOf(')
    expect(CONFIG).toContain('q.count().get()')
    expect(body).toContain(".doc(`${eventSlug}__${p.poolId}`).get()")
  })

  it('every usage read is an aggregate, and aggregates transfer no documents', () => {
    expect(CONFIG).toContain('q.count().get()')
  })

  it('a failed aggregate becomes null, never 0', () => {
    expect(CONFIG).toContain('.catch(() => null)')
    expect(CONFIG).not.toMatch(/count\).*\?\?\s*0/)
  })

  it('the statistics path reads no registration DOCUMENTS — only a count', () => {
    const usage = CONFIG.slice(
      CONFIG.indexOf('export async function fetchIdentifierUsage'),
      CONFIG.indexOf('export async function getPoolStatistics'),
    )
    expect(usage).toContain("collection('registrations')")
    expect(usage).not.toContain('.select(')
    expect(usage).not.toContain('.limit(')
    // The only thing done with the registrations query is counting it.
    const regAt = usage.indexOf("collection('registrations')")
    expect(usage.slice(regAt - 60, regAt)).toContain('countOf(')
  })

  it('the per-pool aggregate loop is BOUNDED by configuration, with a stated cap', () => {
    expect(CONFIG).toContain('MAX_STAT_POOLS')
    expect(MAX_STAT_POOLS).toBeGreaterThan(0)
    expect(CONFIG).toContain('config.pools.slice(0, MAX_STAT_POOLS)')
  })

  it('the aggregates run in PARALLEL, not as a serial await-in-loop', () => {
    const usage = CONFIG.slice(CONFIG.indexOf('export async function fetchIdentifierUsage'))
    expect(usage).toContain('Promise.all')
    expect(usage).not.toMatch(/for \(const .* of .*\) \{[\s\S]{0,200}await /)
  })

  it('the route resolves the config and the usage ONCE', () => {
    expect(ROUTE).toContain('getIdentifierOverview(')
    expect(ROUTE).not.toContain('getPoolStatistics(')
    expect((ROUTE.match(/getIdentifierOverview\(/g) ?? []).length).toBe(1)
  })

  it('no polling and no timer was introduced', () => {
    for (const src of [CONFIG, STATS, ROUTE]) {
      expect(src).not.toContain('setInterval')
      expect(src).not.toContain('setTimeout')
    }
  })

  it('the tab no longer computes its meter from the downloaded roster', () => {
    expect(TAB).not.toContain('roster?.assigned ?? 0')
    expect(TAB).not.toContain('roster?.registrations.length ?? 0')
    // RD-BIB-UX-03 · the event-level meter no longer reads `summary.utilization`,
    // and that is deliberate rather than a regression. `utilization` is
    // occupied/capacity, where occupied counts reserved, blocked and retired locks
    // too — so the bar would have disagreed with the "assigned" figure printed
    // directly above it. `resolveIdentifierStatus` draws the bar from the SAME
    // aggregate the number states (assigned + consumed) over capacity.
    //
    // The property under test is unchanged: every input is a server aggregate, and
    // no ratio is computed from the downloaded roster array.
    expect(TAB).toContain('assignedLocks: overview')
    expect(TAB).toContain('overview.summary.assigned + overview.summary.consumed')
    expect(TAB).not.toMatch(/roster[^\n]*\/[^\n]*registrations/)
  })

  it('the tab renders an unknown count as an em dash, never as 0', () => {
    expect(TAB).toContain('const UNAVAILABLE = ')
    // RD-EVENT-19D renamed the helper `showCount` → `n`; the property is unchanged.
    expect(TAB).toMatch(/const n = \(v: number \| null \| undefined\)/)
    expect(TAB).toContain(': UNAVAILABLE')
    expect(TAB).not.toMatch(/totals\.assigned \?\? 0/)
  })

  it('the passes needed for orphan detection cost no extra read', () => {
    const fn = SCOPE.slice(SCOPE.indexOf('export async function resolveIdentifierScope'))
    const body = fn.slice(0, fn.indexOf('function readPasses'))
    // Exactly ONE document read in the whole scope resolver: the event draft.
    expect((body.match(/\.get\(\)/g) ?? []).length).toBe(1)
    expect(SCOPE).toContain('readPasses(d)')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 11 — SECURITY (structural)
// ════════════════════════════════════════════════════════════════════════════

describe('11 — scope stays server-authoritative', () => {
  it('the read model is reached only through resolveIdentifierScope', () => {
    expect(ROUTE).toContain('resolveIdentifierScope')
    const get = ROUTE.slice(ROUTE.indexOf('export async function GET'), ROUTE.indexOf('type Action'))
    expect(get.indexOf('resolveIdentifierScope')).toBeLessThan(get.indexOf('getIdentifierOverview'))
  })

  it('the organizer uid used for the eligible count comes from the SCOPE, not the request', () => {
    expect(ROUTE).toContain('scope.workspaceUid')
    expect(ROUTE).not.toMatch(/organizerUid.*searchParams/)
    expect(ROUTE).not.toMatch(/uid.*req\.(json|nextUrl)/)
  })

  it('every usage query is event-scoped', () => {
    const usage = CONFIG.slice(
      CONFIG.indexOf('export async function fetchIdentifierUsage'),
      CONFIG.indexOf('export async function getPoolStatistics'),
    )
    expect(usage).toContain("where('eventSlug', '==', eventSlug)")
    // The registrations aggregate is scoped by BOTH owner and event.
    expect(usage).toContain("where('organizerUid', '==', organizerUid)")
  })

  it('a malformed eventId still cannot become a 500', () => {
    const fn = SCOPE.slice(SCOPE.indexOf('export async function resolveIdentifierScope'))
    expect(fn.indexOf('try {')).toBeLessThan(fn.indexOf('adminDb.doc('))
  })

  it('the pure layer cannot read or write anything', () => {
    expect(STATS).not.toContain('adminDb')
    expect(STATS).not.toContain('firebase')
    expect(STATS).not.toContain('fetch(')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 12 — LEGACY COMPATIBILITY
// ════════════════════════════════════════════════════════════════════════════

describe('12 — every stored configuration shape still produces a read model', () => {
  const cases: Array<[string, IdentifierPool]> = [
    ['old scalar rangeStart/rangeEnd', { poolId: 'p', label: 'P', rangeStart: 1, rangeEnd: 100 }],
    ['new ranges[]',                   { poolId: 'p', label: 'P', ranges: [{ start: 1, end: 100 }] }],
    ['old matchRule.by = pass',        { poolId: 'p', label: 'P', matchRule: { by: 'pass', values: ['x'] } }],
    ['new passIds[]',                  { poolId: 'p', label: 'P', passIds: ['x'] }],
    ['category pool',                  { poolId: 'p', label: 'P', matchRule: { by: 'category', values: ['elite'] } }],
    ['default pool',                   { poolId: DEFAULT_POOL_ID, label: 'Default' }],
    ['unlimited pool',                 { poolId: 'p', label: 'P' }],
    ['half-bounded legacy pool',       { poolId: 'p', label: 'P', rangeStart: 500 }],
  ]

  for (const [name, pool] of cases) {
    it(`${name} summarizes without throwing`, () => {
      const s = summarizePool(pool, cfg([pool]), counts({ assigned: 1 }), ctxWith([{ id: 'x', name: 'X' }]))
      expect(s.poolId).toBe(pool.poolId)
      expect(s.assigned).toBe(1)
      expect(Number.isNaN(s.capacity as number)).toBe(false)
    })
  }

  it('a legacy matchRule pool is not mistaken for an orphan (it declares no passIds)', () => {
    const pool: IdentifierPool = { poolId: 'p', label: 'P', matchRule: { by: 'pass', values: ['ghost'] } }
    const s = summarizePool(pool, cfg([pool]), counts(), ctxWith([{ id: 'alive', name: 'A' }]))
    expect(s.state).not.toBe('orphaned')
    expect(s.matchRuleBy).toBe('pass')
  })

  it('an event with NO stored config still yields a model', () => {
    const d = defaultIdentifierConfig('evt')
    const m = buildIdentifierReadModel({
      eventSlug: 'evt', config: d, configured: false,
      usage: usageOf({ [DEFAULT_POOL_ID]: counts() }), ctx: CTX,
    })
    expect(m.configured).toBe(false)
    expect(m.pools).toHaveLength(1)
    expect(m.pools[0].capacityKind).toBe('unlimited')
    expect(m.summary.configuredCapacity).toBeNull()
  })

  it('an event with NO pools has a summary rather than a crash', () => {
    const m = buildIdentifierReadModel({
      eventSlug: 'evt', config: cfg([]), configured: true, usage: usageOf({}), ctx: CTX,
    })
    expect(m.pools).toEqual([])
    expect(m.summary.poolsTotal).toBe(0)
    expect(m.passScopes).toEqual([])
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 13 — EVENT-TYPE MATRIX (mandatory)
// ════════════════════════════════════════════════════════════════════════════

const CATEGORY_FIXTURES: Array<{
  category: string; label: string
  pools: IdentifierPool[]
  passes: Array<{ id: string; name: string }>
  expect: { capacity: number | null; scopes: number }
}> = [
  {
    category: 'Conference', label: 'Delegate ID',
    pools: [
      { poolId: 'vip', label: 'VIP', passIds: ['p-vip'], ranges: [{ start: 1, end: 500 }] },
      { poolId: 'gen', label: 'General', passIds: ['p-gen'], ranges: [{ start: 501, end: 2000 }] },
    ],
    passes: [{ id: 'p-vip', name: 'VIP' }, { id: 'p-gen', name: 'General' }],
    expect: { capacity: 2000, scopes: 2 },
  },
  {
    category: 'Exhibition & Expo', label: 'Visitor ID',
    pools: [
      { poolId: 'vis', label: 'Visitors', passIds: ['p-vis'], ranges: [{ start: 1, end: 5000 }] },
      { poolId: 'exh', label: 'Exhibitors', passIds: ['p-exh'], ranges: [{ start: 9000, end: 9499 }] },
    ],
    passes: [{ id: 'p-vis', name: 'Visitor' }, { id: 'p-exh', name: 'Exhibitor' }],
    expect: { capacity: 5500, scopes: 2 },
  },
  {
    category: 'Sports & Fitness', label: 'Bib Number',
    pools: [
      { poolId: 's', label: 'Short', passIds: ['p-s'], ranges: [{ start: 5001, end: 5999 }] },
      { poolId: 'm', label: 'Medium', passIds: ['p-m'], ranges: [{ start: 7000, end: 7500 }] },
      { poolId: 'l', label: 'Long', passIds: ['p-l'], ranges: [{ start: 8000, end: 8799 }] },
    ],
    passes: [{ id: 'p-s', name: 'Short' }, { id: 'p-m', name: 'Medium' }, { id: 'p-l', name: 'Long' }],
    expect: { capacity: 999 + 501 + 800, scopes: 3 },
  },
  {
    category: 'Workshop & Training', label: 'Participant ID',
    pools: [
      { poolId: 'b', label: 'Beginner', passIds: ['p-b'], ranges: [{ start: 1, end: 300 }] },
      { poolId: 'a', label: 'Advanced', passIds: ['p-a'], ranges: [{ start: 1001, end: 1300 }] },
    ],
    passes: [{ id: 'p-b', name: 'Beginner' }, { id: 'p-a', name: 'Advanced' }],
    expect: { capacity: 600, scopes: 2 },
  },
  {
    category: 'Business Meetup', label: 'Member ID',
    pools: [{ poolId: 'd', label: 'Delegates', passIds: ['p-d'], ranges: [{ start: 1, end: 500 }] }],
    passes: [{ id: 'p-d', name: 'Delegate' }],
    expect: { capacity: 500, scopes: 1 },
  },
  {
    category: 'Community & Awareness', label: 'Volunteer ID',
    pools: [{ poolId: 'v', label: 'Volunteers', passIds: ['p-v'], ranges: [{ start: 1, end: 300 }] }],
    passes: [{ id: 'p-v', name: 'Volunteer' }],
    expect: { capacity: 300, scopes: 1 },
  },
  {
    category: 'Cultural & Entertainment', label: 'Seat Number',
    pools: [
      { poolId: 'ga', label: 'General', passIds: ['p-ga'], ranges: [{ start: 1, end: 800 }] },
      { poolId: 'vip', label: 'VIP', passIds: ['p-vip'], ranges: [{ start: 900, end: 999 }] },
    ],
    passes: [{ id: 'p-ga', name: 'General' }, { id: 'p-vip', name: 'VIP' }],
    expect: { capacity: 900, scopes: 2 },
  },
  {
    category: 'Awards & Recognition', label: 'Nominee ID',
    pools: [{ poolId: 'n', label: 'Nominees', passIds: ['p-n'], ranges: [{ start: 1, end: 200 }] }],
    passes: [{ id: 'p-n', name: 'Nominee' }],
    expect: { capacity: 200, scopes: 1 },
  },
  {
    category: 'Fundraising & Charity', label: 'Supporter ID',
    // Deliberately UNLIMITED — a charity walk does not cap its supporters.
    pools: [{ poolId: 's', label: 'Supporters', passIds: ['p-s'] }],
    passes: [{ id: 'p-s', name: 'Supporter' }],
    expect: { capacity: null, scopes: 1 },
  },
  {
    category: 'Custom Event', label: 'Access Code',
    pools: [
      { poolId: 't1', label: 'Tier one', passIds: ['p-1'], ranges: [{ start: 1, end: 50 }, { start: 200, end: 250 }] },
      { poolId: 't2', label: 'Tier two', passIds: ['p-2'], ranges: [{ start: 500, end: 600 }] },
    ],
    passes: [{ id: 'p-1', name: 'Tier one' }, { id: 'p-2', name: 'Tier two' }],
    expect: { capacity: 50 + 51 + 101, scopes: 2 },
  },
]

describe('13 — the read model serves every event category identically', () => {
  for (const fx of CATEGORY_FIXTURES) {
    describe(fx.category, () => {
      const config = cfg(fx.pools, { label: fx.label })
      const ctx = ctxWith(fx.passes)
      const usage = usageOf(
        Object.fromEntries(fx.pools.map(p => [p.poolId, counts({ assigned: 1 })])),
        { eligible: 10, reusable: 0, legacyLocks: 0 },
      )
      const model = buildIdentifierReadModel({
        eventSlug: 'evt', config, configured: true, usage, ctx,
      })

      it('capacity is the sum of its configured ranges', () => {
        expect(model.summary.configuredCapacity).toBe(fx.expect.capacity)
      })

      it('every pass gets its own scope', () => {
        expect(model.passScopes.filter(s => s.passId !== null)).toHaveLength(fx.expect.scopes)
      })

      it('the identifier label is carried, never assumed', () => {
        expect(model.label).toBe(fx.label)
        for (const p of model.pools) expect(p.identifierLabel).toBe(fx.label)
      })

      it('utilization is a real ratio, or null when unlimited', () => {
        if (fx.expect.capacity === null) expect(model.summary.utilization).toBeNull()
        else expect(model.summary.utilization).toBeCloseTo(fx.pools.length / fx.expect.capacity)
      })

      it('no pool is orphaned when its pass exists', () => {
        expect(model.summary.poolsOrphaned).toBe(0)
      })

      it('an empty configuration of this shape reports zero used, not unknown', () => {
        const empty = buildIdentifierReadModel({
          eventSlug: 'evt', config, configured: true,
          usage: usageOf(Object.fromEntries(fx.pools.map(p => [p.poolId, counts()]))), ctx,
        })
        expect(empty.summary.assigned).toBe(0)
        expect(empty.summary.assigned).not.toBeNull()
      })
    })
  }

  it('all ten categories are covered', () => expect(CATEGORY_FIXTURES).toHaveLength(10))

  it('no statistics logic names a sport', () => {
    for (const [name, src] of [['statistics.ts', STATS], ['config.ts', CONFIG]] as const) {
      for (const word of [/\brunner/i, /\bmarathon/i, /\bfinisher/i, /\brace\b/i, /\blane\b/i]) {
        expect(src, name).not.toMatch(word)
      }
    }
  })

  it('no statistics branch keys off an event category', () => {
    expect(STATS).not.toContain('eventCategory')
    expect(STATS).not.toContain('eventType')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 14 — COUNTER FAILURE MATRIX (mandatory)
// ════════════════════════════════════════════════════════════════════════════

describe('14 — every combination of unreadable counters stays honest', () => {
  const pool: IdentifierPool = { poolId: 'p', label: 'P', ranges: [{ start: 1, end: 100 }] }
  const config = cfg([pool])
  const sum = (c: PoolStateCounts) => summarizePool(pool, config, c, CTX)

  it('assigned unavailable, capacity known → no total, no percentage', () => {
    const s = sum(counts({ assigned: null }))
    expect(s.capacity).toBe(100)
    expect(s.assigned).toBeNull()
    expect(s.occupied).toBeNull()
    expect(s.utilization).toBeNull()
    expect(s.available).toBeNull()
    expect(s.state).toBe('unavailable')
  })

  it('capacity unavailable, assigned known → the count survives, the ratio does not', () => {
    const open: IdentifierPool = { poolId: 'p', label: 'P' }
    const s = summarizePool(open, cfg([open]), counts({ assigned: 42 }), CTX)
    expect(s.assigned).toBe(42)
    expect(s.capacity).toBeNull()
    expect(s.utilization).toBeNull()
  })

  it('both unavailable → nothing is invented', () => {
    const open: IdentifierPool = { poolId: 'p', label: 'P' }
    const s = summarizePool(open, cfg([open]), EMPTY_COUNTS, CTX)
    expect(s.assigned).toBeNull()
    expect(s.capacity).toBeNull()
    expect(s.utilization).toBeNull()
    expect(s.state).toBe('unavailable')
  })

  it('ONE bad pool among healthy ones does not erase the healthy ones', () => {
    const many: IdentifierPool[] = [
      { poolId: 'ok1', label: 'Ok1', ranges: [{ start: 1, end: 10 }] },
      { poolId: 'bad', label: 'Bad', ranges: [{ start: 20, end: 29 }] },
      { poolId: 'ok2', label: 'Ok2', ranges: [{ start: 40, end: 49 }] },
    ]
    const c = cfg(many)
    const stats = [
      summarizePool(many[0], c, counts({ assigned: 3 }), CTX),
      summarizePool(many[1], c, EMPTY_COUNTS, CTX),
      summarizePool(many[2], c, counts({ assigned: 5 }), CTX),
    ]
    expect(stats[0].assigned).toBe(3)
    expect(stats[0].utilization).toBeCloseTo(0.3)
    expect(stats[2].assigned).toBe(5)
    expect(stats[1].state).toBe('unavailable')
    // Only the TOTAL is withheld.
    expect(summarizeIdentifiers(stats, null).assigned).toBeNull()
    expect(summarizeIdentifiers(stats, null).poolsUnavailable).toBe(1)
  })

  it('never 0, never 0%, never 100% for an unreadable pool', () => {
    const s = sum(EMPTY_COUNTS)
    expect(s.assigned).not.toBe(0)
    expect(s.utilization).not.toBe(0)
    expect(s.utilization).not.toBe(1)
  })

  it('a reusable count that failed is null rather than "nothing to reuse"', () => {
    expect(summarizeIdentifiers([sum(counts())], null).reusable).toBeNull()
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 15 — RANGE / COUNTER CONSISTENCY (mandatory)
// ════════════════════════════════════════════════════════════════════════════

describe('15 — assigned versus capacity, at every boundary', () => {
  const pool: IdentifierPool = { poolId: 'p', label: 'P', ranges: [{ start: 1, end: 100 }] }
  const at = (assigned: number) => summarizePool(pool, cfg([pool]), counts({ assigned }), CTX)

  it('100 capacity / 0 assigned', () => {
    expect(at(0)).toMatchObject({ state: 'empty', available: 100, utilization: 0 })
  })
  it('100 capacity / 50 assigned', () => {
    expect(at(50)).toMatchObject({ state: 'available', available: 50, utilization: 0.5 })
  })
  it('100 capacity / 100 assigned', () => {
    expect(at(100)).toMatchObject({ state: 'exhausted', available: 0, utilization: 1 })
  })
  it('100 capacity / 120 assigned is INCONSISTENT and is NOT clamped to 100', () => {
    const s = at(120)
    expect(s.state).toBe('inconsistent')
    expect(s.assigned).toBe(120)
    expect(s.utilization).toBeCloseTo(1.2)
    expect(s.utilization).not.toBe(1)
    expect(s.available).toBeNull()
    expect(s.stateReason).toMatch(/120.*100|100.*120/)
  })
  it('exhausted and inconsistent are different facts', () => {
    expect(at(100).state).not.toBe(at(120).state)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 16 — RANGE-CHANGE SAFETY reuses the 19A helper
// ════════════════════════════════════════════════════════════════════════════

describe('16 — stranded assignments are 19A\'s helper, not a second implementation', () => {
  it('the read model does not re-implement stranding', () => {
    expect(STATS).not.toContain('function strandedByRanges')
  })

  it('the pure helper still answers the question', async () => {
    const { strandedByRanges } = await import('@/lib/identifiers/ranges')
    expect(strandedByRanges([{ start: 6000, end: 7000 }], [5500])).toEqual([5500])
  })

  it('no read path performs a scan to find stranded values', () => {
    expect(CONFIG).not.toContain('strandedByRanges')
  })
})
