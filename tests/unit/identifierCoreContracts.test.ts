// RD-EVENT-19A — Identifier Core Contracts.
//
// THE RULE. An event issues identifiers. Which identifier a person gets is
// decided by their PASS, by the numeric RANGES the organizer configured for that
// pass, and by nothing else. The engine must not know what a "5 KM" is, what a
// "Delegate" is, or what a bib is — those are labels an organizer typed.
//
// What is pinned here, and why each matters:
//   1. PASS → POOL — the link existed in the type model and was never wired, so
//      a 10 KM participant could be handed a 5 KM number. That is unrecoverable
//      once printed.
//   2. RANGES — a number in a gap between two configured ranges must never be
//      issued. Nobody printed it.
//   3. NORMALIZATION — the value IS the lock's identity, so " 5001" and "5001"
//      must be one identifier, not two.
//   4. NUMERIC EXTRACTION — "B5001" has a number in it; "RUN-2026-001" has three
//      and no rule saying which. The first must be extracted, the second refused.
//   5. ELIGIBILITY — two different rules for "who may hold one" exist in
//      production. Both are stated; neither is silently replaced.
//   6. EVENT-TYPE NEUTRALITY — the same mechanism, unchanged, for all ten
//      categories.
//
// Source-level assertions are used where the property is structural (which
// function is called, which value is forwarded). They are comment-stripped so
// prose ABOUT the code can never satisfy them.

import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// config.ts reaches Firestore at call time only; nothing under test does I/O.
vi.mock('@/lib/firebase/admin', () => ({ adminDb: {} }))

import {
  configuredRanges, effectiveRanges, hasSupersededLegacyRange, isInRanges,
  nextNumberInRanges, rangeCapacity, rangesOverlap, firstOverlap, validateRanges,
  strandedByRanges,
} from '@/lib/identifiers/ranges'
import {
  normalizeIdentifierValue, validateIdentifierValue, numericOf, effectiveFormat,
  formatIdentifier, MAX_VALUE_LENGTH,
} from '@/lib/identifiers/format'
import {
  identifierEligibility, identifierAssignmentBlockedBy, identifierRosterVisible,
  poolAcceptsPass, ENGINE_TERMINAL_STATUSES, ROSTER_STATUSES,
} from '@/lib/identifiers/eligibility'
import { resolvePool, defaultIdentifierConfig, DEFAULT_POOL_ID } from '@/lib/identifiers/config'
import { IdentifierConfigError, IdentifierError } from '@/lib/identifiers/types'
import type { IdentifierConfig, IdentifierPool } from '@/lib/identifiers/types'

// ─── Source helpers ─────────────────────────────────────────────────────────

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
/** Strips comments so an assertion cannot be satisfied by a comment. */
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

const ENGINE   = code(read('lib/identifiers/engine.ts'))
const CONFIG   = code(read('lib/identifiers/config.ts'))
const RANGES   = code(read('lib/identifiers/ranges.ts'))
const FORMAT   = code(read('lib/identifiers/format.ts'))
const ELIGIBLE = code(read('lib/identifiers/eligibility.ts'))
const TYPES    = code(read('lib/identifiers/types.ts'))
const SCOPE    = code(read('lib/identifiers/organizerScope.ts'))
const SCAN     = code(read('app/api/checkin/scan/route.ts'))
const WALKIN   = code(read('app/api/checkin/walkin/route.ts'))
const POOLS_RT = code(read('app/api/organizer/events/[eventId]/identifiers/pools/route.ts'))
const IDS_RT   = code(read('app/api/organizer/events/[eventId]/identifiers/route.ts'))
const BULK_RT  = code(read('app/api/organizer/events/[eventId]/identifiers/bulk/route.ts'))

// ─── Config fixtures ────────────────────────────────────────────────────────

/** A config with the given pools; everything else is the platform default. */
function withPools(pools: IdentifierPool[], defaultPoolId = DEFAULT_POOL_ID): IdentifierConfig {
  return { ...defaultIdentifierConfig('evt'), pools, defaultPoolId }
}

const DEFAULT_POOL: IdentifierPool = { poolId: DEFAULT_POOL_ID, label: 'Default' }

// ════════════════════════════════════════════════════════════════════════════
// 1 — PASS RESOLUTION
// ════════════════════════════════════════════════════════════════════════════

