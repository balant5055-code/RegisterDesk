// RD-BIB-UX-02 — the persistence contract for identifier configuration.
//
// ═══ THE BUG ═════════════════════════════════════════════════════════════════
// Saving a second BIB number range returned HTTP 500:
//
//   Cannot use "undefined" as a Firestore value (found in field "pools.`1`.prefix")
//
// `pools[0]` is the built-in default pool — an object literal with no `prefix` KEY
// at all — so it serialized. `pools[1]` was the organizer's new range, built by the
// pools route's request parser, which wrote `prefix: undefined` for every optional
// field the request omitted. JSON cannot carry `undefined`, so the browser never
// sent one: the server manufactured it, one line before the Firestore write.
//
// These tests pin the contract — optional means ABSENT, never `undefined` — at
// every layer that can produce a pool: the request parser, the domain normalizer,
// and the final assertion in front of the write.

import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

vi.mock('@/lib/firebase/admin', () => ({ adminDb: {} }))

import {
  normalizePool, normalizeConfigForPersistence, assertNoUndefined,
  defaultIdentifierConfig, DEFAULT_POOL_ID,
} from '@/lib/identifiers/config'
import { rangeCapacity, validateRanges } from '@/lib/identifiers/ranges'
import { IdentifierConfigError } from '@/lib/identifiers/types'
import type { IdentifierConfig, IdentifierPool } from '@/lib/identifiers/types'

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
const strip = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

const POOLS_ROUTE = strip(read('app/api/organizer/events/[eventId]/identifiers/pools/route.ts'))
const CONFIG_LIB  = strip(read('lib/identifiers/config.ts'))
const TAB         = strip(read('app/(dashboard)/dashboard/events/[eventId]/tabs/SportsTab.tsx'))

/** Every key present on the object, at every depth, whose value is `undefined`. */
function undefinedPaths(value: unknown, path = '$'): string[] {
  if (value === undefined) return [path]
  if (value === null || typeof value !== 'object') return []
  if (Array.isArray(value)) return value.flatMap((v, i) => undefinedPaths(v, `${path}[${i}]`))
  return Object.entries(value as Record<string, unknown>)
    .flatMap(([k, v]) => undefinedPaths(v, `${path}.${k}`))
}

const pool = (over: Partial<IdentifierPool> = {}): IdentifierPool =>
  ({ poolId: 'p5', label: '5 KM', ranges: [{ start: 5001, end: 5600 }], ...over })

// ════════════════════════════════════════════════════════════════════════════
// 1 — PREFIX (§9)
// ════════════════════════════════════════════════════════════════════════════

