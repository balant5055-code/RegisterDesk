// RD-BIB-01 — assignment safety, exact planning, and the vocabulary an organizer reads.
//
// The audit that preceded this phase found four things that were true of the shipped
// system, each verified against the emulator before anything was changed:
//
//   1. `strandedByRanges` was written, tested, documented as the contract the range
//      editor "is required to consult" — and consulted by nothing. A pool could be
//      moved off the numbers people were already carrying, silently.
//   2. `OUT_OF_RANGE` existed in the error union and was mapped to HTTP 400, and was
//      thrown nowhere: 99999 was accepted into a pool configured 5001–5600.
//   3. A pass with no range of its own was served from the default pool. On a
//      freshly-defaulted config that pool is unbounded, so the number was 1.
//   4. `hasIdentifier` was designed in 19C and never written, so "how many numbers
//      will this issue?" was permanently unanswerable.
//
// These tests pin the fixes AND the boundaries of the fixes — particularly that
// legacy events, which never opted into pass-scoped numbering, still behave exactly
// as they did.

import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

vi.mock('@/lib/firebase/admin', () => ({ adminDb: {} }))

import {
  rangesContain, bandsOutside, describeRanges, strandedByRanges, isInRanges,
} from '@/lib/identifiers/ranges'
import { eventUsesPassScopedPools, poolsForPass } from '@/lib/identifiers/eligibility'
import { resolvePool, defaultIdentifierConfig, DEFAULT_POOL_ID } from '@/lib/identifiers/config'
import { IdentifierError } from '@/lib/identifiers/types'
import { summarizePassParticipants, PASS_COVERAGE_UNKNOWN_REASON } from '@/lib/identifiers/statistics'
import {
  buildPlanRow, assignButtonLabel, previewButtonLabel, article,
  PLAN_STATUS_LABEL, PLAN_STATUS_TONE,
} from '@/lib/identifiers/identifierWorkspace'
import { allowedNumbersForPass, isAllowedNumber } from '@/lib/registrations/identity'
// RD-BIB-TIMING-01 · the readiness verdict that now counts both gaps.
import { resolveTagReadiness } from '@/lib/identifiers/timingTags'
import type { IdentifierConfig, IdentifierPool } from '@/lib/identifiers/types'

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

const ENGINE = code(read('lib/identifiers/engine.ts'))
const CONFIG = code(read('lib/identifiers/config.ts'))
const JOB    = code(read('lib/identifiers/assignmentJob.ts'))
const TAB    = code(read('app/(dashboard)/dashboard/events/[eventId]/tabs/SportsTab.tsx'))
const W360   = code(read('app/(dashboard)/dashboard/events/[eventId]/registrations/ParticipantWorkspace360.tsx'))
const BIBS   = code(read('app/api/organizer/events/[eventId]/bibs/route.ts'))
const POOLS  = code(read('app/api/organizer/events/[eventId]/identifiers/pools/route.ts'))

/** A minimal runnable plan row, for the label helpers. */
const planRow = (over: Partial<Parameters<typeof buildPlanRow>[0]> = {}) => buildPlanRow({
  passId: 'p5', passName: '5 KM', ranges: [{ start: 5001, end: 5600 }],
  capacityKind: 'finite', capacity: 600, available: 558,
  participants: { value: 600 }, alreadyAssigned: { value: 290 },
  willAssign: { value: 310, status: 'known', reason: null },
  // RD-BIB-UX-02 · one range is wired to this pass. tsconfig excludes tests, so an
  // omitted `poolCount` would silently read as "unconfigured" rather than failing.
  nextValue: 5291, blockers: [], poolCount: 1, ...over,
})

const withPools = (pools: IdentifierPool[], defaultPoolId = DEFAULT_POOL_ID): IdentifierConfig =>
  ({ ...defaultIdentifierConfig('evt'), pools, defaultPoolId })

// ════════════════════════════════════════════════════════════════════════════
// 1 — RANGE-EDIT SAFETY (§4)
// ════════════════════════════════════════════════════════════════════════════