describe('1 — a registration is routed to its pass\'s own pool', () => {
  const passPools = withPools([
    DEFAULT_POOL,
    { poolId: 'p-a', label: 'Pass A', passIds: ['pass-a'], ranges: [{ start: 5001, end: 6500 }] },
    { poolId: 'p-b', label: 'Pass B', passIds: ['pass-b'], ranges: [{ start: 7000, end: 7499 }] },
    { poolId: 'p-c', label: 'Pass C', passIds: ['pass-c'], ranges: [{ start: 8000, end: 8799 }] },
  ])

  it('A · a matching pass selects that pass\'s pool', () => {
    expect(resolvePool(passPools, undefined, { passId: 'pass-a' }).poolId).toBe('p-a')
  })

  it('B · a different pass never selects it', () => {
    const pool = resolvePool(passPools, undefined, { passId: 'pass-b' })
    expect(pool.poolId).not.toBe('p-a')
    expect(pool.poolId).toBe('p-b')
  })

  it('C · with several pass pools each one resolves deterministically', () => {
    for (const [passId, poolId] of [['pass-a', 'p-a'], ['pass-b', 'p-b'], ['pass-c', 'p-c']] as const) {
      // Repeated to prove the answer is not order- or iteration-dependent.
      for (let i = 0; i < 3; i++) {
        expect(resolvePool(passPools, undefined, { passId }).poolId).toBe(poolId)
      }
    }
  })

  // RD-BIB-01 · D and E are INVERTED here, and the inversion is the fix.
  //
  // Both used to assert "falls back to the default pool", and the audit observed what
  // that meant in practice: a registration whose pass has no range — or no pass at
  // all — was quietly issued a number out of the default pool's block. On a
  // freshly-defaulted config that pool is unbounded, so the number was 1.
  //
  // On an event that maps numbers to passes this is now refused. The old permissive
  // answer survives, unchanged, for events that never opted into pass scoping —
  // asserted below and in the backward-compatibility block further down.
  it('D · no passId on a PASS-SCOPED event is refused, not defaulted', () => {
    expect(() => resolvePool(passPools, undefined, {})).toThrow(/issues participant numbers per pass/)
    expect(() => resolvePool(passPools, undefined, { passId: null })).toThrow(IdentifierError)
  })

  it('E · an UNKNOWN pass is refused, and never lands in another pass\'s pool', () => {
    expect(() => resolvePool(passPools, undefined, { passId: 'pass-that-does-not-exist' }))
      .toThrow(/no participant-number range configured/)
  })

  it('E2 · a LEGACY event with no pass scoping still resolves to its default pool', () => {
    const legacy = withPools([DEFAULT_POOL])
    expect(resolvePool(legacy, undefined, {}).poolId).toBe(DEFAULT_POOL_ID)
    expect(resolvePool(legacy, undefined, { passId: 'anything' }).poolId).toBe(DEFAULT_POOL_ID)
  })

  it('an explicit poolId still outranks the pass', () => {
    expect(resolvePool(passPools, 'p-c', { passId: 'pass-a' }).poolId).toBe('p-c')
  })

  it('an explicit poolId naming no pool falls through rather than throwing', () => {
    expect(resolvePool(passPools, 'no-such-pool', { passId: 'pass-a' }).poolId).toBe('p-a')
  })

  it('the legacy matchRule.by = "pass" is still honoured', () => {
    const legacy = withPools([
      DEFAULT_POOL,
      { poolId: 'legacy', label: 'Legacy', matchRule: { by: 'pass', values: ['pass-x'] } },
    ])
    expect(resolvePool(legacy, undefined, { passId: 'pass-x' }).poolId).toBe('legacy')
  })

  it('passIds outranks a legacy pass matchRule when both would match', () => {
    const both = withPools([
      DEFAULT_POOL,
      { poolId: 'rule', label: 'Rule', matchRule: { by: 'pass', values: ['pass-x'] } },
      { poolId: 'first-class', label: 'First class', passIds: ['pass-x'] },
    ])
    expect(resolvePool(both, undefined, { passId: 'pass-x' }).poolId).toBe('first-class')
  })

  it('a pass pool outranks a category pool when both match', () => {
    const mixed = withPools([
      DEFAULT_POOL,
      { poolId: 'by-cat',  label: 'By category', matchRule: { by: 'category', values: ['elite'] } },
      { poolId: 'by-pass', label: 'By pass',     passIds: ['pass-a'] },
    ])
    expect(resolvePool(mixed, undefined, { passId: 'pass-a', category: 'elite' }).poolId).toBe('by-pass')
  })

  it('BACKWARD COMPATIBILITY · without a passId the category rule still wins, exactly as before', () => {
    const mixed = withPools([
      DEFAULT_POOL,
      { poolId: 'by-cat',  label: 'By category', matchRule: { by: 'category', values: ['elite'] } },
      { poolId: 'by-pass', label: 'By pass',     passIds: ['pass-a'] },
    ])
    expect(resolvePool(mixed, undefined, { category: 'elite' }).poolId).toBe('by-cat')
  })

  it('registration_type rules are untouched', () => {
    const cfg = withPools([
      DEFAULT_POOL,
      { poolId: 'vol', label: 'Volunteers', matchRule: { by: 'registration_type', values: ['volunteer'] } },
    ])
    expect(resolvePool(cfg, undefined, { registrationType: 'volunteer' }).poolId).toBe('vol')
  })

  it('an EMPTY passIds is not a wildcard — it matches nothing', () => {
    const cfg = withPools([DEFAULT_POOL, { poolId: 'empty', label: 'Empty', passIds: [] }])
    expect(resolvePool(cfg, undefined, { passId: 'anything' }).poolId).toBe(DEFAULT_POOL_ID)
  })

  it('a config with no pools at all still yields a usable default pool', () => {
    const cfg = { ...defaultIdentifierConfig('evt'), pools: [] as IdentifierPool[] }
    expect(resolvePool(cfg, undefined, { passId: 'x' }).poolId).toBe(DEFAULT_POOL_ID)
  })
})

describe('1b — poolAcceptsPass is the single membership rule', () => {
  it('matches a listed pass', () => expect(poolAcceptsPass({ passIds: ['a'] }, 'a')).toBe(true))
  it('refuses an unlisted pass', () => expect(poolAcceptsPass({ passIds: ['a'] }, 'b')).toBe(false))
  it('refuses when the list is empty', () => expect(poolAcceptsPass({ passIds: [] }, 'a')).toBe(false))
  it('refuses when there is no list', () => expect(poolAcceptsPass({}, 'a')).toBe(false))
  it('refuses a null pass', () => expect(poolAcceptsPass({ passIds: ['a'] }, null)).toBe(false))
  it('refuses an empty-string pass', () => expect(poolAcceptsPass({ passIds: [''] }, '')).toBe(false))
})

// ════════════════════════════════════════════════════════════════════════════
// 2 — RANGES
// ════════════════════════════════════════════════════════════════════════════

describe('2 — ranges decide which numbers exist', () => {
  const TWO = [{ start: 5001, end: 5999 }, { start: 7000, end: 7500 }]

  it('a single range walks normally', () => {
    expect(nextNumberInRanges([{ start: 5001, end: 6500 }], 5001)).toBe(5001)
    expect(nextNumberInRanges([{ start: 5001, end: 6500 }], 5002)).toBe(5002)
  })

  it('the number after the first range JUMPS the gap, it does not enter it', () => {
    expect(nextNumberInRanges(TWO, 5999)).toBe(5999)
    expect(nextNumberInRanges(TWO, 6000)).toBe(7000)
    expect(nextNumberInRanges(TWO, 6500)).toBe(7000)
    expect(nextNumberInRanges(TWO, 6999)).toBe(7000)
  })

  it('no number inside a gap is ever issued', () => {
    for (let n = 6000; n <= 6999; n++) {
      const next = nextNumberInRanges(TWO, n)
      expect(next).toBe(7000)
      expect(isInRanges(TWO, next as number)).toBe(true)
    }
  })

  it('a counter below the first range is lifted to its start', () => {
    expect(nextNumberInRanges(TWO, 1)).toBe(5001)
  })

  it('exhaustion happens only after EVERY range is spent', () => {
    expect(nextNumberInRanges(TWO, 7500)).toBe(7500)
    expect(nextNumberInRanges(TWO, 7501)).toBeNull()
  })

  it('unsorted ranges still walk in ascending order', () => {
    const messy = [{ start: 7000, end: 7500 }, { start: 5001, end: 5999 }]
    expect(nextNumberInRanges(messy, 1)).toBe(5001)
    expect(nextNumberInRanges(messy, 6000)).toBe(7000)
  })

  it('no ranges means unbounded — the number passes straight through', () => {
    expect(nextNumberInRanges([], 42)).toBe(42)
  })

  it('capacity counts inclusive bounds across every range', () => {
    expect(rangeCapacity([{ start: 5001, end: 6500 }])).toBe(1500)
    expect(rangeCapacity(TWO)).toBe(999 + 501)
    expect(rangeCapacity([{ start: 7, end: 7 }])).toBe(1)
    expect(rangeCapacity([])).toBe(0)
  })

  it('membership is inclusive at both ends', () => {
    expect(isInRanges(TWO, 5001)).toBe(true)
    expect(isInRanges(TWO, 5999)).toBe(true)
    expect(isInRanges(TWO, 6000)).toBe(false)
    expect(isInRanges(TWO, 7500)).toBe(true)
    expect(isInRanges(TWO, 7501)).toBe(false)
  })
})