describe('1 — prefix: optional means absent, never undefined and never a ghost string', () => {
  it('an UNDEFINED prefix is dropped, not stored', () => {
    const out = normalizePool(pool({ prefix: undefined }))
    expect('prefix' in out).toBe(false)
    expect(undefinedPaths(out)).toEqual([])
  })

  it('an EMPTY prefix is dropped — "" and "no prefix" are one state, not two', () => {
    expect('prefix' in normalizePool(pool({ prefix: '' }))).toBe(false)
  })

  it('a WHITESPACE prefix is dropped, not stored as spaces', () => {
    expect('prefix' in normalizePool(pool({ prefix: '   ' }))).toBe(false)
  })

  it('a real prefix is kept, and trimmed', () => {
    expect(normalizePool(pool({ prefix: '  BIB-  ' })).prefix).toBe('BIB-')
    expect(normalizePool(pool({ prefix: 'A' })).prefix).toBe('A')
  })

  it('the strings "undefined" and "null" are never produced', () => {
    for (const p of [undefined, '', '  ']) {
      const out = normalizePool(pool({ prefix: p }))
      expect(JSON.stringify(out)).not.toContain('"prefix"')
    }
  })

  it('a prefix that is literally the word undefined is a real prefix and survives', () => {
    // Absurd, but it is a string the organizer typed; silently dropping it would be
    // a different lie from the one this phase is fixing.
    expect(normalizePool(pool({ prefix: 'undefined' })).prefix).toBe('undefined')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 2 — EVERY OPTIONAL FIELD, NOT JUST PREFIX (§2)
// ════════════════════════════════════════════════════════════════════════════

describe('2 — every optional pool field follows the same rule', () => {
  it('a pool with nothing but the required fields stores exactly those', () => {
    const out = normalizePool({ poolId: 'x', label: 'X' })
    expect(Object.keys(out).sort()).toEqual(['label', 'poolId'])
    expect(undefinedPaths(out)).toEqual([])
  })

  it('suffix, padding, templateId, passIds, ranges and matchRule are all dropped when absent', () => {
    const out = normalizePool({
      poolId: 'x', label: 'X',
      suffix: undefined, padding: undefined, templateId: undefined,
      passIds: undefined, ranges: undefined, matchRule: undefined,
      rangeStart: undefined, rangeEnd: undefined,
    })
    for (const k of ['suffix', 'padding', 'templateId', 'passIds', 'ranges', 'matchRule', 'rangeStart', 'rangeEnd']) {
      expect(k in out).toBe(false)
    }
  })

  it('an explicit NULL is preserved where the schema declares one', () => {
    // rangeStart/rangeEnd/templateId are `number | null` / `string | null`: null is
    // the legacy "unbounded" signal and means something. undefined does not.
    const out = normalizePool({ poolId: 'x', label: 'X', rangeStart: null, rangeEnd: null, templateId: null })
    expect(out.rangeStart).toBeNull()
    expect(out.rangeEnd).toBeNull()
    expect(out.templateId).toBeNull()
    expect(undefinedPaths(out)).toEqual([])
  })

  it('a zero padding is kept — 0 is a value, not an absence', () => {
    expect(normalizePool(pool({ padding: 0 })).padding).toBe(0)
  })

  it('ranges are rebuilt as plain start/end pairs, with no stray keys', () => {
    const out = normalizePool(pool({
      ranges: [{ start: 5001, end: 5600, note: 'x' } as never],
    }))
    expect(out.ranges).toEqual([{ start: 5001, end: 5600 }])
  })

  it('matchRule survives with both its fields', () => {
    const out = normalizePool(pool({ matchRule: { by: 'category', values: ['elite'] } }))
    expect(out.matchRule).toEqual({ by: 'category', values: ['elite'] })
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 3 — MULTIPLE POOLS, WHICH IS WHERE IT ACTUALLY BROKE (§11)
// ════════════════════════════════════════════════════════════════════════════

describe('3 — multiple pools, the exact shape that produced pools.`1`.prefix', () => {
  const config = (pools: IdentifierPool[]): IdentifierConfig =>
    ({ ...defaultIdentifierConfig('evt'), pools, defaultPoolId: pools[0].poolId })

  it('TWO pools with empty prefixes carry no undefined anywhere', () => {
    const out = normalizeConfigForPersistence(config([
      { poolId: DEFAULT_POOL_ID, label: 'Default' },
      { poolId: 'p5',  label: '5 KM',  prefix: undefined, ranges: [{ start: 5001, end: 5600 }], passIds: ['a'] },
      { poolId: 'p10', label: '10 KM', prefix: undefined, ranges: [{ start: 7001, end: 7500 }], passIds: ['b'] },
    ]))
    expect(undefinedPaths(out)).toEqual([])
    expect('prefix' in out.pools[1]).toBe(false)
    expect('prefix' in out.pools[2]).toBe(false)
  })

  it('two pools with DIFFERENT prefixes keep them independently', () => {
    const out = normalizeConfigForPersistence(config([
      { poolId: 'p5',  label: '5 KM',  prefix: 'A', ranges: [{ start: 5001, end: 5600 }] },
      { poolId: 'p10', label: '10 KM', prefix: 'B', ranges: [{ start: 7001, end: 7500 }] },
    ]))
    expect(out.pools.map(p => p.prefix)).toEqual(['A', 'B'])
  })

  it('one pool with a prefix beside one without does not leak between them', () => {
    const out = normalizeConfigForPersistence(config([
      { poolId: 'p5',  label: '5 KM',  prefix: 'A', ranges: [{ start: 5001, end: 5600 }] },
      { poolId: 'p10', label: '10 KM', ranges: [{ start: 7001, end: 7500 }] },
    ]))
    expect(out.pools[0].prefix).toBe('A')
    expect('prefix' in out.pools[1]).toBe(false)
    expect(undefinedPaths(out)).toEqual([])
  })

  it('a config with no tagMapping does not gain an undefined one', () => {
    const out = normalizeConfigForPersistence(config([{ poolId: 'p', label: 'P' }]))
    expect('tagMapping' in out).toBe(false)
    expect('updatedAt' in out).toBe(false)
    expect(undefinedPaths(out)).toEqual([])
  })

  it('a config WITH tagMapping keeps it', () => {
    const base = config([{ poolId: 'p', label: 'P' }])
    const out = normalizeConfigForPersistence({
      ...base, tagMapping: { enabled: true, label: 'Chip', source: 'manual' } as never,
    })
    expect(out.tagMapping).toBeTruthy()
    expect(undefinedPaths(out)).toEqual([])
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 4 — THE ASSERTION IN FRONT OF THE WRITE (§3)
// ════════════════════════════════════════════════════════════════════════════

describe('4 — nothing undefined can reach Firestore', () => {
  it('assertNoUndefined names the exact path, at depth', () => {
    expect(() => assertNoUndefined({ pools: [{ poolId: 'a' }, { prefix: undefined }] }, 'cfg'))
      .toThrow(/cfg\.pools\[1\]\.prefix/)
  })

  it('it throws IdentifierConfigError, so the route answers 400 and not a 500 stack', () => {
    try {
      assertNoUndefined({ a: undefined })
      expect.unreachable('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(IdentifierConfigError)
    }
  })

  it('null, 0, "" and false are all legal values and pass', () => {
    expect(() => assertNoUndefined({ a: null, b: 0, c: '', d: false, e: [] })).not.toThrow()
  })

  it('a Firestore sentinel is opaque and is not walked into', () => {
    class Sentinel { constructor(public secret: undefined = undefined) {} }
    expect(() => assertNoUndefined({ updatedAt: new Sentinel() })).not.toThrow()
  })

  it('a normalized default config passes the assertion', () => {
    expect(() => assertNoUndefined(normalizeConfigForPersistence(defaultIdentifierConfig('evt')))).not.toThrow()
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 5 — THE WRITE PATH IS THE ONLY WRITE PATH (§3)
// ════════════════════════════════════════════════════════════════════════════

describe('5 — the fix sits in front of the one write, not in a caller', () => {
  it('saveIdentifierConfig normalizes, asserts, THEN writes — in that order', () => {
    const fn = CONFIG_LIB.slice(CONFIG_LIB.indexOf('const persisted = normalizeConfigForPersistence'))
    const norm   = fn.indexOf('normalizeConfigForPersistence(next)')
    const assert = fn.indexOf('assertNoUndefined(document')
    const write  = fn.indexOf('configRef(eventSlug).set(document')
    expect(norm).toBeGreaterThan(-1)
    expect(assert).toBeGreaterThan(norm)
    expect(write).toBeGreaterThan(assert)
  })

  it('it returns what was STORED, so the echo matches the document', () => {
    expect(CONFIG_LIB).toContain('return persisted')
    expect(CONFIG_LIB).not.toMatch(/await auditConfigChange\([^)]*\)\s*\n\s*return next/)
  })

  it('the global Firestore initialization was NOT relaxed', () => {
    // The forbidden shortcut. It would hide this class of bug everywhere at once.
    for (const f of ['lib/firebase/admin.ts', 'lib/identifiers/config.ts']) {
      expect(read(f)).not.toContain('ignoreUndefinedProperties')
    }
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 6 — THE REQUEST PARSER, WHICH MANUFACTURED THE UNDEFINED (§1)
// ════════════════════════════════════════════════════════════════════════════

describe('6 — the pools route parser omits rather than inventing undefined', () => {
  it('no optional field is assigned undefined any more', () => {
    expect(POOLS_ROUTE).not.toMatch(/prefix:\s*typeof b\.prefix === 'string' \? b\.prefix : undefined/)
    expect(POOLS_ROUTE).not.toContain(': undefined,')
  })

  it('every optional field uses a conditional spread', () => {
    for (const f of ['prefix', 'suffix', 'padding', 'rangeStart', 'rangeEnd', 'templateId', 'passIds', 'ranges']) {
      expect(POOLS_ROUTE).toContain(`{ ${f}:`)
    }
  })

  it('nullable fields still accept an explicit null', () => {
    expect(POOLS_ROUTE).toContain("b.rangeStart === null ? { rangeStart:")
    expect(POOLS_ROUTE).toContain("b.templateId === null ? { templateId:")
  })

  it('poolId and label are still required — the server contract is unchanged', () => {
    expect(POOLS_ROUTE).toContain('if (!poolId || !label) return null')
    expect(POOLS_ROUTE).toContain("error: 'poolId and label are required'")
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 7 — THE CLIENT (§5, §15, §16)
// ════════════════════════════════════════════════════════════════════════════

describe('7 — the editor sends the same shape, and its Save means what it says', () => {
  const EDITOR = TAB.slice(TAB.indexOf('function PoolEditor'), TAB.indexOf('// ─── Value tools'))

  it('the client no longer writes `|| undefined` either', () => {
    expect(EDITOR).not.toContain('prefix: prefix.trim() || undefined')
    expect(EDITOR).toContain('...(trimmedPrefix ? { prefix: trimmedPrefix } : {})')
  })

  it('an empty pass list and an empty range list are omitted, not sent empty', () => {
    // `passIds: []` is rejected by the server on purpose — it reads like "all
    // passes" and means the opposite.
    expect(EDITOR).toContain('...(selectedPasses.length > 0 ? { passIds: selectedPasses } : {})')
    expect(EDITOR).toContain('draft.ranges.length > 0 ? { ranges: draft.ranges }')
  })

  it('Save no longer demands a Reference and a Name the organizer must invent', () => {
    expect(EDITOR).not.toContain('!!poolId.trim() && idOk && !!name.trim()')
    expect(EDITOR).toContain('const canSave = idOk && !!derivedName && rangesOk')
  })

  it('the generated reference is deterministic — no clock, no randomness', () => {
    const fn = EDITOR.slice(EDITOR.indexOf('const derivedId'), EDITOR.indexOf('const idOk'))
    expect(fn).not.toContain('Date.now')
    expect(fn).not.toContain('Math.random')
    expect(fn).not.toContain('crypto')
  })

  it('a disabled Save always states why', () => {
    expect(EDITOR).toContain('const blockedBecause')
    expect(EDITOR).toContain('aria-describedby={blockedBecause ?')
  })

  it('a failed save shows a sentence, never a Firestore message or a field path', () => {
    expect(EDITOR).toContain("Check the range details and try again.")
    expect(EDITOR).not.toContain('err.message')
    expect(EDITOR).not.toContain('String(err)')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 8 — WHAT MUST NOT HAVE CHANGED (§4, §8, §12, §13)
// ════════════════════════════════════════════════════════════════════════════

describe('8 — ranges, gaps, overlaps and capacity are untouched', () => {
  it('capacity is the SUM of ranges, never the span', () => {
    expect(rangeCapacity([{ start: 5001, end: 5600 }])).toBe(600)
    expect(rangeCapacity([{ start: 5001, end: 5999 }, { start: 7000, end: 7500 }])).toBe(1500)
    // The span 5001–7500 would be 2500. It is not capacity, and never was.
    expect(rangeCapacity([{ start: 5001, end: 5999 }, { start: 7000, end: 7500 }])).not.toBe(2500)
  })

  it('overlapping ranges are still rejected', () => {
    expect(() => validateRanges([{ start: 5001, end: 5600 }, { start: 5500, end: 5700 }], 'p'))
      .toThrow(/overlap/i)
  })

  it('a gap is legal and is preserved through normalization, in order', () => {
    const out = normalizePool(pool({ ranges: [{ start: 7000, end: 7500 }, { start: 5001, end: 5999 }] }))
    // Normalization copies; it does not sort, dedupe or merge — validateRanges owns that.
    expect(out.ranges).toEqual([{ start: 7000, end: 7500 }, { start: 5001, end: 5999 }])
  })

  it('a pass association survives normalization exactly', () => {
    const out = normalizePool(pool({ passIds: ['pwalk', 'p5'] }))
    expect(out.passIds).toEqual(['pwalk', 'p5'])
  })

  it('the allocation engine and the lock/counter authorities were not touched', () => {
    const engine = read('lib/identifiers/engine.ts')
    expect(engine).not.toContain('RD-BIB-UX-02')
    expect(read('lib/identifiers/assignmentJob.ts')).not.toContain('RD-BIB-UX-02')
    expect(read('lib/identifiers/timingTagEngine.ts')).not.toContain('RD-BIB-UX-02')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 9 — THE MESSAGES AN ORGANIZER ACTUALLY READS (§6, §16)
// ════════════════════════════════════════════════════════════════════════════

describe('9 — a refused save explains itself without leaking the data model', () => {
  it('an overlap inside one range set says "number range", not "pool"', () => {
    // This string is rendered inline in the editor AND returned in the API's 400,
    // so it is organizer-facing on both paths.
    try {
      validateRanges([{ start: 5001, end: 5600 }, { start: 5500, end: 5700 }], '5 KM Walkathon BIB Numbers')
      expect.unreachable('should have thrown')
    } catch (e) {
      const msg = (e as Error).message
      expect(msg).toContain('Number range "5 KM Walkathon BIB Numbers"')
      expect(msg).toContain('5001–5600')
      expect(msg).toContain('5500–5700')
      expect(msg).not.toMatch(/\bpool\b/i)
    }
  })

  it('every range-validator message avoids the word "pool"', () => {
    const cases: unknown[] = [
      'not-an-array',
      [],
      [{ start: 'x', end: 2 }],
      [{ start: 5, end: 1 }],
      [{ start: 1, end: 2 }, { start: 1, end: 2 }],
      [{ nope: true }],
    ]
    for (const c of cases) {
      try {
        validateRanges(c, 'My range')
      } catch (e) {
        expect((e as Error).message).not.toMatch(/\bpools?\b/i)
      }
    }
  })

  it('the cross-range validators in the config layer say it too', () => {
    expect(CONFIG_LIB).toContain('Number ranges "${owner}" and "${p.poolId}" are both assigned to the same pass.')
    expect(CONFIG_LIB).toContain('have overlapping ranges.')
    expect(CONFIG_LIB).not.toMatch(/`Pools? "/)
  })

  it('"starts after it ends" is preserved — an existing test depends on it', () => {
    expect(() => validateRanges([{ start: 6500, end: 5001 }], 'r')).toThrow(/starts after it ends/)
  })
})