describe('1 — a range change cannot silently orphan issued numbers', () => {
  it('containment is exact — widening cannot strand anything', () => {
    expect(rangesContain([{ start: 5001, end: 5999 }], [{ start: 5001, end: 5600 }])).toBe(true)
    expect(rangesContain([{ start: 1, end: 10000 }], [{ start: 5001, end: 5600 }])).toBe(true)
  })

  it('merging two adjacent ranges into one contains both', () => {
    expect(rangesContain([{ start: 5001, end: 5200 }], [{ start: 5001, end: 5100 }, { start: 5101, end: 5200 }])).toBe(true)
  })

  it('splitting a range around a hole does NOT contain it', () => {
    expect(rangesContain([{ start: 5001, end: 5100 }, { start: 5200, end: 5300 }], [{ start: 5001, end: 5300 }])).toBe(false)
  })

  it('shrinking and moving do not contain the old set', () => {
    expect(rangesContain([{ start: 5001, end: 5010 }], [{ start: 5001, end: 5600 }])).toBe(false)
    expect(rangesContain([{ start: 8000, end: 8600 }], [{ start: 5001, end: 5600 }])).toBe(false)
  })

  it('a bounded set never contains an unbounded one', () => {
    expect(rangesContain([{ start: 1, end: 10 }], [])).toBe(true)     // nothing to contain
    expect(rangesContain([], [{ start: 1, end: 10 }])).toBe(false)
  })

  it('the bands to count are the gaps the new ranges leave, and there is one more than there are ranges', () => {
    expect(bandsOutside([{ start: 5001, end: 5100 }, { start: 7001, end: 7050 }], 9999))
      .toEqual([{ start: 0, end: 5000 }, { start: 5101, end: 7000 }, { start: 7051, end: 9999 }])
  })

  it('an unbounded pool has no bands — nothing can be outside it', () => {
    expect(bandsOutside([], 9999)).toEqual([])
  })

  it('a range reaching the ceiling produces no trailing band', () => {
    expect(bandsOutside([{ start: 0, end: 9999 }], 9999)).toEqual([])
  })

  it('the pure detector still answers what it always did', () => {
    expect(strandedByRanges([{ start: 6000, end: 7000 }], [5500, 6100])).toEqual([5500])
    expect(strandedByRanges([], [5500])).toEqual([])
  })

  it('the SERVER enforces it — refusal is the default, acknowledgement is explicit', () => {
    expect(CONFIG).toContain('export async function reportStranding')
    expect(CONFIG).toContain('acknowledgeStranding')
    expect(CONFIG).toContain('would fall outside the new number range')
    // The check runs only when pools actually changed.
    expect(CONFIG).toContain('if (patch.pools) {')
  })

  it('it fails CLOSED — an unverifiable count refuses the write', () => {
    expect(CONFIG).toContain('const unverifiable = reports.filter(r => r.stranded === null)')
    const guard = CONFIG.slice(CONFIG.indexOf('const unverifiable'), CONFIG.indexOf('const damaging'))
    expect(CONFIG.slice(CONFIG.indexOf('if (unverifiable.length > 0)'), CONFIG.indexOf('if (damaging.length > 0 && !options')))
      .toContain('throw new IdentifierConfigError')
    expect(guard).toBeTruthy()
  })

  it('an acknowledged change is AUDITED with its count', () => {
    expect(CONFIG).toContain('acknowledged: ${total} issued identifier(s) now outside their range')
    expect(CONFIG).toContain('auditConfigChange(eventSlug, actor, reason + strandingNote)')
  })

  it('it never loads locks — only counts them', () => {
    const fn = CONFIG.slice(CONFIG.indexOf('export async function reportStranding'), CONFIG.indexOf('export async function saveIdentifierConfig'))
    // Every read in this function is an aggregate: no `.get()` appears that is not
    // preceded by `.count()`, and nothing is projected because nothing is fetched.
    expect(fn).toContain('.count().get()')
    expect((fn.match(/\.get\(\)/g) ?? []).length).toBe((fn.match(/\.count\(\)\.get\(\)/g) ?? []).length)
    expect(fn).not.toContain('.select(')
    expect(fn).not.toContain('.docs')
  })

  it('the route lets an organizer acknowledge, and never assumes it', () => {
    expect(POOLS).toContain('acknowledgeStranding === true')
    expect(POOLS).not.toContain('acknowledgeStranding: true,')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 2 — MANUAL VALUES OBEY THE RANGE (§5)
// ════════════════════════════════════════════════════════════════════════════

describe('2 — a manual number outside the pass\'s range is refused', () => {
  it('the engine throws OUT_OF_RANGE, which was previously dead code', () => {
    const branch = ENGINE.slice(ENGINE.indexOf('if (explicit) {'), ENGINE.indexOf('} else {'))
    expect(branch).toContain("throw new IdentifierError(")
    expect(branch).toContain("'OUT_OF_RANGE'")
    expect(branch).toContain('isInRanges(ranges, n)')
  })

  it('the refusal names the configured range, in the same words the plan uses', () => {
    expect(ENGINE).toContain('describeRanges(ranges)')
    expect(describeRanges([{ start: 5001, end: 5600 }])).toBe('5001–5600')
    expect(describeRanges([{ start: 5001, end: 5100 }, { start: 7001, end: 7050 }])).toBe('5001–5100 + 7001–7050')
  })

  it('an unbounded pool is unaffected — legacy events keep working', () => {
    const branch = ENGINE.slice(ENGINE.indexOf('if (explicit) {'), ENGINE.indexOf('} else {'))
    expect(branch).toContain('if (ranges.length > 0)')
  })

  it('it is enforced INSIDE the transaction, so every surface obeys it', () => {
    // The check sits after `runTransaction(` opens and before any write.
    const txn = ENGINE.slice(ENGINE.indexOf('adminDb.runTransaction'))
    expect(txn.indexOf("'OUT_OF_RANGE'")).toBeGreaterThan(-1)
    expect(txn.indexOf("'OUT_OF_RANGE'")).toBeLessThan(txn.indexOf('txn.set(lRef'))
  })

  it('the multi-range case: 6000 is out, 7001 is in', () => {
    const ranges = [{ start: 5001, end: 5100 }, { start: 7001, end: 7050 }]
    expect(isInRanges(ranges, 6000)).toBe(false)
    expect(isInRanges(ranges, 7001)).toBe(true)
    expect(isInRanges(ranges, 5100)).toBe(true)
  })

  it('the ORGANIZER sees the allowed numbers before typing', () => {
    const identity = {
      identifierEnabled: true, identifierLabel: 'Participant Number',
      tagsEnabled: false, tagLabel: 'Timing Tag',
      pools: [{ poolId: 'a', label: 'A', passIds: ['p5'], ranges: [{ start: 5001, end: 5600 }] }],
    }
    expect(allowedNumbersForPass(identity, 'p5').text).toBe('5001–5600')
    expect(isAllowedNumber(allowedNumbersForPass(identity, 'p5').ranges, '99999')).toBe(false)
    expect(isAllowedNumber(allowedNumbersForPass(identity, 'p5').ranges, '5501')).toBe(true)
  })

  it('an unknown or unbounded case is never a client-side refusal', () => {
    expect(allowedNumbersForPass(null, 'p5').text).toBeNull()
    expect(isAllowedNumber([], '5001')).toBeNull()
    expect(isAllowedNumber([{ start: 1, end: 9 }], 'DEL-0042')).toBeNull()   // not numeric ⇒ server decides
  })

  it('the panel blocks submission only on a PROVEN mismatch', () => {
    expect(W360).toContain('isAllowedNumber(allowedRanges, input) === false')
    expect(W360).toContain('Allowed for this pass:')
    expect(W360).toContain('is outside')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 3 — NO SILENT DEFAULT-POOL FALLBACK (§6)
// ════════════════════════════════════════════════════════════════════════════

describe('3 — a pass with no range is refused, not quietly served from another', () => {
  const scoped = withPools([
    { poolId: DEFAULT_POOL_ID, label: 'General' },
    { poolId: 'p5',  label: '5 KM',  passIds: ['pass5'],  ranges: [{ start: 5001, end: 5600 }] },
    { poolId: 'p10', label: '10 KM', passIds: ['pass10'], ranges: [{ start: 7001, end: 7350 }] },
  ])

  it('an event that maps ANY pool to a pass has opted into pass-wise numbering', () => {
    expect(eventUsesPassScopedPools(scoped.pools)).toBe(true)
    expect(eventUsesPassScopedPools([{ poolId: 'd', label: 'D' }])).toBe(false)
    expect(eventUsesPassScopedPools(undefined)).toBe(false)
  })

  it('the legacy matchRule form counts as pass scoping too', () => {
    expect(eventUsesPassScopedPools([{ poolId: 'x', label: 'X', matchRule: { by: 'pass', values: ['a'] } }])).toBe(true)
  })

  it('an uncovered pass gets NO pool on a pass-scoped event', () => {
    expect(poolsForPass(scoped.pools, 'kids')).toEqual([])
    expect(() => resolvePool(scoped, undefined, { passId: 'kids' }))
      .toThrow(/no participant-number range configured/)
  })

  it('a registration with NO pass is refused on a pass-scoped event', () => {
    expect(() => resolvePool(scoped, undefined, {})).toThrow(IdentifierError)
  })

  it('a DELETED pass id behaves the same way — it is simply uncovered', () => {
    expect(() => resolvePool(scoped, undefined, { passId: 'removed-last-season' })).toThrow(IdentifierError)
  })

  it('a covered pass still resolves to exactly its own pool', () => {
    expect(resolvePool(scoped, undefined, { passId: 'pass5' }).poolId).toBe('p5')
    expect(resolvePool(scoped, undefined, { passId: 'pass10' }).poolId).toBe('p10')
  })

  it('LEGACY events are untouched: no pass scoping ⇒ the unrestricted pool serves everyone', () => {
    const legacy = withPools([{ poolId: DEFAULT_POOL_ID, label: 'General' }])
    expect(poolsForPass(legacy.pools, 'anything').map(p => p.poolId)).toEqual([DEFAULT_POOL_ID])
    expect(resolvePool(legacy, undefined, { passId: 'anything' }).poolId).toBe(DEFAULT_POOL_ID)
    expect(resolvePool(legacy, undefined, {}).poolId).toBe(DEFAULT_POOL_ID)
  })

  it('a category rule still wins where it always did', () => {
    const mixed = withPools([
      { poolId: DEFAULT_POOL_ID, label: 'D' },
      { poolId: 'cat', label: 'Elite', matchRule: { by: 'category', values: ['elite'] } },
      { poolId: 'byPass', label: 'By pass', passIds: ['p1'] },
    ])
    expect(resolvePool(mixed, undefined, { category: 'elite' }).poolId).toBe('cat')
  })

  it('an explicit poolId still outranks everything', () => {
    expect(resolvePool(scoped, 'p10', { passId: 'pass5' }).poolId).toBe('p10')
  })

  it('the ENGINE and the PLANNER read the same predicate', () => {
    expect(CONFIG).toContain('eventUsesPassScopedPools(config.pools)')
    expect(code(read('lib/identifiers/assignmentDecision.ts'))).toContain('poolsForPass(config.pools, passId)')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 4 — THE EXACT PRE-RUN COUNT (§7)
// ════════════════════════════════════════════════════════════════════════════

describe('4 — "how many will be assigned" is exact, or honestly unknown', () => {
  it('a fully covered roster gives an exact figure', () => {
    const s = summarizePassParticipants({ total: 600, withIdentifier: 42, withoutIdentifier: 558 }, 'absent')
    expect(s.total.value).toBe(600)
    expect(s.assigned.value).toBe(42)
    expect(s.willAssign.value).toBe(558)
    expect(s.willAssign.status).toBe('known')
    expect(s.uncounted).toBe(0)
  })

  it('a roster the field does not fully cover is UNKNOWN — never the subtraction', () => {
    const s = summarizePassParticipants({ total: 600, withIdentifier: 42, withoutIdentifier: 500 }, 'absent')
    expect(s.willAssign.value).toBeNull()
    expect(s.willAssign.status).toBe('unavailable')
    expect(s.willAssign.reason).toBe(PASS_COVERAGE_UNKNOWN_REASON)
    expect(s.uncounted).toBe(58)
    // The tempting wrong answer would have been 600 − 42 = 558.
    expect(s.willAssign.value).not.toBe(558)
  })

  it('an unread aggregate is unknown, not zero', () => {
    const s = summarizePassParticipants({ total: null, withIdentifier: null, withoutIdentifier: null }, 'could not read')
    expect(s.total.value).toBeNull()
    expect(s.willAssign.value).toBeNull()
    expect(s.uncounted).toBeNull()
  })

  it('a pass that was never counted is unknown, not zero', () => {
    const s = summarizePassParticipants(undefined, 'not counted')
    expect(s.total.status).toBe('unavailable')
    expect(s.willAssign.status).toBe('unavailable')
  })

  it('zero still needing one is a real answer, not an unknown', () => {
    const s = summarizePassParticipants({ total: 12, withIdentifier: 12, withoutIdentifier: 0 }, 'absent')
    expect(s.willAssign.value).toBe(0)
    expect(s.willAssign.status).toBe('known')
  })

  it('the field is written ONLY with the lock and the other mirrors', () => {
    expect(ENGINE).toContain('hasIdentifier: true')
    expect(ENGINE).toContain('hasIdentifier: false')
    for (const m of ENGINE.matchAll(/hasIdentifier: (true|false)/g)) {
      const before = ENGINE.slice(Math.max(0, m.index! - 700), m.index!)
      expect(before, m[0]).toContain('txn.update(rRef, {')
    }
  })

  it('the counts are three equality-only aggregates — no composite index needed', () => {
    const fn = CONFIG.slice(CONFIG.indexOf('const passScope = passIds.slice'), CONFIG.indexOf('return { byPool'))
    expect(fn).toContain("countOf(q.where('hasIdentifier', '==', true))")
    expect(fn).toContain("countOf(q.where('hasIdentifier', '==', false))")
    expect(fn).not.toContain('orderBy')
  })

  it('per-pass work is bounded by CONFIGURATION, not by event size', () => {
    expect(CONFIG).toContain('MAX_STAT_PASSES')
    expect(CONFIG).toContain('passIds.slice(0, MAX_STAT_PASSES)')
  })

  it('the backfill exists, defaults to a dry run, and is never auto-run', () => {
    const script = read('scripts/migrations/backfill-has-identifier.mjs')
    expect(script).toContain('--apply')
    expect(script).toContain('DRY RUN')
    expect(script).toContain('hasIdentifier')
    // Nothing in the app imports it.
    expect(code(read('lib/identifiers/config.ts'))).not.toContain('backfill-has-identifier')
  })

  it('the backfill touches ONE field and reads only the mirrors', () => {
    const script = read('scripts/migrations/backfill-has-identifier.mjs')
    expect(script).toContain('batch.update(doc.ref, { hasIdentifier: want })')
    for (const forbidden of ['identifierLocks', 'identifierCounters', 'identifierTagLocks', 'timingTag', 'paymentStatus']) {
      expect(script, forbidden).not.toContain(forbidden)
    }
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 5 — THE PLAN ROW (§8, §9, §22)
// ════════════════════════════════════════════════════════════════════════════

describe('5 — the plan states the numbers, and promises only what it can', () => {
  const base = {
    passId: 'p5', passName: '5 KM',
    ranges: [{ start: 5001, end: 5600 }],
    capacityKind: 'finite' as const, capacity: 600, available: 558,
    participants: { value: 600 }, alreadyAssigned: { value: 42 },
    willAssign: { value: 558, status: 'known', reason: null },
    nextValue: 5043, blockers: [], poolCount: 1,
  }

  it('the range is stated as the organizer would write it', () => {
    expect(buildPlanRow(base).numbers).toBe('5001–5600')
  })

  it('a multi-range pass names both blocks and the gap between them', () => {
    const row = buildPlanRow({ ...base, ranges: [{ start: 5001, end: 5100 }, { start: 7001, end: 7050 }] })
    expect(row.numbers).toBe('5001–5100 + 7001–7050')
    expect(row.gaps).toEqual([{ start: 5101, end: 7000 }])
  })

  it('the expected end is stated when every input is exact', () => {
    expect(buildPlanRow(base).expectedLast).toBe(5600)
  })

  it('the expected end is WITHHELD when the count is unknown', () => {
    const row = buildPlanRow({ ...base, willAssign: { value: null, status: 'unavailable', reason: 'x' } })
    expect(row.expectedLast).toBeNull()
    expect(row.willAssign).toBeNull()
    expect(row.willAssignReason).toBe('x')
  })

  it('the expected end is WITHHELD when the run would cross a gap', () => {
    const row = buildPlanRow({
      ...base, ranges: [{ start: 5001, end: 5010 }, { start: 7001, end: 7600 }],
      nextValue: 5005, willAssign: { value: 100, status: 'known', reason: null },
    })
    expect(row.crossesGap).toBe(true)
    expect(row.expectedLast).toBeNull()
  })

  it('a shortfall is named, and it is the shortfall — not the capacity', () => {
    const row = buildPlanRow({ ...base, available: 500, willAssign: { value: 558, status: 'known', reason: null } })
    expect(row.shortBy).toBe(58)
  })

  it('no shortfall is reported when there is room', () => {
    expect(buildPlanRow(base).shortBy).toBeNull()
  })

  it('an unbounded pool has no shortfall and no range text', () => {
    const row = buildPlanRow({ ...base, ranges: [], capacityKind: 'unlimited', capacity: null, available: null })
    expect(row.numbers).toBeNull()
    expect(row.shortBy).toBeNull()
  })

  it('a blocked pass is not runnable', () => {
    expect(buildPlanRow({ ...base, blockers: ['POOL_MISSING'] }).runnable).toBe(false)
    expect(buildPlanRow(base).runnable).toBe(true)
  })

  it('the button names the figure only when EVERY runnable pass can prove it', () => {
    const exact  = buildPlanRow(base)
    const vague  = buildPlanRow({ ...base, passId: 'p10', passName: '10 KM', willAssign: { value: null, status: 'unavailable', reason: 'x' } })
    expect(assignButtonLabel([exact], 'participant number')).toBe('Assign 558 participant numbers')
    expect(assignButtonLabel([exact, vague], 'participant number')).toBe('Assign participant numbers for 2 passes')
    expect(assignButtonLabel([vague], 'participant number')).toBe('Assign participant numbers for 10 KM')
  })

  it('when nobody needs one, the button says so instead of offering a no-op', () => {
    const none = buildPlanRow({ ...base, willAssign: { value: 0, status: 'known', reason: null } })
    expect(assignButtonLabel([none], 'participant number')).toBe('Everyone already has one')
  })

  it('a blocked-only selection falls back to the plain verb', () => {
    expect(assignButtonLabel([buildPlanRow({ ...base, blockers: ['POOL_MISSING'] })], 'bib')).toBe('Assign bibs')
  })

  it('the TAB renders the range, the four figures and the gap explanation', () => {
    expect(TAB).toContain('{label} range')
    expect(TAB).toContain('label="Participants"')
    // RD-BIB-UX-02 · "Already assigned" became `Already have ${art} ${label}` and a fourth
    // figure was added, so the totals row now names all four questions in the
    // organizer's own vocabulary. Re-anchored to the new labels, same four figures.
    expect(TAB).toContain('label={`Already have ${art} ${label}`}')
    expect(TAB).toContain('label={`Need ${art} ${label}`} value={n(totals.willAssign)}')
    expect(TAB).toContain('label="Will be assigned"')
    expect(TAB).toContain('intentionally skipped and will never be issued')
  })

  it('the per-pass card shows THIS pass, not the whole event', () => {
    expect(TAB).toContain('hint="Confirmed, on this pass"')
  })

  it('a total is unknown when any part of it is', () => {
    expect(TAB).toContain('xs.some(v => v === null) ? null')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 5b — RD-BIB-UX-01 · THE WORKFLOW IS THREE EXPLICIT STEPS
// ════════════════════════════════════════════════════════════════════════════

// The complaint this answers: the primary button read "Assign 48 bib numbers" and
// sat directly under the pass selector, with "you will be shown exactly what will
// happen before anything is written" placed BELOW it. A button is read before the
// sentence beneath it, so the screen said "this click assigns" and then explained,
// too late, that it does not. Nothing about the backend was wrong — the preview was
// already a pure useMemo — but an organizer could not tell.

describe('5b — the first click previews, and only the last one writes', () => {
  const PLAN = TAB.slice(TAB.indexOf('function PlanSection'), TAB.indexOf('function RunResult'))

  it('the flow has an explicit stage, and it starts at the plan', () => {
    expect(PLAN).toContain("useState<'plan' | 'preview'>('plan')")
  })

  it('the FIRST button previews — it does not assign', () => {
    expect(PLAN).toContain("onClick={() => setStage('preview')}")
    expect(PLAN).toContain('previewButtonLabel(runnableRows, label)')
    expect(previewButtonLabel([planRow()], 'BIB Number')).toBe('Preview BIB Number assignment')
    expect(previewButtonLabel([planRow(), planRow({ passId: 'b' })], 'BIB Number'))
      .toBe('Preview BIB Number assignment for 2 passes')
  })

  it('no CONTROL before the confirmation implies a mutation', () => {
    // The section HEADING may say "Assign … automatically" — that names the screen,
    // and an organizer needs to know what the screen is for. What must not appear
    // before the confirmation is a control that reads as though it writes.
    // Just the step-1 branch of the ternary — up to `) : (`, where step 2 begins.
    const start = PLAN.indexOf("stage === 'plan' ? (")
    const stagePlan = PLAN.slice(start, PLAN.indexOf(') : (', start))
    expect(stagePlan).toContain('previewButtonLabel')
    expect(stagePlan).toContain("setStage('preview')")
    expect(stagePlan).not.toContain('assignButtonLabel')
    expect(stagePlan).not.toContain('execute()')
    // …and the copy beside that button says so in words.
    expect(stagePlan).toContain('Nothing is assigned yet')
  })

  it('the second step reviews, and its forward button is not "Assign" either', () => {
    expect(PLAN).toContain('Ready to assign')
    expect(PLAN).toContain('Continue to confirmation')
    expect(PLAN).toContain('Nothing written yet')
    expect(PLAN).toContain('Still nothing has been written')
  })

  it('the review shows the first number, the last number and the count', () => {
    const review = PLAN.slice(PLAN.indexOf('Ready to assign'), PLAN.indexOf('Continue to confirmation'))
    expect(review).toContain('label="First number"')
    expect(review).toContain('label="Last number"')
    expect(review).toContain('label="Numbers to assign"')
  })

  it('a gap is explained in the review, and never counted as capacity', () => {
    const review = PLAN.slice(PLAN.indexOf('Ready to assign'), PLAN.indexOf('Continue to confirmation'))
    expect(review).toContain('configured gap')
    expect(review).toContain('is ever assigned')
  })

  it('EXECUTION is reachable only from the review stage', () => {
    // `execute` is called from exactly one place, and that place is inside the
    // preview stage's markup.
    expect((PLAN.match(/void execute\(\)/g) ?? []).length).toBe(1)
    const previewBlock = PLAN.slice(PLAN.indexOf("{stage === 'preview' && ("))
    expect(previewBlock).toContain('void execute()')
  })

  it('every fetch still sits behind the confirmation', () => {
    expect(PLAN.indexOf('await confirm({')).toBeLessThan(PLAN.indexOf('fetch('))
  })

  it('the confirmation is the ONLY place the word Assign carries a number', () => {
    expect(PLAN).toContain('confirmLabel: assignButtonLabel(runnableRows, label)')
    expect(assignButtonLabel([planRow({ willAssign: { value: 310, status: 'known', reason: null } })], 'BIB Number')).toBe('Assign 310 BIB Numbers')
    expect(assignButtonLabel([planRow({ willAssign: { value: 1, status: 'known', reason: null } })], 'BIB Number')).toBe('Assign 1 BIB Number')
  })

  it('the confirmation names the pass, the counts and the irreversibility', () => {
    const confirmBlock = PLAN.slice(PLAN.indexOf('await confirm({'), PLAN.indexOf('if (!ok) return'))
    // The event's configured label verbatim, so the title and the button agree:
    // "Confirm BIB Number assignment" → "Assign 48 BIB Numbers".
    expect(confirmBlock).toContain('Confirm ${label} assignment')
    expect(confirmBlock).toContain('You are about to assign')
    expect(confirmBlock).toContain('registered for ${passNames}')
    expect(confirmBlock).toContain('cannot be undone')
    expect(confirmBlock).toContain('left unchanged')
    expect(confirmBlock).toContain("tone: 'danger'")
  })

  it('changing the pass or the mode drops back to step 1', () => {
    expect(PLAN).toContain("const chooseMode = (m: 'all' | 'pass') => { setMode(m); setStage('plan') }")
    expect(PLAN).toContain("const choosePass = (id: string) => { setPassId(id); setStage('plan') }")
    expect(PLAN).toContain("onClick={() => chooseMode('all')}")
    expect(PLAN).toContain('onChange={e => choosePass(e.target.value)}')
  })

  it('a finished run returns to step 1, so a second run must be previewed again', () => {
    const afterRun = PLAN.slice(PLAN.indexOf('await onDone()'))
    expect(afterRun).toContain("setStage('plan')")
  })

  it('the organizer is told which step they are on', () => {
    expect(TAB).toContain('function StepBadge')
    expect(TAB).toContain('Step {step} of {of}')
  })

  it('"pool" and "scope" are gone from the workflow copy', () => {
    const copy = PLAN.split('\n').filter(l => /^\s*[A-Za-z`'"]/.test(l) && !l.includes('poolId') && !l.includes('poolStats'))
    const text = copy.join('\n')
    expect(text).not.toMatch(/pool'?s? numbers|its pool|the pool\b/i)
    expect(text).not.toMatch(/\bscopes below\b/)
    // The event's CONFIGURED label, verbatim — "BIB Number", "Delegate Number" —
    // so the copy, the figures and the confirm button all read the same way.
    expect(PLAN).toContain('configured ${label} range')
  })

  it('the three ways to assign are named and distinguished', () => {
    expect(TAB).toContain('function WorkflowKey')
    expect(TAB).toContain('Automatic — you are here')
    expect(TAB).toContain('Manual')
    expect(TAB).toContain('Bulk import')
  })

  it('the summary answers §11 in full', () => {
    expect(PLAN).toContain('label="Total participants"')
    expect(PLAN).toContain('${label}s already assigned')
    // RD-BIB-UX-02 · the indefinite article now follows the configured label, so an
    // event whose numbers are called "Entry Number" reads "Need an Entry Number".
    expect(PLAN).toContain('Need ${art} ${label}')
    expect(PLAN).toContain('label="Capacity"')
    expect(PLAN).toContain('label="Available"')
    expect(PLAN).toContain('Next ${label}')
    expect(PLAN).toContain('still need ${art} ${label}')
  })

  it('"No limit" appears only for a genuinely unbounded range', () => {
    for (const m of PLAN.matchAll(/'No limit'/g)) {
      const before = PLAN.slice(Math.max(0, m.index! - 120), m.index!)
      expect(before, 'No limit').toContain("capacityKind === 'unlimited'")
    }
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 6 — THE RESULT (§12, §24)
// ════════════════════════════════════════════════════════════════════════════

describe('6 — after the run, the organizer is told what happened', () => {
  it('exhaustion is explained in words, with what to do next', () => {
    expect(TAB).toContain('because the number range was exhausted')
    expect(TAB).toContain('Widen the range and run again')
  })

  it('every other outcome has a sentence too', () => {
    expect(TAB).toContain('because they already had a')
    expect(TAB).toContain('because their pass has no number range configured')
    expect(TAB).toContain('cancelled or rejected')
  })

  it('the numbers actually issued are reported, never a guess', () => {
    expect(TAB).toContain('job.firstValue')
    expect(TAB).toContain('job.lastValue')
    // The job records what it ISSUED, filled in as values are minted — never derived
    // from the range, which is what would turn a partial run into a false claim.
    expect(JOB).toContain('firstValue: null, lastValue: null')
    expect(JOB).toContain('firstValue')
  })

  it('the next available number is shown', () => {
    expect(TAB).toContain('Next available:')
  })

  it('verification is one click away, and does not download the roster', () => {
    expect(TAB).toContain('View assigned participants')
    expect(TAB).toContain('Export assignment')
    expect(TAB).toContain("setSection('participants'); setFilter('assigned')")
  })

  it('a partial run is never described as a failure', () => {
    expect(TAB).toContain('Everything above is committed')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 7 — ORDERING (§10)
// ════════════════════════════════════════════════════════════════════════════

describe('7 — who gets the first number is now a choice', () => {
  it('the default is the existing behaviour, so no event is re-ordered silently', () => {
    expect(defaultIdentifierConfig('e').assignmentOrder).toBeUndefined()
    expect(code(read('app/api/organizer/events/[eventId]/identifiers/assign-jobs/route.ts')))
      .toContain("config.assignmentOrder ?? 'document'")
  })

  it('the order is frozen onto the job at creation', () => {
    expect(JOB).toContain('order:      AssignmentOrder')
    expect(JOB).toContain('order: input.order')
  })

  it('registration order breaks ties on the document id, so paging is stable', () => {
    expect(JOB).toContain("q.orderBy('registeredAt', 'asc').orderBy(FieldPath.documentId(), 'asc')")
    expect(JOB).toContain('encodeCursor')
    expect(JOB).toContain('decodeCursor')
  })

  it('document order is unchanged', () => {
    expect(JOB).toContain('q = q.orderBy(FieldPath.documentId())')
  })

  it('the index registration order needs is declared', () => {
    const idx = JSON.parse(read('firestore.indexes.json')) as {
      indexes: Array<{ collectionGroup: string; fields: Array<{ fieldPath: string }> }>
    }
    expect(idx.indexes.some(i =>
      i.collectionGroup === 'registrations' &&
      i.fields.map(f => f.fieldPath).join(',') === 'organizerUid,eventSlug,status,passId,registeredAt')).toBe(true)
  })

  it('the organizer can choose it, and the copy explains what it does', () => {
    expect(TAB).toContain('First to register, first number')
    expect(TAB).toContain('assignmentOrder: order')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 8 — COST, VOCABULARY AND WHAT MUST NOT MOVE
// ════════════════════════════════════════════════════════════════════════════

describe('8 — the workspace no longer downloads the roster', () => {
  it('the legacy route accepts a bound, and keeps its unbounded default for compatibility', () => {
    expect(BIBS).toContain("searchParams.get('limit')")
    expect(BIBS).toContain('Math.min(Math.floor(rawLimit), 500)')
    expect(BIBS).toContain('if (limit !== null) query = query.limit(limit)')
  })

  it('the workspace always passes one', () => {
    expect(TAB).toContain('bibs?limit=${ROSTER_PAGE}')
    expect(TAB).toContain('const ROSTER_PAGE = 200')
  })

  it('and says the list is a sample rather than implying it is everyone', () => {
    expect(TAB).toContain('Showing the first {ROSTER_PAGE} confirmed participants')
  })

  it('the permission is aligned with every other identifier surface', () => {
    expect(BIBS).toContain("authorizeWorkspace(req, 'participants')")
    expect(BIBS).not.toContain("authorizeWorkspace(req, 'events')")
  })
})

describe('9 — the organizer reads their own words, not the engine\'s', () => {
  it('the default label for an unconfigured event is event-type neutral', () => {
    // RD-BIB-TIMING-04 · REVERTED to 'Identifier'. RD-BIB-TIMING-03 briefly made
    // this 'Number'; swapping one generic default for another only moved the
    // problem. The rule is unchanged: neutral, never "Bib Number", and the label
    // an organizer reads comes from the event's own configuration.
    expect(defaultIdentifierConfig('e').label).toBe('Identifier')
    expect(defaultIdentifierConfig('e').label.toLowerCase()).not.toContain('bib')
  })

  it('"pool" is not organizer vocabulary', () => {
    expect(TAB).toContain("label: 'Number ranges'")
    expect(TAB).not.toContain("label: 'Pools'")
  })

  it('lock states are explained, never shown raw', () => {
    expect(TAB).toContain('STATE_COPY')
    expect(TAB).toContain('being held, so it will not be assigned automatically')
  })

  it('the one-sided replace is called Replace, because that is what it does', () => {
    expect(W360).toContain('Replace')
    expect(ENGINE).toContain('export async function swapIdentifier')   // the wire action is unchanged
    expect(W360).toContain("action: mode === 'swap' ? 'swap' : 'assign'")
  })

  it('printing gained a neutral token WITHOUT losing the old one', () => {
    const vars = code(read('lib/printAssets/render/variables.ts'))
    expect(vars).toContain("token: 'identifier'")
    expect(vars).toContain("token: 'bibNumber'")
    expect(vars).toContain("['identifier',   str(r.bibNumber)]")
  })

  it('no marathon vocabulary entered the generic identifier modules', () => {
    for (const f of ['lib/identifiers/engine.ts', 'lib/identifiers/config.ts', 'lib/identifiers/ranges.ts',
                     'lib/identifiers/eligibility.ts', 'lib/identifiers/statistics.ts']) {
      const src = code(read(f))
      const strings = src.match(/'[^']*'/g)?.join(' ') ?? ''
      expect(strings.toLowerCase(), f).not.toMatch(/\brunner\b|\bmarathon\b|\bfinisher\b|\bbib number\b/)
    }
  })
})

describe('10 — the contracts this phase must not break', () => {
  it('the engine is still the only allocator', () => {
    expect(ENGINE).toContain('export async function allocateIdentifier')
    expect(code(read('lib/sports/bibNumbers.ts'))).toContain('allocateIdentifier')
    expect(code(read('lib/sports/bibNumbers.ts'))).not.toContain('identifierLocks')
  })

  it('idempotency is untouched', () => {
    expect(ENGINE).toContain('skipIfAssigned')
    expect(JOB).toContain('skipIfAssigned')
  })

  it('the lock is still authoritative, and history still append-only', () => {
    expect(ENGINE).toContain("collection('identifierLocks')")
    expect(ENGINE).toContain('appendHistory')
  })

  it('the lease handoff that RD-EVENT-19G added is still set', () => {
    expect(JOB).toContain('releaseLeaseOnHandoff: true')
  })

  it('timing tags are untouched by identifier operations', () => {
    // RD-BIB-TIMING-01 · the identifier engine now READS the timing mirror, once,
    // to refuse releasing a number a device depends on. That is a deliberate change
    // to this assertion, not a leak: the property that matters is that it never
    // WRITES a tag, and the two lock authorities stay separate.
    expect(ENGINE).not.toContain('identifierTagLocks')
    expect(ENGINE).not.toContain('assignTimingTag')
    expect(ENGINE).not.toContain('removeTimingTag')
    // The only contact is the shared read-only helper.
    expect(ENGINE).toContain("import { currentTimingTag } from './timingTagEngine'")
  })

  it('check-in still authenticates on the ticket code', () => {
    const scan = code(read('app/api/checkin/scan/route.ts'))
    expect(scan).toContain('ticketCode')
    expect(scan).not.toContain('timingTag')
  })

  it('the RaceOps ingestion boundary was not touched', () => {
    expect(read('features/race-operations/import/mapping/aliases.ts'))
      .toContain("'chipid', 'startnumber', 'startno', 'no',")
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// RD-BIB-UX-02 · why the plan screen said "—" for a pass it had already counted.
//
// The organizer's screenshot showed a pass with every figure dashed and the words
// "This pass could not be counted." Two independent causes were found, and both were
// reproduced in the browser before anything was changed:
//
//   A. `summarizePassScopes` built its list from the POOLS. A pass with no number
//      range produced no scope at all, so the plan looked its statistics up by
//      passId, found nothing, and printed the "could not be counted" fallback — for
//      a pass whose participants had just been counted exactly by an aggregate that
//      was then discarded.
//
//   B. `createRegistration` never wrote `hasIdentifier`. Firestore cannot count
//      documents that are MISSING a field, so `where(hasIdentifier, ==, false)`
//      returned 0 on every event, the roster never reconciled (290 + 0 ≠ 600), and
//      "Need a BIB Number" was permanently UNKNOWN — on correctly configured passes
//      too. The RD-BIB-01 fixtures seeded the field by hand, which is exactly why
//      that phase's QA looked exact and production did not.
// ═══════════════════════════════════════════════════════════════════════════════

const REGS  = code(read('lib/firebase/firestore/registrations.ts'))
const STATS = code(read('lib/identifiers/statistics.ts'))
const DEC   = code(read('lib/identifiers/assignmentDecision.ts'))

describe('RD-BIB-UX-02 · a pass is counted whether or not it has numbers', () => {
  it('B · every new registration is born countable', () => {
    // Without this the third aggregate can never reconcile, on any event.
    expect(REGS).toContain('hasIdentifier: false')
    // …and it is in the document the transaction writes, not in a comment or a
    // later update: it must appear before the set() that commits the row.
    const doc   = REGS.indexOf('const regDoc')
    const set   = REGS.indexOf('txn.set(regRef, regDoc)')
    const field = REGS.indexOf('hasIdentifier: false')
    expect(doc).toBeGreaterThan(-1)
    expect(field).toBeGreaterThan(doc)
    expect(field).toBeLessThan(set)
  })

  it('A · the scope list is driven by the passes the EVENT has, not by the ranges', () => {
    expect(STATS).toContain('...ctx.passes.map(p => p.id),')
    // The old form filtered the event's passes down to those a pool named.
    expect(STATS).not.toContain('ctx.passes.map(p => p.id).filter(id => byPass.has(id))')
    // A pass with no pool must not throw on the lookup either.
    expect(STATS).toContain('byPass.get(passId) ?? []')
  })

  it('A · an unconfigured pass keeps its counts and is marked, not blanked', () => {
    const row = buildPlanRow({
      passId: 'pkids', passName: 'Kids Dash', ranges: [],
      capacityKind: 'finite', capacity: null, available: null,
      participants: { value: 50 }, alreadyAssigned: { value: 0 },
      willAssign: { value: 50, status: 'known', reason: null },
      nextValue: null, blockers: ['POOL_MISSING'], poolCount: 0,
    })
    expect(row.participants).toBe(50)        // known, and no longer thrown away
    expect(row.alreadyAssigned).toBe(0)
    expect(row.configured).toBe(false)
    expect(row.status).toBe('not_configured')
    expect(row.issuable).toBe(0)             // nothing can be written here
  })
})

describe('RD-BIB-UX-02 · the badge tells the six states apart', () => {
  const row = (over: Partial<Parameters<typeof buildPlanRow>[0]>) => buildPlanRow({
    passId: 'p', passName: 'P', ranges: [{ start: 1, end: 100 }],
    capacityKind: 'finite', capacity: 100, available: 50,
    participants: { value: 100 }, alreadyAssigned: { value: 50 },
    willAssign: { value: 50, status: 'known', reason: null },
    nextValue: 51, blockers: [], poolCount: 1, ...over,
  })

  it('a pass everyone on which already holds one is COMPLETE, not "needs configuration"', () => {
    // The exhausted-range blocker used to make this read as broken. It is finished.
    const done = row({
      willAssign: { value: 0, status: 'known', reason: null },
      available: 0, blockers: ['POOL_EXHAUSTED'],
    })
    expect(done.status).toBe('complete')
    expect(PLAN_STATUS_LABEL[done.status]).toBe('Complete')
    expect(PLAN_STATUS_TONE[done.status]).toBe('verify')
  })

  it('a short range is SHORT, and names how short', () => {
    const short = row({ willAssign: { value: 400, status: 'known', reason: null }, available: 310 })
    expect(short.status).toBe('short')
    expect(short.shortBy).toBe(90)
    expect(short.issuable).toBe(310)      // what a run would actually write
    expect(PLAN_STATUS_LABEL[short.status]).toBe('Not enough numbers')
  })

  it('an uncountable pass is CANNOT VERIFY, never zero and never ready', () => {
    const unk = row({ willAssign: { value: null, status: 'unavailable', reason: 'why' } })
    expect(unk.status).toBe('unknown')
    expect(unk.willAssign).toBeNull()
    expect(unk.issuable).toBeNull()
  })

  it('a countable pass with room is READY', () => {
    expect(row({}).status).toBe('ready')
    expect(row({}).issuable).toBe(50)
  })

  it('every state has a label and a tone', () => {
    for (const s of ['not_configured', 'complete', 'blocked', 'unknown', 'short', 'ready'] as const) {
      expect(PLAN_STATUS_LABEL[s]).toBeTruthy()
      expect(PLAN_STATUS_TONE[s]).toBeTruthy()
    }
  })
})

describe('RD-BIB-UX-02 · the confirmation promises only what the range can keep', () => {
  const short = buildPlanRow({
    passId: 'p5', passName: '5 KM', ranges: [{ start: 5001, end: 5310 }],
    capacityKind: 'finite', capacity: 310, available: 310,
    participants: { value: 400 }, alreadyAssigned: { value: 0 },
    willAssign: { value: 400, status: 'known', reason: null },
    nextValue: 5001, blockers: [], poolCount: 1,
  })

  it('the button carries what will be WRITTEN, not what is needed', () => {
    // 400 people need one; the range holds 310. "Assign 400" would be a lie.
    expect(assignButtonLabel([short], 'BIB Number')).toBe('Assign 310 BIB Numbers')
  })

  it('the first button still only previews', () => {
    expect(previewButtonLabel([short], 'BIB Number')).toBe('Preview BIB Number assignment')
  })

  it('the shortfall is stated as three figures, not buried in a sentence', () => {
    expect(TAB).toContain('Not enough {label}s')
    expect(TAB).toContain('>Need</dt>')
    expect(TAB).toContain('>Available</dt>')
    expect(TAB).toContain('>Short by</dt>')
  })
})

describe('RD-BIB-UX-02 · one row of totals, one set of rows', () => {
  it('every total is summed over planRows — never a mix of two row sets', () => {
    // The bug: participants came from `runnableRows` while "already assigned" came
    // from the preview totals over EVERY scope, so a finished pass produced
    // 800 participants and 870 already assigned on the same line.
    expect(TAB).toContain('participants:    known(planRows.map(r => r.participants)),')
    expect(TAB).toContain('alreadyAssigned: known(planRows.map(r => r.alreadyAssigned)),')
    expect(TAB).toContain('willAssign:      known(planRows.map(r => r.willAssign)),')
    expect(TAB).toContain('issuable:        known(planRows.map(r => r.issuable)),')
    expect(TAB).not.toContain('value={n(preview.totals.alreadyAssigned.value)}')
  })

  it('an unconfigured pass is described in range words, never as a pool', () => {
    expect(DEC).toContain('No number range is configured for this pass')
    expect(DEC).not.toContain('No pool is configured to serve this pass')
    expect(TAB).not.toContain('Add a pool that covers this pass first')
  })

  it('a pass with no range says "Not configured", never "No limit set"', () => {
    // "No limit" says the opposite of the truth: not unlimited numbers, but none.
    expect(TAB).toContain("row.configured ? 'No limit set' : 'Not configured'")
  })
})

describe('RD-BIB-UX-02 · the article follows the configured label', () => {
  it('a consonant takes "a", a vowel takes "an"', () => {
    // An event whose numbers are called "Entry Number" read "Need a Entry Number"
    // on every card, because the article was written into the copy and the noun is
    // configuration.
    expect(article('BIB Number')).toBe('a')
    expect(article('Delegate Number')).toBe('a')
    expect(article('Entry Number')).toBe('an')
    expect(article('Attendee Number')).toBe('an')
    expect(article('  Exhibitor Pass ')).toBe('an')
  })
})

describe('RD-BIB-UX-02 · a short range still knows where it stops', () => {
  it('the last number is named, because the arithmetic is available', () => {
    // 30 people, a range of 20. The run reaches 10020, and saying "Unknown" there
    // is refusing to answer a question the system can answer.
    const short = buildPlanRow({
      passId: 'ph', passName: 'Half', ranges: [{ start: 10001, end: 10020 }],
      capacityKind: 'finite', capacity: 20, available: 20,
      participants: { value: 30 }, alreadyAssigned: { value: 0 },
      willAssign: { value: 30, status: 'known', reason: null },
      nextValue: 10001, blockers: [], poolCount: 1,
    })
    expect(short.issuable).toBe(20)
    expect(short.expectedLast).toBe(10020)
    expect(short.shortBy).toBe(10)
  })

  it('a run that would cross a configured gap still refuses to name an end', () => {
    const gapped = buildPlanRow({
      passId: 'pg', passName: 'Gapped',
      ranges: [{ start: 5001, end: 5010 }, { start: 7000, end: 7500 }],
      capacityKind: 'finite', capacity: 511, available: 511,
      participants: { value: 50 }, alreadyAssigned: { value: 0 },
      willAssign: { value: 50, status: 'known', reason: null },
      nextValue: 5001, blockers: [], poolCount: 1,
    })
    expect(gapped.crossesGap).toBe(true)
    expect(gapped.expectedLast).toBeNull()   // it depends on where the blocks sit
  })
})

describe('RD-BIB-UX-02 · an empty pass is empty, not finished', () => {
  it('zero participants is reported as zero participants', () => {
    // "Everyone on this pass already has a BIB Number" is vacuously true of an empty
    // pass and reads as though people had been served. Both the plan card and the
    // review now say what actually happened.
    expect(TAB).toContain("? 'Nobody has registered for this pass yet.'")
    expect(TAB).toContain("? 'Nobody has registered for this pass yet — nothing will be assigned.'")
  })

  it('an empty pass still counts as COMPLETE for the badge, having nothing to do', () => {
    const empty = buildPlanRow({
      passId: 'pe', passName: 'Empty', ranges: [{ start: 1, end: 10 }],
      capacityKind: 'finite', capacity: 10, available: 10,
      participants: { value: 0 }, alreadyAssigned: { value: 0 },
      willAssign: { value: 0, status: 'known', reason: null },
      nextValue: 1, blockers: [], poolCount: 1,
    })
    expect(empty.status).toBe('complete')
    expect(empty.issuable).toBe(0)
    expect(empty.participants).toBe(0)
  })
})

describe('RD-BIB-UX-02 · the reason an organizer reads is written for an organizer', () => {
  it('an uncounted pass gets a sentence, not the architecture note', () => {
    // UNASSIGNED_UNKNOWN_REASON explains denormalized flags and counter soundness.
    // It is correct, and it was being printed on the plan card.
    expect(STATS).toContain('passScopes: summarizePassScopes(pools, ctx, PASS_NOT_COUNTED_REASON')
    expect(STATS).not.toContain('summarizePassScopes(pools, ctx, UNASSIGNED_UNKNOWN_REASON')
  })

  it('the engineering note still stands where an API reader sees it', () => {
    expect(STATS).toContain('unassignedReason:   UNASSIGNED_UNKNOWN_REASON')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// RD-BIB-UX-04 · manual and bulk, in the organizer's vocabulary and with the same
// confirmation discipline as the automatic run.
// ═══════════════════════════════════════════════════════════════════════════════

const SHELL_TABS = code(read('lib/events/eventTabs.ts'))
const BIBS_ROUTE = code(read('app/api/organizer/events/[eventId]/bibs/route.ts'))
const BULK_ROUTE = code(read('app/api/organizer/events/[eventId]/identifiers/bulk/route.ts'))
const DETAIL_RT  = code(read('app/api/organizer/events/[eventId]/route.ts'))

describe('RD-BIB-UX-04 · the shell and the workspace agree on the noun', () => {
  it('the tab list stays event-type NEUTRAL — the noun arrives as data', () => {
    for (const w of [/\bbib\b/i, /\bmarathon/i, /\brunner/i, /\brace\b/i, /\bfinisher/i]) {
      expect(SHELL_TABS, String(w)).not.toMatch(w)
    }
  })

  it('the rename is a pure function over the canonical list', () => {
    expect(SHELL_TABS).toContain('export function applyIdentifierLabel')
    expect(SHELL_TABS).toContain("t.key === 'sports'")
  })

  it('the label is read once, server-side, and fails safe', () => {
    expect(DETAIL_RT).toContain('identifierLabel?: string | null')
    // A reused domain function, not a hand-rolled read.
    expect(DETAIL_RT).toContain('resolveIdentifierConfig(slug)')
    // Any failure yields null and the tab keeps its generic label.
    expect(DETAIL_RT).toContain('.catch(() => null)')
    // Issued alongside reads the route already makes — not a second round trip.
    // (RD-EVENT-COMMERCE-01 appended one more parallel read — the enforced capacity — to the
    // SAME batch, so the label is still not a second round trip.)
    // (RD-EVENT-COMMERCE-04A removed the retired Free-tier capacity read from that batch.)
    expect(DETAIL_RT).toMatch(/const \[stats, donations, identifierLabel(, \w+)*\] = await Promise\.all/)
  })
})

describe('RD-BIB-UX-04 · manual assignment names the number and checks it first', () => {
  const ROW = TAB.slice(TAB.indexOf('function ParticipantRow'), TAB.indexOf('function BulkSection'))

  it('the engine words are gone from what the organizer reads', () => {
    expect(ROW).not.toContain('Choose value')
    expect(ROW).not.toContain('>Value<')
    // "Release" is the engine's verb; the button now says what it does.
    expect(ROW).toContain('Remove {label}')
    expect(ROW).not.toMatch(/>\s*Release\s*</)
  })

  it('a row states the participant, the number and the operational status', () => {
    expect(ROW).toContain('Not assigned')
    expect(ROW).toContain('Assigned')
    expect(ROW).toContain('Needs {article(label)} {label}')
  })

  it('availability is checked through the EXISTING bounded lookup, one value at a time', () => {
    expect(ROW).toContain('`${base}/lookup?value=${encodeURIComponent(v)}`')
    // Never a listing of the whole range to populate a picker.
    expect(ROW).not.toContain('/bibs?')
    expect(ROW).not.toMatch(/for \(let i = .*start.*end/)
  })

  it('the range check reuses the server rule, and unknown is never a refusal', () => {
    expect(ROW).toContain('isAllowedNumber(range.ranges, v) !== false')
    expect(TAB).toContain('allowedNumbersForPass')
  })

  it('Assign is unavailable until the number is in range AND free', () => {
    expect(ROW).toContain('const canSubmit = !!v && inRange && fresh?.free === true && !checking')
    // A result for a previous keystroke never counts.
    expect(ROW).toContain('const fresh = check && check.value === v ? check : null')
  })

  it('the confirmation names the number, and a change names what it replaces', () => {
    expect(ROW).toContain('`Assign ${label} ${v}?`')
    expect(ROW).toContain('will be replaced by')
    expect(ROW).toContain('recorded in this participant')
  })

  it('losing a race is explained, never shown as a raw error', () => {
    expect(ROW).toContain('is no longer available. Please choose another number.')
  })

  it('removal explains what survives it', () => {
    expect(ROW).toContain('Remove ${label} ${reg.bibNumber}?')
    expect(ROW).toContain('stays recorded in the timeline')
  })

  it('the pass is identified by its ID, not by matching organizer text', () => {
    expect(BIBS_ROUTE).toContain('passId:      string | null')
    expect(BIBS_ROUTE).toContain("'passName', 'passId'")
    expect(ROW).toContain('rangeFor(reg.passId)')
  })
})

describe('RD-BIB-UX-04 · bulk is a workflow, and only step four writes', () => {
  const BULK = TAB.slice(TAB.indexOf('function BulkSection'))

  it('the four steps are named and shown', () => {
    for (const s of ['Upload', 'Validate', 'Review', 'Confirm']) expect(BULK).toContain(`title: '${s}'`)
    expect(BULK).toContain("aria-current={i === activeIndex ? 'step' : undefined}")
  })

  it('every row is triaged into valid / warning / invalid, and none is dropped', () => {
    expect(TAB).toContain('function triageBulkRows')
    const t = TAB.slice(TAB.indexOf('function triageBulkRows'), TAB.indexOf('const VERDICT_TONE'))
    // A map, not a filter — the output has one entry per input row.
    expect(t).toContain('results.map(')
    expect(t).not.toContain('.filter(')
  })

  it('a participant who already holds one is a WARNING that states the consequence', () => {
    expect(TAB).toContain('running this replaces it')
  })

  it('an invalid row blocks the run — partial data cannot be assigned by accident', () => {
    expect(BULK).toContain('const blocked = counts.invalid > 0')
    expect(BULK).toContain('Fix invalid rows')
    expect(BULK).toContain('cannot be assigned, so nothing will run')
  })

  it('the server verdict is taken first, and never overridden', () => {
    const t = TAB.slice(TAB.indexOf('function triageBulkRows'), TAB.indexOf('const VERDICT_TONE'))
    // A row the server refused is invalid, full stop — the browser never upgrades it.
    expect(t.indexOf('if (!r.ok)')).toBeGreaterThan(-1)
    expect(t.indexOf('if (!r.ok)')).toBeLessThan(t.indexOf('isAllowedNumber'))
    expect(t).not.toContain('validateRanges')   // no second rulebook is implemented here
  })

  it('an out-of-range value is caught BEFORE the run, not row-by-row during it', () => {
    // The server's preview checks only whether a value is already in use; the range
    // rule lives in the engine and fires at COMMIT as OUT_OF_RANGE. Previewing a file
    // of wrong-block numbers therefore reported "would assign" and then failed.
    const t = TAB.slice(TAB.indexOf('function triageBulkRows'), TAB.indexOf('const VERDICT_TONE'))
    expect(t).toContain('isAllowedNumber(range.ranges, r.value) === false')
    expect(t).toContain('is outside the range for')
    // It uses the pass the REGISTRATION is on, never a pass named in the file.
    expect(t).toContain('rangeFor(reg.passId)')
  })

  it('the pre-flight can only ever refuse — it never permits what the server would reject', () => {
    const t = TAB.slice(TAB.indexOf('function triageBulkRows'), TAB.indexOf('const VERDICT_TONE'))
    // The only verdict the range check can produce is `invalid`.
    const rangeBranch = t.slice(t.indexOf('isAllowedNumber'), t.indexOf('if (reg?.bibNumber)'))
    expect(rangeBranch).toContain("verdict: 'invalid'")
    expect(rangeBranch).not.toContain("verdict: 'valid'")
    // `isAllowedNumber` returns null for UNKNOWN; only an explicit false refuses.
    expect(t).toContain('=== false')
  })

  it('validate uses mode preview, and only the confirmation commits', () => {
    expect(BULK).toContain("void run('preview')")
    expect(BULK).toContain("await run('commit')")
    // The commit is reachable only from `commit()`, which confirms first.
    const commitFn = BULK.slice(BULK.indexOf('async function commit()'), BULK.indexOf('const STEPS'))
    expect(commitFn).toContain('await confirm(')
    expect(commitFn).toContain("if (ok) await run('commit')")
  })

  it('the confirmation states the count, the numbers and the replacement risk', () => {
    expect(BULK).toContain('Confirm bulk ${label} assignment')
    expect(BULK).toContain('You are about to assign ${willAssign}')
    expect(BULK).toContain('REPLACES those numbers')
    expect(BULK).toContain('cannot be undone in one step')
  })

  it('the result names WHO, not just a status word', () => {
    expect(BULK).toContain('byId.get(r.registrationId)')
    expect(BULK).toContain('{reg?.name ?? r.registrationId}')
  })

  it('the bulk API contract is untouched', () => {
    expect(BULK_ROUTE).toContain("const mode = body.mode === 'commit' ? 'commit' : 'preview'")
    expect(BULK_ROUTE).toContain('const MAX_ROWS = 500')
    // Preview still performs no write. The branch ends at its `continue`; a comment
    // cannot be the marker here because `code()` strips comments before matching.
    const start   = BULK_ROUTE.indexOf("if (mode === 'preview')")
    const preview = BULK_ROUTE.slice(start, BULK_ROUTE.indexOf('continue', start))
    expect(start).toBeGreaterThan(-1)
    expect(preview).not.toContain('allocateIdentifier')
    expect(preview).not.toContain('releaseIdentifier')
    // …and its only read is the existing bounded lookup.
    expect(preview).toContain('lookupIdentifier(')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// RD-BIB-TIMING-01 · a timing device requires an identifier.
//
// Two invalid states were reachable before this phase, both measured against the
// emulator rather than reasoned about:
//
//   • a device attached to a participant with NO identifier — accepted, and the
//     lock written with `identifierValue: null`;
//   • an identifier released from a participant carrying a device — leaving
//     `{ bib: null, tag: "CHIP-ORPHAN" }`.
//
// `REGISTRATION_HAS_NO_IDENTIFIER` had been declared in the error union since the
// beginning and thrown by nothing — the same shape of defect as `OUT_OF_RANGE` in
// RD-BIB-01: the rule was anticipated and never implemented.
// ═══════════════════════════════════════════════════════════════════════════════

const TAG_ENGINE = code(read('lib/identifiers/timingTagEngine.ts'))
const ID_ENGINE  = code(read('lib/identifiers/engine.ts'))
const TAGS_LIB   = code(read('lib/identifiers/timingTags.ts'))
const TAGS_ROUTE = code(read('app/api/organizer/events/[eventId]/identifiers/tags/route.ts'))
const CANCEL_RT  = code(read('app/api/organizer/registrations/[registrationId]/cancel/route.ts'))
const REFUND_RT  = code(read('app/api/organizer/registrations/[registrationId]/refund/route.ts'))

describe('RD-BIB-TIMING-01 · the invariant is enforced in the transaction', () => {
  it('the tag engine refuses a participant with no identifier', () => {
    expect(TAG_ENGINE).toContain("throw new TimingTagError('REGISTRATION_HAS_NO_IDENTIFIER')")
  })

  it('the refusal is INSIDE the transaction and BEFORE every write', () => {
    const fn = TAG_ENGINE.slice(TAG_ENGINE.indexOf('export async function assignTimingTag'))
    const txn   = fn.indexOf('runTransaction')
    const guard = fn.indexOf("REGISTRATION_HAS_NO_IDENTIFIER")
    const write = fn.indexOf('txn.set(newLockRef')
    expect(txn).toBeGreaterThan(-1)
    expect(guard).toBeGreaterThan(txn)     // inside the transaction
    expect(guard).toBeLessThan(write)      // before the first write
  })

  it('the check reads the STORED registration, never anything the caller supplied', () => {
    const fn = TAG_ENGINE.slice(TAG_ENGINE.indexOf('export async function assignTimingTag'))
    expect(fn).toContain('currentIdentifierValue(reg)')
    // `reg` is the transaction's own read of the registration document.
    expect(fn).toContain('const rSnap = await txn.get(regRef(input.registrationId))')
    // The input shape carries no identifier for a caller to spoof.
    const input = TAG_ENGINE.slice(TAG_ENGINE.indexOf('export interface AssignTagInput'),
                                   TAG_ENGINE.indexOf('export interface AssignTagResult'))
    expect(input).not.toMatch(/identifier|bib/i)
  })

  it('the identifier engine refuses to release while a device depends on it', () => {
    const fn = ID_ENGINE.slice(ID_ENGINE.indexOf('export async function releaseIdentifier'))
    expect(fn).toContain("IDENTIFIER_HELD_BY_TIMING_TAG")
    const txn   = fn.indexOf('runTransaction')
    const guard = fn.indexOf('currentTimingTag(reg)')
    const write = fn.indexOf('txn.update(rRef')
    expect(guard).toBeGreaterThan(txn)
    expect(guard).toBeLessThan(write)
  })

  it('both engines ask the SAME question — one reader, not two definitions', () => {
    expect(TAG_ENGINE).toContain('export function currentIdentifierValue')
    expect(TAG_ENGINE).toContain('export function currentTimingTag')
    expect(ID_ENGINE).toContain("import { currentTimingTag } from './timingTagEngine'")
  })

  it('the identifier reader honours the LEGACY mirror, so old events are not locked out', () => {
    const fn = TAG_ENGINE.slice(TAG_ENGINE.indexOf('export function currentIdentifierValue'),
                                TAG_ENGINE.indexOf('export function currentTimingTag'))
    expect(fn).toContain('reg.identifier')
    expect(fn).toContain('reg.bibNumber')
  })

  it('only an ASSIGNED tag blocks — a replaced or removed lock is history', () => {
    const fn = TAG_ENGINE.slice(TAG_ENGINE.indexOf('export function currentTimingTag'),
                                TAG_ENGINE.indexOf('export interface AssignTagInput'))
    expect(fn).toContain("t?.state === 'assigned'")
  })
})

describe('RD-BIB-TIMING-01 · the lifecycle paths still free the number', () => {
  it('cancellation and refund detach the device FIRST, then release explicitly', () => {
    for (const [name, src] of [['cancel', CANCEL_RT], ['refund', REFUND_RT]] as const) {
      expect(src, name).toContain('detachTimingTagByRegistration(registrationId')
      expect(src, name).toContain('allowWhileTagged: true')
      // The detach precedes the release, so the number is never stranded on a
      // participant who is no longer coming.
      expect(src.indexOf('detachTimingTagByRegistration')).toBeLessThan(src.indexOf('allowWhileTagged'))
    }
  })

  it('the escape hatch is opt-in — the default still refuses', () => {
    const fn = ID_ENGINE.slice(ID_ENGINE.indexOf('export async function releaseIdentifier'))
    expect(fn).toContain('if (!options.allowWhileTagged)')
    expect(fn).toContain('options: { allowWhileTagged?: boolean } = {}')
  })

  it('the organizer-facing release routes do NOT pass the escape hatch', () => {
    const idRoute = code(read('app/api/organizer/events/[eventId]/identifiers/route.ts'))
    const bulk    = code(read('app/api/organizer/events/[eventId]/identifiers/bulk/route.ts'))
    expect(idRoute).not.toContain('allowWhileTagged')
    expect(bulk).not.toContain('allowWhileTagged')
  })
})

describe('RD-BIB-TIMING-01 · the organizer is told, never shown a code', () => {
  it('the timing route translates the refusal into the event’s own two nouns', () => {
    expect(TAGS_ROUTE).toContain('REGISTRATION_HAS_NO_IDENTIFIER:')
    expect(TAGS_ROUTE).toContain('to this participant before assigning')
    // The code travels alongside for the client; the message is a sentence.
    expect(TAGS_ROUTE).toContain('code: err.code')
  })

  it('the reverse refusal is a 409 state conflict, not a 400', () => {
    const idRoute = code(read('app/api/organizer/events/[eventId]/identifiers/route.ts'))
    expect(idRoute).toContain('IDENTIFIER_HELD_BY_TIMING_TAG: 409')
  })

  it('the refusal message names the device, so the next step is obvious', () => {
    const fn = ID_ENGINE.slice(ID_ENGINE.indexOf('export async function releaseIdentifier'))
    expect(fn).toContain('Remove it before removing their number.')
  })
})

describe('RD-BIB-TIMING-01 · readiness counts BOTH gaps', () => {
  const ready = (over: Partial<Parameters<typeof resolveTagReadiness>[0]> = {}) =>
    resolveTagReadiness({
      eligible: 600, identified: 600, mapped: 600,
      config: { enabled: true, mode: 'mapped', label: 'Timing Chip' } as never,
      identifierLabel: 'BIB Number', ...over,
    })

  it('every device attached AND every identifier issued is READY', () => {
    const r = ready()
    expect(r.state).toBe('complete')
    expect(r.blockedByIdentifier).toBe(0)
  })

  it('devices all attached but identifiers missing is NOT ready', () => {
    // The gap `eligible` was passed in for and the function used to ignore.
    const r = ready({ eligible: 620, identified: 600, mapped: 600 })
    expect(r.state).toBe('blocked_by_identifier')
    expect(r.blockedByIdentifier).toBe(20)
    expect(r.label).toBe('BIB Number required')
    expect(r.explanation).toMatch(/20 participants cannot receive one yet/)
  })

  it('a partial mapping names both shortfalls in one sentence', () => {
    const r = ready({ eligible: 620, identified: 600, mapped: 540 })
    expect(r.state).toBe('partial')
    expect(r.missing).toBe(60)
    expect(r.blockedByIdentifier).toBe(20)
    expect(r.explanation).toMatch(/540 of 600/)
    expect(r.explanation).toMatch(/20 participants cannot receive one yet/)
  })

  it('an unknown count yields null, never a fabricated zero', () => {
    expect(ready({ eligible: null }).blockedByIdentifier).toBeNull()
    expect(ready({ identified: null }).blockedByIdentifier).toBeNull()
    expect(ready({ mapped: null }).state).toBe('unknown')
  })

  it('more identified than eligible floors at zero rather than going negative', () => {
    expect(ready({ eligible: 10, identified: 20, mapped: 20 }).blockedByIdentifier).toBe(0)
  })

  it('the noun is CONFIGURATION — no event-type vocabulary in the verdict', () => {
    const r = resolveTagReadiness({
      eligible: 40, identified: 20, mapped: 20,
      config: { enabled: true, mode: 'mapped', label: 'Timing Band' } as never,
      identifierLabel: 'Delegate Number',
    })
    expect(r.label).toBe('Delegate Number required')
    expect(r.explanation).toContain('Delegate Number')
    expect(r.explanation).not.toMatch(/\bbib\b/i)
  })

  it('the module carries no event-type vocabulary of its own', () => {
    // The COLUMN-ALIAS list is excluded on purpose: it matches headers organizers
    // type into their own spreadsheets ("bib", "bibno"), which is input tolerance,
    // not product vocabulary — the same reason RaceOps accepts `chipid`. Nothing
    // there is ever shown back to the reader.
    const prose = TAGS_LIB.split('\n')
      .filter(l => !/'bib'|'bibno'|'bibnumber'|'bibnum'/.test(l))
      .join('\n')
    for (const w of [/\bbib\b/i, /\bmarathon/i, /\brunner/i, /\bfinisher/i]) {
      expect(prose, String(w)).not.toMatch(w)
    }
  })
})

describe('RD-BIB-TIMING-01 · the three credentials stay separate', () => {
  it('the device never becomes the check-in credential', () => {
    const scan = code(read('app/api/checkin/scan/route.ts'))
    expect(scan).not.toContain('timingTag')
    expect(scan).not.toContain('identifierTagLocks')
  })

  it('the tag engine writes only its own lock collection', () => {
    expect(TAG_ENGINE).toContain("export const TIMING_TAG_LOCKS = 'identifierTagLocks'")
    // It never writes an identifier lock — the two authorities stay apart.
    expect(TAG_ENGINE).not.toContain("collection('identifierLocks')")
  })

  it('the identifier engine never writes a tag lock either', () => {
    expect(ID_ENGINE).not.toContain('identifierTagLocks')
    // It only READS the mirror, through the shared helper.
    expect(ID_ENGINE).toContain('currentTimingTag(reg)')
  })

  it('RaceOps result ingestion was not touched', () => {
    expect(read('features/race-operations/import/mapping/aliases.ts'))
      .toContain("'chipid', 'startnumber', 'startno', 'no',")
  })
})

describe('RD-BIB-TIMING-01 · the provider file marks what it cannot map', () => {
  const EXPORT = code(read('app/api/organizer/events/[eventId]/identifiers/tags/export/route.ts'))

  it('every row carries a status, so a blank cell is never left to interpretation', () => {
    expect(EXPORT).toContain("'Category', 'Status',")
    expect(EXPORT).toContain('const status = !hasIdentifier ?')
    expect(EXPORT).toContain("'Ready'")
  })

  it('a participant with no identifier is MARKED, not dropped and not invented', () => {
    expect(EXPORT).toContain('`Needs ${config.label}`')
    // No fabricated placeholder ever enters the identifier column.
    expect(EXPORT).not.toContain("'UNKNOWN'")
    expect(EXPORT).not.toContain("'—'")
    expect(EXPORT).toContain("hasIdentifier ? identifier : ''")
  })

  it('the file still carries no contact details', () => {
    expect(EXPORT).not.toContain("'email'")
    expect(EXPORT).not.toContain("'phone'")
    expect(EXPORT).toContain(".select('attendee', 'passName', 'identifier', 'timingTag', 'bibCategory')")
  })
})