describe('2b — overlap vs adjacency', () => {
  it('5001-5999 and 6000-6999 are ADJACENT, which is legal', () => {
    expect(rangesOverlap({ start: 5001, end: 5999 }, { start: 6000, end: 6999 })).toBe(false)
    expect(() => validateRanges([{ start: 5001, end: 5999 }, { start: 6000, end: 6999 }], 'p')).not.toThrow()
  })

  it('5001-6500 and 6000-7000 OVERLAP, which is not', () => {
    expect(rangesOverlap({ start: 5001, end: 6500 }, { start: 6000, end: 7000 })).toBe(true)
    expect(() => validateRanges([{ start: 5001, end: 6500 }, { start: 6000, end: 7000 }], 'p'))
      .toThrow(IdentifierConfigError)
  })

  it('a range fully containing another overlaps', () => {
    expect(rangesOverlap({ start: 1, end: 100 }, { start: 40, end: 50 })).toBe(true)
  })

  it('touching at a single number overlaps', () => {
    expect(rangesOverlap({ start: 1, end: 10 }, { start: 10, end: 20 })).toBe(true)
  })

  it('firstOverlap reports the offending pair', () => {
    const clash = firstOverlap([{ start: 1, end: 10 }, { start: 5, end: 8 }])
    expect(clash).not.toBeNull()
    expect(clash![0].start).toBe(1)
  })

  it('firstOverlap is null for a clean set', () => {
    expect(firstOverlap([{ start: 1, end: 10 }, { start: 11, end: 20 }])).toBeNull()
  })
})

describe('2c — range validation refuses what cannot be allocated', () => {
  const bad = (raw: unknown) => () => validateRanges(raw, 'p-a')

  it('rejects a non-list', () => expect(bad({ start: 1, end: 2 })).toThrow(IdentifierConfigError))
  it('rejects an empty list rather than treating it as unbounded', () =>
    expect(bad([])).toThrow(/empty list/))
  it('rejects an entry that is not a pair', () => expect(bad(['5001-6500'])).toThrow(IdentifierConfigError))
  it('rejects start > end', () => expect(bad([{ start: 6500, end: 5001 }])).toThrow(/starts after it ends/))
  it('rejects a non-integer', () => expect(bad([{ start: 5001.5, end: 6500 }])).toThrow(/whole numbers/))
  it('rejects NaN', () => expect(bad([{ start: NaN, end: 6500 }])).toThrow(/whole numbers/))
  it('rejects Infinity', () => expect(bad([{ start: 1, end: Infinity }])).toThrow(/whole numbers/))
  it('rejects a negative bound', () => expect(bad([{ start: -1, end: 10 }])).toThrow(/whole numbers/))
  it('rejects a missing bound', () => expect(bad([{ start: 1 }])).toThrow(/whole numbers/))
  it('rejects a string bound', () => expect(bad([{ start: '1', end: '10' }])).toThrow(/whole numbers/))
  it('rejects a duplicate range', () =>
    expect(bad([{ start: 1, end: 10 }, { start: 1, end: 10 }])).toThrow(/twice/))
  it('rejects overlapping ranges', () =>
    expect(bad([{ start: 1, end: 10 }, { start: 5, end: 20 }])).toThrow(/overlap/))
  it('accepts a valid list and returns it ascending', () => {
    expect(validateRanges([{ start: 7000, end: 7500 }, { start: 5001, end: 5999 }], 'p'))
      .toEqual([{ start: 5001, end: 5999 }, { start: 7000, end: 7500 }])
  })
  it('accepts null as "no ranges configured"', () => expect(validateRanges(null, 'p')).toEqual([]))
  it('imposes NO maximum range size — the platform has no such existing limit', () => {
    expect(() => validateRanges([{ start: 0, end: 9_999_999 }], 'p')).not.toThrow()
  })
})

describe('2d — legacy range compatibility', () => {
  it('A · a pool with only rangeStart/rangeEnd still reports its range', () => {
    expect(effectiveRanges({ rangeStart: 5001, rangeEnd: 6500 }))
      .toEqual([{ start: 5001, end: 6500 }])
  })

  it('A · but declares NO configured ranges, so the allocator keeps its legacy path', () => {
    expect(configuredRanges({ rangeStart: 5001, rangeEnd: 6500 })).toEqual([])
  })

  it('B · a pool with ranges[] reports them', () => {
    const pool = { ranges: [{ start: 1, end: 5 }, { start: 10, end: 20 }] }
    expect(configuredRanges(pool)).toHaveLength(2)
    expect(effectiveRanges(pool)).toEqual(configuredRanges(pool))
  })

  it('PRECEDENCE · ranges[] wins outright and the legacy pair is IGNORED, never merged', () => {
    const both = { ranges: [{ start: 100, end: 200 }], rangeStart: 5001, rangeEnd: 6500 }
    expect(effectiveRanges(both)).toEqual([{ start: 100, end: 200 }])
    // The merged span 100–6500 would be a range nobody configured.
    expect(effectiveRanges(both)).not.toEqual([{ start: 100, end: 6500 }])
    expect(hasSupersededLegacyRange(both)).toBe(true)
  })

  it('a half-bounded legacy pool has no closed range', () => {
    expect(effectiveRanges({ rangeStart: 5001 })).toEqual([])
    expect(effectiveRanges({ rangeEnd: 6500 })).toEqual([])
  })

  it('an unbounded pool has no ranges', () => {
    expect(effectiveRanges({})).toEqual([])
    expect(effectiveRanges(null)).toEqual([])
  })

  it('a malformed STORED range is dropped on read, not thrown', () => {
    const pool = { ranges: [{ start: 5, end: 1 }, { start: 10, end: 20 }] } as never
    expect(configuredRanges(pool)).toEqual([{ start: 10, end: 20 }])
  })
})

describe('2e — range editing cannot silently strand an assigned identifier', () => {
  it('reports 5500 as stranded when the range moves to 6000-7000', () => {
    expect(strandedByRanges([{ start: 6000, end: 7000 }], [5500, 6100])).toEqual([5500])
  })

  it('reports nothing when every assigned number still fits', () => {
    expect(strandedByRanges([{ start: 5000, end: 7000 }], [5500, 6100])).toEqual([])
  })

  it('an unbounded proposal strands nothing', () => {
    expect(strandedByRanges([], [5500])).toEqual([])
  })

  it('ignores identifiers with no numeric component', () => {
    expect(strandedByRanges([{ start: 6000, end: 7000 }], [null, undefined, 5500])).toEqual([5500])
  })

  it('de-duplicates and sorts', () => {
    expect(strandedByRanges([{ start: 100, end: 200 }], [9, 5, 9])).toEqual([5, 9])
  })

  it('is read-only by construction — it returns numbers and holds no writer', () => {
    expect(RANGES).not.toContain('adminDb')
    expect(RANGES).not.toContain('firebase')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 3 — NORMALIZATION
// ════════════════════════════════════════════════════════════════════════════

describe('3 — one value means one identifier', () => {
  it('trims surrounding whitespace', () => {
    expect(normalizeIdentifierValue(' 5001 ')).toBe('5001')
    expect(normalizeIdentifierValue('\t5001\n')).toBe('5001')
  })

  it('preserves case by default, so no existing event changes meaning', () => {
    expect(normalizeIdentifierValue('del-0001')).toBe('del-0001')
    expect(normalizeIdentifierValue('DEL-0001')).toBe('DEL-0001')
  })

  it('folds case when the event configured it', () => {
    expect(normalizeIdentifierValue('del-0001', 'upper')).toBe('DEL-0001')
    expect(normalizeIdentifierValue('DEL-0001', 'lower')).toBe('del-0001')
  })

  it('keeps hyphens — "DEL-0001" is the identifier, not "DEL0001"', () => {
    expect(normalizeIdentifierValue('DEL-0001')).toBe('DEL-0001')
  })

  it('keeps INTERNAL spacing — a Seat Number legitimately contains one', () => {
    expect(normalizeIdentifierValue('  SEAT A 12  ')).toBe('SEAT A 12')
  })

  it('never turns an identifier into a number', () => {
    expect(normalizeIdentifierValue('0042')).toBe('0042')
  })

  it('a non-string is not coerced into text', () => {
    expect(normalizeIdentifierValue(5001)).toBe('')
    expect(normalizeIdentifierValue(null)).toBe('')
    expect(normalizeIdentifierValue(undefined)).toBe('')
  })
})

describe('3b — a value must be usable before a lock exists', () => {
  it('rejects an empty value', () => {
    expect(validateIdentifierValue('')).toEqual({ ok: false, reason: 'EMPTY', value: '' })
  })

  it('rejects whitespace-only', () => {
    expect(validateIdentifierValue('    ').ok).toBe(false)
  })

  it('accepts a normal value', () => {
    expect(validateIdentifierValue(' B5001 ')).toEqual({ ok: true, value: 'B5001' })
  })

  it('accepts exactly the maximum length', () => {
    expect(validateIdentifierValue('A'.repeat(MAX_VALUE_LENGTH)).ok).toBe(true)
  })

  it('rejects one character over', () => {
    const r = validateIdentifierValue('A'.repeat(MAX_VALUE_LENGTH + 1))
    expect(r.ok).toBe(false)
    expect(r).toMatchObject({ reason: 'TOO_LONG' })
  })

  it('measures unicode by code points, the way a person counts', () => {
    // 64 astral code points = 128 UTF-16 units. Counting units would reject a
    // value that is, to the organizer, exactly at the limit.
    expect(validateIdentifierValue('🏅'.repeat(MAX_VALUE_LENGTH)).ok).toBe(true)
    expect(validateIdentifierValue('🏅'.repeat(MAX_VALUE_LENGTH + 1)).ok).toBe(false)
  })

  it('accepts non-latin scripts', () => {
    expect(validateIdentifierValue('प्रतिभागी-०१')).toMatchObject({ ok: true })
  })

  it('accepts a prefixed value with spaces around it', () => {
    expect(validateIdentifierValue('  EXH-0042  ')).toEqual({ ok: true, value: 'EXH-0042' })
  })

  it('the limit is declared once and routes do not re-declare their own', () => {
    expect(FORMAT).toContain('export const MAX_VALUE_LENGTH')
    for (const src of [IDS_RT, BULK_RT, POOLS_RT]) {
      expect(src).not.toMatch(/MAX_VALUE_LENGTH\s*=/)
    }
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 4 — NUMERIC EXTRACTION
// ════════════════════════════════════════════════════════════════════════════

describe('4 — a value gives up its number only when the format says which one', () => {
  it('pure numeric', () => expect(numericOf('5001')).toBe(5001))
  it('leading zeros', () => expect(numericOf('0042')).toBe(42))

  it('a known prefix', () => expect(numericOf('B5001', { prefix: 'B' })).toBe(5001))
  it('a known prefix with a hyphen', () => expect(numericOf('DEL-0001', { prefix: 'DEL-' })).toBe(1))
  it('a single-letter hyphenated prefix', () => expect(numericOf('A-001', { prefix: 'A-' })).toBe(1))
  it('a known suffix', () => expect(numericOf('0042-X', { suffix: '-X' })).toBe(42))
  it('a prefix AND a suffix', () =>
    expect(numericOf('EXH-0042-IN', { prefix: 'EXH-', suffix: '-IN' })).toBe(42))

  it('AMBIGUOUS · a pattern with several digit groups yields null, never a guess', () => {
    expect(numericOf('RUN-2026-001')).toBeNull()
    expect(numericOf('RUN-2026-001', { prefix: 'RUN-' })).toBeNull()
    expect(numericOf('RUN-2026-001', { prefix: 'RUN-2026-' })).toBe(1)  // …unless it says so
  })

  it('digits are never scavenged from the middle of a value', () => {
    expect(numericOf('VIP12MAA', { prefix: 'VIP' })).toBeNull()
  })

  it('a prefix the value does not carry falls back to the pure-numeric rule', () => {
    expect(numericOf('B5001', { prefix: 'X' })).toBeNull()
    expect(numericOf('5001',  { prefix: 'B' })).toBe(5001)
  })

  it('BACKWARD COMPATIBILITY · called with one argument it behaves exactly as before', () => {
    expect(numericOf('5001')).toBe(5001)
    expect(numericOf('B5001')).toBeNull()
    expect(numericOf('')).toBeNull()
    expect(numericOf('abc')).toBeNull()
  })

  it('refuses a number too large to be exact', () => {
    expect(numericOf('9'.repeat(30))).toBeNull()
  })

  it('the extracted number is range-comparable', () => {
    const n = numericOf('B5001', { prefix: 'B' })
    expect(isInRanges([{ start: 5001, end: 6500 }], n as number)).toBe(true)
    expect(isInRanges([{ start: 7000, end: 7500 }], n as number)).toBe(false)
  })

  it('the extracted numbers sort numerically, not lexically', () => {
    const values = ['B9', 'B10', 'B100', 'B2']
    const sorted = values
      .map(v => ({ v, n: numericOf(v, { prefix: 'B' }) as number }))
      .sort((a, b) => a.n - b.n)
      .map(x => x.v)
    expect(sorted).toEqual(['B2', 'B9', 'B10', 'B100'])
  })

  it('extraction round-trips what the formatter produced', () => {
    const fmt = effectiveFormat(
      { prefix: 'DEL-', suffix: '', padding: 4, startNumber: 1 },
      { poolId: 'p', label: 'P' },
    )
    for (const n of [1, 42, 9999]) {
      const value = formatIdentifier({ type: 'alphanumeric', format: fmt, n })
      expect(numericOf(value, { prefix: fmt.prefix, suffix: fmt.suffix })).toBe(n)
    }
  })

  it('formatting still lives only in format.ts', () => {
    expect(FORMAT).toContain('export function formatIdentifier')
    for (const src of [RANGES, ELIGIBLE, CONFIG]) {
      expect(src).not.toContain('padStart')
    }
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 5 — ELIGIBILITY
// ════════════════════════════════════════════════════════════════════════════

describe('5 — the two eligibility rules in force are both stated, neither guessed', () => {
  it('confirmed · assignable and on the roster', () => {
    expect(identifierEligibility({ status: 'confirmed' })).toEqual({
      assignable: true, blockedBy: null, rosterVisible: true, divergent: false, unknownStatus: false,
    })
  })

  it('pending · the engine allows it, the roster does not show it — DIVERGENT', () => {
    const e = identifierEligibility({ status: 'pending' })
    expect(e.assignable).toBe(true)
    expect(e.rosterVisible).toBe(false)
    expect(e.divergent).toBe(true)
    expect(e.blockedBy).toBe('NOT_ON_ROSTER')
  })

  it('waitlisted · same divergence', () => {
    expect(identifierEligibility({ status: 'waitlisted' })).toMatchObject({
      assignable: true, rosterVisible: false, divergent: true,
    })
  })

  it('cancelled · refused by both', () => {
    expect(identifierEligibility({ status: 'cancelled' })).toMatchObject({
      assignable: false, blockedBy: 'CANCELLED', rosterVisible: false, divergent: false,
    })
  })

  it('rejected · refused by both', () => {
    expect(identifierEligibility({ status: 'rejected' })).toMatchObject({
      assignable: false, blockedBy: 'REJECTED',
    })
  })

  it('an UNKNOWN status is reported as unknown, never silently treated as fine', () => {
    const e = identifierEligibility({ status: 'archived' })
    expect(e.unknownStatus).toBe(true)
    expect(e.blockedBy).toBe('UNKNOWN_STATUS')
    expect(e.rosterVisible).toBe(false)
  })

  it('a MISSING status is unknown too', () => {
    expect(identifierEligibility({}).unknownStatus).toBe(true)
    expect(identifierEligibility({ status: 42 }).unknownStatus).toBe(true)
  })

  it('PRESERVED · an unknown status keeps the engine\'s existing permissiveness', () => {
    // The engine refuses cancelled and rejected and nothing else. Failing closed
    // here would change who can be issued an identifier — a product decision,
    // deferred to RD-EVENT-19C and surfaced through unknownStatus meanwhile.
    expect(identifierAssignmentBlockedBy({ status: 'archived' })).toBeNull()
  })

  it('refunded payment does NOT block assignment — the engine never consulted it', () => {
    expect(identifierAssignmentBlockedBy({ status: 'confirmed', paymentStatus: 'refunded' })).toBeNull()
    expect(identifierEligibility({ status: 'confirmed', paymentStatus: 'refunded' }).assignable).toBe(true)
  })

  it('the two rules are named as data, so RD-EVENT-19C can reconcile them', () => {
    expect([...ENGINE_TERMINAL_STATUSES]).toEqual(['cancelled', 'rejected'])
    expect([...ROSTER_STATUSES]).toEqual(['confirmed'])
  })

  it('the roster rule matches what /bibs actually queries', () => {
    const BIBS = code(read('app/api/organizer/events/[eventId]/bibs/route.ts'))
    expect(BIBS).toContain(".where('status',       '==', 'confirmed')")
    expect(identifierRosterVisible({ status: 'confirmed' })).toBe(true)
  })

  it('the ENGINE consults this predicate instead of re-implementing the check', () => {
    expect(ENGINE).toContain('identifierAssignmentBlockedBy(reg)')
    // The old inline duplicate is gone.
    expect(ENGINE).not.toContain("status === 'cancelled' || status === 'rejected'")
  })

  it('the eligibility module is pure — it cannot read or write anything', () => {
    expect(ELIGIBLE).not.toContain('adminDb')
    expect(ELIGIBLE).not.toContain('firebase')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 6 — ENGINE WIRING (structural)
// ════════════════════════════════════════════════════════════════════════════

describe('6 — the pass reaches pool resolution, and costs nothing to get there', () => {
  it('AllocateInput carries an OPTIONAL passId', () => {
    expect(TYPES).toMatch(/passId\?:\s+string \| null/)
  })

  it('allocateIdentifier forwards it to resolvePool — the gap the audit found', () => {
    const call = ENGINE.slice(ENGINE.indexOf('resolvePool(config'), ENGINE.indexOf('const fmt'))
    expect(call).toContain('passId')
    expect(call).toContain('input.passId')
  })

  it('autoAssignIfEnabled no longer DROPS the passId it accepts', () => {
    const fn = ENGINE.slice(ENGINE.indexOf('export async function autoAssignIfEnabled'))
    const forward = fn.slice(fn.indexOf('return allocateIdentifier'))
    expect(forward).toContain('passId:')
  })

  it('the engine reads no pass document — the caller supplies the id it already holds', () => {
    expect(ENGINE).not.toContain("collection('passes')")
    expect(ENGINE).not.toContain('eventPasses')
  })

  it('allocation still reads only config, registration, lock, counter and legacy lock', () => {
    const alloc = ENGINE.slice(
      ENGINE.indexOf('export async function allocateIdentifier'),
      ENGINE.indexOf('export async function autoAssignIfEnabled'),
    )
    const reads = alloc.match(/txn\.get\(/g) ?? []
    // registration + (lock | counter+lock) + legacy bibLock + optional previous lock.
    expect(reads.length).toBeLessThanOrEqual(6)
    expect(alloc).not.toContain('.where(')       // no query inside allocation
  })

  it('the transaction model is untouched', () => {
    expect(ENGINE).toContain('adminDb.runTransaction')
    expect(ENGINE).toContain("collection('identifierLocks')")
    expect(ENGINE).toContain("collection('identifierCounters')")
    expect(ENGINE).toContain("collection('identifierHistory')")
  })

  it('the engine walks configured ranges instead of only rangeEnd', () => {
    expect(ENGINE).toContain('configuredRanges(pool)')
    expect(ENGINE).toContain('nextNumberInRanges(ranges, counterValue)')
    // …and the legacy scalar bound is still enforced for pools without ranges[].
    expect(ENGINE).toContain('pool.rangeEnd != null')
  })

  it('a manual value is normalized and bounded BEFORE any lock is touched', () => {
    const alloc = ENGINE.slice(
      ENGINE.indexOf('export async function allocateIdentifier'),
      ENGINE.indexOf('export async function autoAssignIfEnabled'),
    )
    expect(alloc.indexOf('validateIdentifierValue')).toBeGreaterThan(-1)
    expect(alloc.indexOf('validateIdentifierValue')).toBeLessThan(alloc.indexOf('runTransaction'))
  })

  it('value-addressed operations normalize too, so a reserved value is findable', () => {
    const fn = ENGINE.slice(ENGINE.indexOf('async function setValueState'))
    expect(fn).toContain('validateIdentifierValue')
  })

  it('the legacy registration mirrors are still written', () => {
    expect(ENGINE).toContain('bibNumber:')
    expect(ENGINE).toContain('bibCategory:')
  })

  it('the legacy bibLocks collision guard is still consulted', () => {
    expect(ENGINE).toContain("collection('bibLocks')")
    expect(CONFIG).toContain("collection('bibCounters')")
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 7 — CHECK-IN COMPATIBILITY (structural; behaviour is covered in the emulator)
// ════════════════════════════════════════════════════════════════════════════

describe('7 — check-in keeps its contract', () => {
  it('scan still allocates through the engine, before the check-in transaction', () => {
    expect(SCAN).toContain('allocateIdentifier({')
    expect(SCAN.indexOf('allocateIdentifier({')).toBeLessThan(SCAN.indexOf('adminDb.runTransaction'))
  })

  it('scan forwards the pass from the registration it already resolved', () => {
    const call = SCAN.slice(SCAN.indexOf('allocateIdentifier({'))
    expect(call.slice(0, 500)).toContain('reg.passId')
  })

  it('walk-in still goes through autoAssignIfEnabled with its passId', () => {
    expect(WALKIN).toContain('autoAssignIfEnabled({')
    const call = WALKIN.slice(WALKIN.indexOf('autoAssignIfEnabled({'))
    expect(call.slice(0, 300)).toContain('passId')
  })

  it('consumeIdentifier and the everCheckedIn latch are unchanged', () => {
    expect(ENGINE).toContain('export async function consumeIdentifier')
    expect(ENGINE).toContain("state: 'consumed', everCheckedIn: true")
    // The permanent rule: a checked-in identifier is never auto-reusable.
    // RD-EVENT-19D MOVED `canReuse` from ./config to the pure ./reusePolicy so the
    // browser can consult it without the Admin SDK. The rule is byte-identical and
    // ./config still re-exports it, so every existing import is unchanged.
    const REUSE = code(read('lib/identifiers/reusePolicy.ts'))
    expect(REUSE).toContain('if (lock.everCheckedIn) return false')
    expect(CONFIG).toContain("export { canReuse } from './reusePolicy'")
  })

  it('the label still comes from configuration, never from a literal in the route', () => {
    expect(SCAN).toContain('idConfig.label')
    expect(SCAN).not.toMatch(/'Bib Number'/)
  })

  it('reusePolicy is still the engine\'s to enforce', () => {
    expect(ENGINE).toContain('canReuse(lock, config.reusePolicy')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 8 — SECURITY
// ════════════════════════════════════════════════════════════════════════════

describe('8 — ownership stays server-authoritative', () => {
  it('a malformed eventId is a 404, not an unhandled 500', () => {
    const fn = SCOPE.slice(SCOPE.indexOf('export async function resolveIdentifierScope'))
    expect(fn).toContain('try {')
    expect(fn).toContain('adminDb.doc(')
    expect(fn.indexOf('try {')).toBeLessThan(fn.indexOf('adminDb.doc('))
  })

  it('a malformed registrationId is handled the same way', () => {
    const fn = SCOPE.slice(SCOPE.indexOf('export async function assertRegistrationInScope'))
    expect(fn).toContain('try {')
    expect(fn).toContain('catch {')
  })

  it('a registration must match BOTH the workspace and the event', () => {
    expect(SCOPE).toContain("r.organizerUid !== workspaceUid || r.eventSlug !== slug")
  })

  it('the pass forwarded to the engine comes from the STORED document, never the body', () => {
    // If a route could pass a body-supplied passId, an organizer could steer an
    // allocation into a pool the registration does not belong to.
    expect(SCOPE).toContain("typeof r.passId === 'string'")
    expect(IDS_RT).toContain('scopedPassId = guard.passId')
    expect(IDS_RT).not.toMatch(/passId:\s*body\./)
    expect(BULK_RT).toContain('passId: guard.passId')
    expect(BULK_RT).not.toMatch(/passId:\s*row\./)
  })

  it('no identifier route trusts a client-supplied uid', () => {
    for (const src of [IDS_RT, BULK_RT, POOLS_RT]) {
      expect(src).not.toMatch(/body\.(organizerUid|uid)/)
      expect(src).toContain('resolveIdentifierScope')
    }
  })

  it('the client cannot reach the identifier collections directly', () => {
    const RULES = read('firestore.rules')
    for (const col of ['identifierLocks', 'identifierCounters', 'identifierConfigs', 'identifierHistory']) {
      const at = RULES.indexOf(col)
      expect(at).toBeGreaterThan(-1)
      expect(RULES.slice(at, at + 200)).toContain('if false')
    }
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 9 — EVENT-TYPE NEUTRALITY (mandatory matrix)
// ════════════════════════════════════════════════════════════════════════════

/**
 * One fixture per RegisterDesk event category. Each configures pass-scoped pools
 * with its OWN vocabulary and its OWN numbering, and every one of them is served
 * by the same resolver, the same range walker and the same formatter — with no
 * category ever named in the code under test.
 */
const CATEGORY_FIXTURES: Array<{
  category: string
  label:    string
  type:     IdentifierConfig['type']
  prefix:   string
  padding:  number
  pools:    IdentifierPool[]
  probes:   Array<{ passId: string; poolId: string; firstValue: string }>
}> = [
  {
    category: 'Conference', label: 'Delegate ID', type: 'alphanumeric', prefix: 'DEL-', padding: 4,
    pools: [
      { poolId: 'vip',     label: 'VIP delegates',     passIds: ['pass-vip'],     ranges: [{ start: 1, end: 99 }] },
      { poolId: 'general', label: 'General delegates', passIds: ['pass-general'], ranges: [{ start: 100, end: 999 }] },
    ],
    probes: [
      { passId: 'pass-vip',     poolId: 'vip',     firstValue: 'DEL-0001' },
      { passId: 'pass-general', poolId: 'general', firstValue: 'DEL-0100' },
    ],
  },
  {
    category: 'Exhibition & Expo', label: 'Visitor ID', type: 'alphanumeric', prefix: 'VIS-', padding: 4,
    pools: [
      { poolId: 'visitor',   label: 'Visitors',  passIds: ['pass-visitor'],   ranges: [{ start: 1, end: 5000 }] },
      { poolId: 'exhibitor', label: 'Exhibitors', passIds: ['pass-exhibitor'], ranges: [{ start: 9000, end: 9499 }] },
    ],
    probes: [
      { passId: 'pass-visitor',   poolId: 'visitor',   firstValue: 'VIS-0001' },
      { passId: 'pass-exhibitor', poolId: 'exhibitor', firstValue: 'VIS-9000' },
    ],
  },
  {
    category: 'Sports & Fitness', label: 'Participant Number', type: 'numeric', prefix: '', padding: 0,
    pools: [
      { poolId: 'short',  label: 'Short course',  passIds: ['pass-short'],  ranges: [{ start: 5001, end: 6500 }] },
      { poolId: 'medium', label: 'Medium course', passIds: ['pass-medium'], ranges: [{ start: 7000, end: 7499 }] },
      { poolId: 'long',   label: 'Long course',   passIds: ['pass-long'],   ranges: [{ start: 8000, end: 8799 }] },
    ],
    probes: [
      { passId: 'pass-short',  poolId: 'short',  firstValue: '5001' },
      { passId: 'pass-medium', poolId: 'medium', firstValue: '7000' },
      { passId: 'pass-long',   poolId: 'long',   firstValue: '8000' },
    ],
  },
  {
    category: 'Workshop & Training', label: 'Participant ID', type: 'alphanumeric', prefix: 'WS-', padding: 4,
    pools: [
      { poolId: 'beginner', label: 'Beginner', passIds: ['pass-beginner'], ranges: [{ start: 1, end: 999 }] },
      { poolId: 'advanced', label: 'Advanced', passIds: ['pass-advanced'], ranges: [{ start: 1001, end: 1999 }] },
    ],
    probes: [
      { passId: 'pass-beginner', poolId: 'beginner', firstValue: 'WS-0001' },
      { passId: 'pass-advanced', poolId: 'advanced', firstValue: 'WS-1001' },
    ],
  },
  {
    category: 'Business Meetup', label: 'Member ID', type: 'alphanumeric', prefix: 'BM-', padding: 4,
    pools: [{ poolId: 'delegate', label: 'Delegates', passIds: ['pass-delegate'], ranges: [{ start: 1, end: 500 }] }],
    probes: [{ passId: 'pass-delegate', poolId: 'delegate', firstValue: 'BM-0001' }],
  },
  {
    category: 'Community & Awareness', label: 'Volunteer ID', type: 'alphanumeric', prefix: 'VOL-', padding: 3,
    pools: [{ poolId: 'vol', label: 'Volunteers', passIds: ['pass-vol'], ranges: [{ start: 1, end: 300 }] }],
    probes: [{ passId: 'pass-vol', poolId: 'vol', firstValue: 'VOL-001' }],
  },
  {
    category: 'Cultural & Entertainment', label: 'Seat Number', type: 'alphanumeric', prefix: 'EVT-', padding: 4,
    pools: [
      { poolId: 'general', label: 'General', passIds: ['pass-ga'],  ranges: [{ start: 1, end: 800 }] },
      { poolId: 'vip',     label: 'VIP',     passIds: ['pass-vip'], ranges: [{ start: 900, end: 999 }] },
    ],
    probes: [
      { passId: 'pass-ga',  poolId: 'general', firstValue: 'EVT-0001' },
      { passId: 'pass-vip', poolId: 'vip',     firstValue: 'EVT-0900' },
    ],
  },
  {
    category: 'Awards & Recognition', label: 'Nominee ID', type: 'alphanumeric', prefix: 'NOM-', padding: 4,
    pools: [{ poolId: 'nominee', label: 'Nominees', passIds: ['pass-nominee'], ranges: [{ start: 1, end: 200 }] }],
    probes: [{ passId: 'pass-nominee', poolId: 'nominee', firstValue: 'NOM-0001' }],
  },
  {
    category: 'Fundraising & Charity', label: 'Supporter ID', type: 'alphanumeric', prefix: 'SUP-', padding: 4,
    pools: [{ poolId: 'supporter', label: 'Supporters', passIds: ['pass-supporter'], ranges: [{ start: 1, end: 2000 }] }],
    probes: [{ passId: 'pass-supporter', poolId: 'supporter', firstValue: 'SUP-0001' }],
  },
  {
    category: 'Custom Event', label: 'Access Code', type: 'alphanumeric', prefix: 'ACC-', padding: 5,
    pools: [
      { poolId: 'tier-1', label: 'Tier one', passIds: ['pass-t1'], ranges: [{ start: 1, end: 50 }, { start: 200, end: 250 }] },
      { poolId: 'tier-2', label: 'Tier two', passIds: ['pass-t2'], ranges: [{ start: 500, end: 600 }] },
    ],
    probes: [
      { passId: 'pass-t1', poolId: 'tier-1', firstValue: 'ACC-00001' },
      { passId: 'pass-t2', poolId: 'tier-2', firstValue: 'ACC-00500' },
    ],
  },
]

describe('9 — the same mechanism serves every event category', () => {
  for (const fx of CATEGORY_FIXTURES) {
    describe(fx.category, () => {
      const config: IdentifierConfig = {
        ...defaultIdentifierConfig('evt'),
        label: fx.label,
        type:  fx.type,
        format: { prefix: fx.prefix, suffix: '', padding: fx.padding, startNumber: 1 },
        pools: [DEFAULT_POOL, ...fx.pools],
        defaultPoolId: DEFAULT_POOL_ID,
      }

      for (const probe of fx.probes) {
        it(`${probe.passId} → ${probe.poolId}, first value ${probe.firstValue}`, () => {
          const pool = resolvePool(config, undefined, { passId: probe.passId })
          expect(pool.poolId).toBe(probe.poolId)

          const ranges = configuredRanges(pool)
          const first  = nextNumberInRanges(ranges, ranges[0].start)
          const value  = formatIdentifier({
            type: config.type, format: effectiveFormat(config.format, pool), n: first as number,
          })
          expect(value).toBe(probe.firstValue)
        })
      }

      it('a participant from one pass never receives another pass\'s number', () => {
        for (const probe of fx.probes) {
          const pool  = resolvePool(config, undefined, { passId: probe.passId })
          const mine  = configuredRanges(pool)
          const first = nextNumberInRanges(mine, mine[0].start) as number
          for (const other of fx.probes) {
            if (other.passId === probe.passId) continue
            const otherPool = resolvePool(config, undefined, { passId: other.passId })
            expect(isInRanges(configuredRanges(otherPool), first)).toBe(false)
          }
        }
      })

      it('the label is data — nothing in the engine depends on it', () => {
        expect(config.label).toBe(fx.label)
        expect(ENGINE).not.toContain(fx.label)
      })

      it('its pools survive validation as a set (no overlaps, no shared pass)', () => {
        const all = fx.pools.flatMap(p => configuredRanges(p))
        expect(firstOverlap(all)).toBeNull()
        const passes = fx.pools.flatMap(p => p.passIds ?? [])
        expect(new Set(passes).size).toBe(passes.length)
      })
    })
  }

  it('all ten categories are represented', () => {
    expect(CATEGORY_FIXTURES).toHaveLength(10)
  })
})

describe('9b — no sports-specific allocation logic exists', () => {
  const MODULES: Array<[string, string]> = [
    ['engine.ts', ENGINE], ['config.ts', CONFIG], ['ranges.ts', RANGES],
    ['format.ts', FORMAT], ['eligibility.ts', ELIGIBLE], ['types.ts', TYPES],
    ['organizerScope.ts', SCOPE],
  ]

  for (const [name, src] of MODULES) {
    it(`${name} names no sport`, () => {
      for (const word of [/\brunner/i, /\bmarathon/i, /\bfinisher/i, /\brace\b/i, /\blane\b/i, /\bathlete/i]) {
        expect(src).not.toMatch(word)
      }
    })
  }

  it('every remaining "bib" is a LEGACY compatibility name or the default label', () => {
    // Allowed, and only these: the legacy collections, the legacy registration
    // mirror fields, the legacy counter seed, and the default label/preset that
    // an organizer can rename in one click.
    const ALLOWED = /bibLocks|bibCounters|bibNumber|bibCategory|nextBib|legacyBibLockOwner|'Bib Number'|'bib'/
    for (const [name, src] of MODULES) {
      for (const raw of src.split('\n')) {
        // `code()` drops whole-line comments; a TRAILING one is still prose, and
        // prose about the word must not be judged as a use of it.
        const line = raw.split('//')[0]
        if (!/bib/i.test(line)) continue
        expect(ALLOWED.test(line), `${name}: ${line.trim()}`).toBe(true)
      }
    }
  })

  it('no allocation branch keys off an event category', () => {
    for (const [, src] of MODULES) {
      expect(src).not.toContain('eventCategory')
      expect(src).not.toContain('eventType')
    }
  })

  it('the default label is only a default — the config carries the real one', () => {
    // RD-BIB-01 · neutral by default; a sports organizer types their own word.
    // RD-BIB-TIMING-04 · REVERTED to 'Identifier'. RD-BIB-TIMING-03 briefly made
    // this 'Number'; swapping one generic default for another only moved the
    // problem. The rule is unchanged: neutral, never "Bib Number", and the label
    // an organizer reads comes from the event's own configuration.
    expect(defaultIdentifierConfig('e').label).toBe('Identifier')
    expect(defaultIdentifierConfig('e').label.toLowerCase()).not.toContain('bib')
    expect(ENGINE).toContain('config.label')
    expect(ENGINE).not.toMatch(/label:\s*'Bib Number'/)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 10 — LEGACY CONFIG SHAPES
// ════════════════════════════════════════════════════════════════════════════

describe('10 — no existing event becomes unusable', () => {
  it('A · a pool with only rangeStart/rangeEnd resolves and stays bounded', () => {
    const cfg = withPools([{ poolId: DEFAULT_POOL_ID, label: 'Default', rangeStart: 100, rangeEnd: 199 }])
    const pool = resolvePool(cfg, undefined, {})
    expect(pool.rangeEnd).toBe(199)
    expect(configuredRanges(pool)).toEqual([])          // legacy path, not the walker
    expect(effectiveRanges(pool)).toEqual([{ start: 100, end: 199 }])
  })

  it('B · a pool with ranges[] resolves and walks them', () => {
    const cfg = withPools([
      DEFAULT_POOL,
      { poolId: 'multi', label: 'Multi', passIds: ['p'], ranges: [{ start: 1, end: 2 }, { start: 9, end: 10 }] },
    ])
    const pool = resolvePool(cfg, undefined, { passId: 'p' })
    expect(nextNumberInRanges(configuredRanges(pool), 3)).toBe(9)
  })

  it('C · an old config using matchRule.by = "pass" still resolves', () => {
    const cfg = withPools([DEFAULT_POOL, { poolId: 'old', label: 'Old', matchRule: { by: 'pass', values: ['p1'] } }])
    expect(resolvePool(cfg, undefined, { passId: 'p1' }).poolId).toBe('old')
  })

  it('D · a new config using passIds resolves', () => {
    const cfg = withPools([DEFAULT_POOL, { poolId: 'new', label: 'New', passIds: ['p1'] }])
    expect(resolvePool(cfg, undefined, { passId: 'p1' }).poolId).toBe('new')
  })

  it('E · a partial config still yields a complete one via the default merge', () => {
    const partial = { ...defaultIdentifierConfig('evt'), pools: [DEFAULT_POOL] }
    expect(partial.format.padding).toBe(4)
    expect(partial.reusePolicy).toBe('never')
    expect(resolvePool(partial, undefined, {}).poolId).toBe(DEFAULT_POOL_ID)
  })

  it('F · NO config at all reproduces the pre-platform behaviour', () => {
    const d = defaultIdentifierConfig('evt')
    expect(d.type).toBe('numeric')
    expect(d.format.padding).toBe(4)
    expect(d.assignmentStrategy).toBe('manual')
    expect(d.reusePolicy).toBe('never')
    expect(d.pools).toEqual([{ poolId: DEFAULT_POOL_ID, label: 'Default' }])
    // The new fields are absent, so nothing about an unconfigured event changes.
    expect(d.pools[0].passIds).toBeUndefined()
    expect(d.pools[0].ranges).toBeUndefined()
    expect(d.format.caseMode).toBeUndefined()
  })

  it('caseMode absent means preserve — identical folding to before 19A', () => {
    const fmt = effectiveFormat(defaultIdentifierConfig('e').format, DEFAULT_POOL)
    expect(fmt.caseMode).toBe('preserve')
    expect(normalizeIdentifierValue('MiXeD', fmt.caseMode)).toBe('MiXeD')
  })

  it('the new pool fields are additive — no existing field was renamed', () => {
    for (const field of ['poolId', 'label', 'prefix', 'suffix', 'padding', 'rangeStart', 'rangeEnd', 'templateId', 'matchRule']) {
      expect(TYPES).toContain(field)
    }
    expect(TYPES).toContain('passIds?')
    expect(TYPES).toContain('ranges?')
  })

  it('the pools API forwards the new fields instead of silently dropping them', () => {
    expect(POOLS_RT).toContain('passIds:')
    expect(POOLS_RT).toContain('ranges:')
  })
})
