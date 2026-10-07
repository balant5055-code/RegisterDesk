// RD-EVENT-19D — Identifier configuration & assignment planning.
//
// THE RULE. The screen may only claim what the data supports. "286 remaining" that
// turns out to be a guess is worse than "we cannot tell you yet", because an
// organizer prints these and cannot take them back.
//
// What is pinned here, and why each matters:
//   1. TWO RANGES ARE TWO RANGES. 5001–5999 + 7000–7500 is 1500 identifiers, never
//      2500, and the gap is named as a gap rather than shown as capacity.
//   2. NO METER FOR AN UNKNOWN, and none for unlimited. A bar is a claim about a
//      proportion; neither of those has one.
//   3. READINESS is provable or it is a warning. "Not enough" is only said when it
//      is certain, and "ready" only when it is certain.
//   4. The one derivation that IS sound — a LOWER BOUND on who still needs one — is
//      labelled as a minimum, and the exact figure stays unknown beside it.
//   5. The editor validates with the SERVER'S validator, so it cannot accept a
//      configuration the API rejects.
//   6. NO EVENT-TYPE VOCABULARY. The identifier's name is configuration.

import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

vi.mock('@/lib/firebase/admin', () => ({ adminDb: {} }))

import {
  rangeGaps, totalRangeCapacity, minimumStillNeeding, resolveReadiness, poolCard,
  resolveIdentifierStatus, identifierStatusHeadline, IDENTIFIER_STATUS_TONE,
  validateRangeDraft, blockerCopy, BLOCKER_COPY,
  type ReadinessInput, type RangeDraftRow,
} from '@/lib/identifiers/identifierWorkspace'
import { validateRanges } from '@/lib/identifiers/ranges'
import type { IdentifierPoolStat } from '@/lib/identifiers/statistics'

// ─── Source helpers ─────────────────────────────────────────────────────────

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

const WS    = code(read('lib/identifiers/identifierWorkspace.ts'))
const TAB   = code(read('app/(dashboard)/dashboard/events/[eventId]/tabs/SportsTab.tsx'))
const ROUTE = code(read('app/api/organizer/events/[eventId]/identifiers/route.ts'))

// ─── Fixtures ───────────────────────────────────────────────────────────────

const stat = (over: Partial<IdentifierPoolStat> = {}): IdentifierPoolStat => ({
  poolId: 'p', label: 'Pool', identifierLabel: 'Bib Number', isDefault: false,
  prefix: '', padding: 0, rangeStart: null, rangeEnd: null,
  ranges: [{ start: 1, end: 100 }], passIds: null, matchRuleBy: null,
  capacityKind: 'finite', capacity: 100, nextNumber: 11,
  assigned: 10, consumed: 0, reserved: 0, blocked: 0, retired: 0, released: 0,
  occupied: 10, available: 90, utilization: 0.1,
  state: 'available', stateReason: null, orphanedPassIds: [],
  ...over,
})

const readiness = (over: Partial<ReadinessInput> = {}): ReadinessInput => ({
  configured: true,
  gate: { open: true, detail: null },
  summary: {
    configuredCapacity: 1500, available: 300, assigned: 1200,
    poolsTotal: 2, poolsExhausted: 0, poolsUnavailable: 0,
    poolsOrphaned: 0, poolsInconsistent: 0, capacityKind: 'finite',
  },
  eligible: 1400,
  label: 'Bib Number',
  ...over,
})

// ════════════════════════════════════════════════════════════════════════════
// 1 — RANGES AND GAPS
// ════════════════════════════════════════════════════════════════════════════

describe('1 — two ranges are two ranges', () => {
  const TWO = [{ start: 5001, end: 5999 }, { start: 7000, end: 7500 }]

  it('capacity is the SUM, never the span', () => {
    expect(totalRangeCapacity(TWO)).toBe(1500)
    expect(totalRangeCapacity(TWO)).not.toBe(2500)
    expect(totalRangeCapacity(TWO)).not.toBe(7500 - 5001 + 1)
  })

  it('the gap is named, and it is exactly the untouched numbers', () => {
    expect(rangeGaps(TWO)).toEqual([{ start: 6000, end: 6999 }])
  })

  it('adjacent ranges leave NO gap', () => {
    expect(rangeGaps([{ start: 1, end: 100 }, { start: 101, end: 200 }])).toEqual([])
  })

  it('a single range has no gap', () => {
    expect(rangeGaps([{ start: 5001, end: 6500 }])).toEqual([])
    expect(rangeGaps([])).toEqual([])
  })

  it('three ranges report both gaps', () => {
    expect(rangeGaps([{ start: 1, end: 9 }, { start: 20, end: 29 }, { start: 40, end: 49 }]))
      .toEqual([{ start: 10, end: 19 }, { start: 30, end: 39 }])
  })

  it('unsorted input still yields the right gap', () => {
    expect(rangeGaps([{ start: 7000, end: 7500 }, { start: 5001, end: 5999 }]))
      .toEqual([{ start: 6000, end: 6999 }])
  })

  it('a gap is never added to capacity', () => {
    const gapSize = rangeGaps(TWO).reduce((s, g) => s + (g.end - g.start + 1), 0)
    expect(gapSize).toBe(1000)
    expect(totalRangeCapacity(TWO) + gapSize).toBe(2500)   // …which is the number NOT shown
  })

  it('the arithmetic is 19A\'s, not a second implementation', () => {
    expect(WS).toContain("from './ranges'")
    expect(WS).toContain('rangeCapacity')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 2 — THE ONE SOUND DERIVATION
// ════════════════════════════════════════════════════════════════════════════

describe('2 — a lower bound is not a guess', () => {
  it('1,400 eligible and 1,200 assigned means AT LEAST 200 still need one', () => {
    expect(minimumStillNeeding(1400, 1200)).toBe(200)
  })

  it('more assigned than eligible floors at zero, never negative', () => {
    expect(minimumStillNeeding(100, 250)).toBe(0)
  })

  it('an unknown input makes the bound unknown', () => {
    expect(minimumStillNeeding(null, 10)).toBeNull()
    expect(minimumStillNeeding(10, null)).toBeNull()
    expect(minimumStillNeeding(null, null)).toBeNull()
  })

  // ═══ RD-BIB-UX-03 · this contract CHANGED, and the tests changed with it ════
  //
  // The two tests that stood here asserted that the tab prints "At least still
  // needing one" beside an explicit "Exact number — Not countable yet". That was
  // correct while it was true: RD-EVENT-19B could not join "is eligible" to "holds
  // one", so a floor was the most honest thing available.
  //
  // RD-BIB-UX-02 made `hasIdentifier` a field every registration is born with, so
  // each pass now reports an EXACT count and their sum is exact. Keeping the old
  // assertions would have pinned the product to telling an organizer it cannot
  // answer a question it answers on the same screen — the tests would have been
  // enforcing a lie. They are re-pinned to the rule that outlived them: a BOUND is
  // never presented as the answer.

  it('the floor is still a floor, and still says so when it is used', () => {
    // The fallback path for an event whose passes cannot all be counted yet.
    const s = resolveIdentifierStatus({
      configured: true, hasAnyRange: true,
      scopes: [{ participants: 600, assigned: 290, need: null }],   // one uncountable pass
      eligible: 600, assignedLocks: 290,
      capacity: 600, capacityKind: 'finite', available: 310,
    })
    expect(s.need).toBe(310)
    expect(s.needBasis).toBe('minimum')       // a bound, and labelled as one
    expect(s.shortBy).toBeNull()              // never claimed from a bound
    expect(TAB).toContain('(at least)')
  })

  it('an exact count is reported as exact, not hedged', () => {
    const s = resolveIdentifierStatus({
      configured: true, hasAnyRange: true,
      scopes: [
        { participants: 600, assigned: 290, need: 310 },
        { participants: 200, assigned: 180, need: 20 },
      ],
      eligible: 800, assignedLocks: 470,
      capacity: 800, capacityKind: 'finite', available: 330,
    })
    expect(s.participants).toBe(800)
    expect(s.assigned).toBe(470)
    expect(s.need).toBe(330)
    expect(s.needBasis).toBe('exact')
  })

  it('the tab no longer claims the exact number cannot be established', () => {
    expect(TAB).not.toContain('Not countable yet')
    expect(TAB).not.toContain('cannot be\n            established')
    expect(TAB).not.toContain('guarantee, not an estimate')
  })

  it('the floor helper itself is unchanged and still used by the status model', () => {
    expect(WS).toContain('minimumStillNeeding')
    expect(TAB).not.toMatch(/remaining[^\n]*eligible\s*-\s*assigned/i)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 3 — READINESS
// ════════════════════════════════════════════════════════════════════════════

describe('3 — readiness is provable, or it is a warning', () => {
  it('READY only when there are enough for every eligible participant', () => {
    const r = resolveReadiness(readiness({ summary: { ...readiness().summary, available: 1500 } }))
    expect(r.state).toBe('ready')
    expect(r.explanation).toContain('1,500')
    expect(r.explanation).toContain('1,400')
  })

  it('INSUFFICIENT only when it is certain — the brief\'s own example', () => {
    // 100 available, 180 eligible, none assigned ⇒ at least 180 need one.
    const r = resolveReadiness(readiness({
      eligible: 180,
      summary: { ...readiness().summary, available: 100, assigned: 0, configuredCapacity: 100 },
    }))
    expect(r.state).toBe('insufficient')
    expect(r.explanation).toContain('100')
    expect(r.explanation).toContain('180')
  })

  it('WARNING when it might be enough but the need is not countable', () => {
    // 300 available, 1400 eligible, 1200 assigned ⇒ at least 200 need one, and 300 ≥ 200.
    const r = resolveReadiness(readiness())
    expect(r.state).toBe('warning')
    expect(r.explanation).toMatch(/cannot be counted/i)
  })

  it('UNKNOWN when usage could not be read — never "0 available"', () => {
    const r = resolveReadiness(readiness({
      summary: { ...readiness().summary, assigned: null, available: null, poolsUnavailable: 1 },
    }))
    expect(r.state).toBe('unknown')
    expect(r.explanation).not.toMatch(/\b0\b/)
  })

  it('CONFLICT outranks a capacity verdict', () => {
    const r = resolveReadiness(readiness({
      summary: { ...readiness().summary, poolsOrphaned: 1, available: 0 },
    }))
    expect(r.state).toBe('conflict')
    expect(r.explanation).toMatch(/no longer has/)
  })

  it('an over-capacity pool is a conflict, and says so', () => {
    const r = resolveReadiness(readiness({
      summary: { ...readiness().summary, poolsInconsistent: 1 },
    }))
    expect(r.state).toBe('conflict')
    expect(r.explanation).toMatch(/more bib numbers than its ranges allow/i)
  })

  it('LOCKED outranks everything except configuration', () => {
    const r = resolveReadiness(readiness({
      gate: { open: false, detail: 'This event is archived, so identifiers are read-only.' },
      summary: { ...readiness().summary, poolsOrphaned: 1 },
    }))
    expect(r.state).toBe('locked')
    expect(r.explanation).toContain('archived')
  })

  it('NOT CONFIGURED outranks everything', () => {
    expect(resolveReadiness(readiness({ configured: false, gate: { open: false, detail: 'x' } })).state)
      .toBe('not_configured')
  })

  it('every pool exhausted is insufficient', () => {
    const r = resolveReadiness(readiness({
      summary: { ...readiness().summary, poolsExhausted: 2, poolsTotal: 2, available: 0 },
    }))
    expect(r.state).toBe('insufficient')
  })

  it('an UNLIMITED pool is never "not enough" and never "ready"', () => {
    const r = resolveReadiness(readiness({
      summary: { ...readiness().summary, capacityKind: 'mixed', configuredCapacity: null, available: null },
    }))
    expect(r.state).toBe('warning')
    expect(['ready', 'insufficient']).not.toContain(r.state)
  })

  it('unknown eligibility downgrades to a warning rather than claiming ready', () => {
    const r = resolveReadiness(readiness({ eligible: null, summary: { ...readiness().summary, available: 99999 } }))
    expect(r.state).toBe('warning')
  })

  it('every state has a word AND a sentence — colour is never the only carrier', () => {
    const states: ReadinessInput[] = [
      readiness({ configured: false }),
      readiness({ gate: { open: false, detail: 'This event is archived, so identifiers are read-only.' } }),
      readiness({ summary: { ...readiness().summary, poolsOrphaned: 1 } }),
      readiness({ summary: { ...readiness().summary, assigned: null } }),
      readiness({ summary: { ...readiness().summary, available: 1500 } }),
      readiness(),
    ]
    for (const s of states) {
      const r = resolveReadiness(s)
      expect(r.label.length).toBeGreaterThan(2)
      expect(r.explanation.length).toBeGreaterThan(20)
      expect(r.explanation.trim().endsWith('.')).toBe(true)
    }
  })

  it('the copy uses the CONFIGURED name, not a built-in word', () => {
    const r = resolveReadiness(readiness({ label: 'Delegate ID', summary: { ...readiness().summary, poolsInconsistent: 1 } }))
    expect(r.explanation).toContain('delegate id')
    expect(r.explanation).not.toMatch(/\bbib\b/i)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 4 — POOL CARD
// ════════════════════════════════════════════════════════════════════════════

describe('4 — a pool card shows the mapping, and no meter it cannot justify', () => {
  const names = new Map([['5k', 'Five kilometre'], ['10k', 'Ten kilometre']])

  it('lists each range separately with its own count', () => {
    const c = poolCard(stat({ ranges: [{ start: 5001, end: 5999 }, { start: 7000, end: 7500 }], capacity: 1500 }), names)
    expect(c.ranges).toHaveLength(2)
    expect(c.capacity).toBe(1500)
    expect(c.gaps).toEqual([{ start: 6000, end: 6999 }])
  })

  it('names the passes it covers', () => {
    const c = poolCard(stat({ passIds: ['5k'] }), names)
    expect(c.passLabels).toEqual([{ id: '5k', name: 'Five kilometre', missing: false }])
    expect(c.unrestricted).toBe(false)
  })

  it('an unrestricted pool says so rather than showing an empty list', () => {
    expect(poolCard(stat({ passIds: null }), names).unrestricted).toBe(true)
  })

  it('a removed pass is flagged on the chip', () => {
    const c = poolCard(stat({ passIds: ['ghost'], orphanedPassIds: ['ghost'], state: 'orphaned' }), names)
    expect(c.passLabels[0].missing).toBe(true)
    expect(c.stateLabel).toBe('Pass removed')
    expect(c.stateTone).toBe('critical')
  })

  it('NO METER for an unlimited pool', () => {
    expect(poolCard(stat({ capacityKind: 'unlimited', capacity: null, available: null }), names).percent).toBeNull()
  })

  it('NO METER when usage is unknown', () => {
    expect(poolCard(stat({ occupied: null, assigned: null, available: null, state: 'unavailable' }), names).percent).toBeNull()
  })

  it('an over-capacity pool reports its REAL percentage, not a clamped 100', () => {
    const c = poolCard(stat({ capacity: 2, occupied: 3, assigned: 3, available: null, state: 'inconsistent' }), names)
    expect(c.percent).toBe(150)
    expect(c.stateLabel).toBe('Over capacity')
  })

  it('assigned counts held identifiers, and is unknown when either part is', () => {
    expect(poolCard(stat({ assigned: 10, consumed: 5 }), names).assigned).toBe(15)
    expect(poolCard(stat({ assigned: 10, consumed: null }), names).assigned).toBeNull()
  })

  it('a genuine zero stays a zero', () => {
    const c = poolCard(stat({ assigned: 0, consumed: 0, occupied: 0, available: 100, state: 'empty' }), names)
    expect(c.assigned).toBe(0)
    expect(c.percent).toBe(0)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 5 — RANGE EDITOR
// ════════════════════════════════════════════════════════════════════════════

describe('5 — the editor cannot accept what the server would reject', () => {
  const rows = (...pairs: Array<[string, string]>): RangeDraftRow[] =>
    pairs.map(([start, end], i) => ({ key: `r${i}`, start, end }))
  const run = (r: RangeDraftRow[]) => validateRangeDraft(r, validateRanges)

  it('accepts a custom start that is not 1', () => {
    const d = run(rows(['5001', '6500']))
    expect(d.ranges).toEqual([{ start: 5001, end: 6500 }])
    expect(d.capacity).toBe(1500)
  })

  it('accepts two ranges and reports the gap', () => {
    const d = run(rows(['5001', '5999'], ['7000', '7500']))
    expect(d.capacity).toBe(1500)
    expect(d.gaps).toEqual([{ start: 6000, end: 6999 }])
  })

  it('accepts adjacent ranges with no gap', () => {
    const d = run(rows(['1', '100'], ['101', '200']))
    expect(d.capacity).toBe(200)
    expect(d.gaps).toEqual([])
  })

  it('rejects OVERLAP using the server\'s own validator', () => {
    const d = run(rows(['5001', '6500'], ['6000', '7000']))
    expect(d.ranges).toBeNull()
    expect(d.setError).toMatch(/overlap/i)
  })

  it('rejects duplicates', () => {
    expect(run(rows(['1', '10'], ['1', '10'])).setError).toMatch(/twice/i)
  })

  it('reports a row problem against ITS row', () => {
    const d = run(rows(['500', '100']))
    expect(d.rowErrors.r0).toMatch(/must not be higher/i)
    expect(d.ranges).toBeNull()
  })

  it('rejects non-integers, NaN and Infinity', () => {
    expect(run(rows(['1.5', '10'])).rowErrors.r0).toBeTruthy()
    expect(run(rows(['abc', '10'])).rowErrors.r0).toBeTruthy()
    expect(run(rows(['Infinity', '10'])).rowErrors.r0).toBeTruthy()
    expect(run(rows(['1e5', '10'])).rowErrors.r0).toBeTruthy()
  })

  it('rejects negatives', () => {
    expect(run(rows(['-5', '10'])).rowErrors.r0).toMatch(/negative/i)
  })

  it('rejects a number too large to be exact', () => {
    expect(run(rows(['9007199254740993', '9007199254740999'])).rowErrors.r0).toMatch(/too large/i)
  })

  it('a blank row is not an error — it is simply not a range yet', () => {
    const d = run(rows(['', ''], ['1', '10']))
    expect(d.rowErrors).toEqual({})
    expect(d.ranges).toEqual([{ start: 1, end: 10 }])
  })

  it('an entirely empty editor means "no fixed range", not an error', () => {
    const d = run(rows(['', '']))
    expect(d.ranges).toEqual([])
    expect(d.capacity).toBe(0)
    expect(d.setError).toBeNull()
  })

  it('a single-number range is legal', () => {
    expect(run(rows(['42', '42'])).capacity).toBe(1)
  })

  it('the validator passed in IS the shared one', () => {
    expect(TAB).toContain('validateRangeDraft(rows, validateRanges')
    expect(TAB).toContain("from '@/lib/identifiers/ranges'")
    // …and the editor does not re-implement any of it.
    expect(TAB).not.toContain('function validateRanges')
    expect(TAB).not.toMatch(/overlap/i)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 6 — BLOCKER COPY
// ════════════════════════════════════════════════════════════════════════════

describe('6 — every refusal has a sentence, never a code', () => {
  it('covers every reason the decision model can return', () => {
    const DECIDE = code(read('lib/identifiers/assignmentDecision.ts'))
    const declared = DECIDE.slice(DECIDE.indexOf('export type DecisionReason'), DECIDE.indexOf('export type AssignmentAction'))
    const reasons = [...declared.matchAll(/'([A-Z_]+)'/g)].map(m => m[1])
    expect(reasons.length).toBeGreaterThan(15)
    for (const r of reasons) {
      expect(BLOCKER_COPY[r as keyof typeof BLOCKER_COPY], r).toBeTruthy()
    }
  })

  it('the copy is a sentence, not the code', () => {
    for (const [reason, copy] of Object.entries(BLOCKER_COPY)) {
      expect(copy).not.toContain(reason)
      expect(copy.trim().endsWith('.')).toBe(true)
      expect(copy[0]).toBe(copy[0].toUpperCase())
    }
  })

  it('an unrecognised code still yields a sentence, never a leak', () => {
    const c = blockerCopy('SOMETHING_NEW' as never)
    expect(c).not.toContain('SOMETHING_NEW')
    expect(c.endsWith('.')).toBe(true)
  })

  it('the tab renders the sentence, not the payload', () => {
    expect(TAB).toContain('blockerCopy')
    expect(TAB).not.toContain('JSON.stringify(err')
    expect(TAB).toContain('This workspace could not be loaded.')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 7 — EVENT-TYPE NEUTRALITY
// ════════════════════════════════════════════════════════════════════════════

describe('7 — the UI has no event-type vocabulary', () => {
  const SOURCES: Array<[string, string]> = [['workspace', WS], ['tab', TAB]]

  for (const [name, src] of SOURCES) {
    it(`${name} names no sport and no example distance`, () => {
      // `race-operations` is the MODULE the CSV/XLSX parsers live in — reusing that
      // provider is the point, and its path is not sports vocabulary in the UI.
      //
      // RD-BIB-TIMING-02 · RE-ANCHORED, deliberately and narrowly. The rule is
      // "the identifier is not a sport", and it still holds: nothing in this
      // workspace calls a participant a runner or a pass a distance. What changed
      // is that the workspace now names its DESTINATION — the Race Operations
      // module — because an organizer who has just issued numbers and devices had
      // no way to learn where they are used, which was the whole complaint. A
      // module's own proper name and its own route are not vocabulary about the
      // event; they are the name of a page in this product. Two exact tokens are
      // allowed, and nothing else: the literal title and the literal href. Any
      // other "race" in this file still fails.
      //
      // RD-BIB-TIMING-03 · the link moved out of the workflow strip (deleted) and
      // into the sequence's final step, so it is now JSX text rather than a
      // `title:` field. Same two tokens, same narrow allowance.
      const scrubbed = src
        .replace(/features\/race-operations[\w/-]*/g, 'X')
        .replace(/"\/dashboard\/race-operations"/g, 'X')
        .replace(/'\/dashboard\/race-operations'/g, 'X')
        .replace(/title: 'Race Operations'/g, 'X')
        .replace(/>\s*Race Operations\s*</g, '>X<')
      for (const word of [/\brunner/i, /\bmarathon/i, /\bfinisher/i, /\brace\b/i,
                          /\blane\b/i, /\bathlete/i, /\b5\s?km\b/i, /\b10\s?km\b/i]) {
        expect(scrubbed, `${name}: ${word}`).not.toMatch(word)
      }
    })
  }

  it('no "bib" appears as a product assumption', () => {
    // Allowed ONLY as: the legacy registration mirror fields the roster still uses,
    // and the /bibs endpoint path. Never as vocabulary the reader sees.
    const ALLOWED = /bibNumber|bibCategory|BibRegistration|BibSummaryResponse|\/bibs|events\/\$\{eventId\}\/bibs/
    for (const raw of TAB.split('\n')) {
      const line = raw.split('//')[0]
      if (!/bib/i.test(line)) continue
      expect(ALLOWED.test(line), line.trim()).toBe(true)
    }
    expect(WS).not.toMatch(/bib/i)
  })

  it('the visible name always comes from configuration', () => {
    expect(TAB).toContain('overview?.label')
    expect(TAB).toContain('{label}')
    // No literal identifier name is printed anywhere.
    expect(TAB).not.toMatch(/>\s*Bib Number\s*</)
    expect(TAB).not.toMatch(/'Delegate ID'|"Delegate ID"/)
  })

  it('the fallback name is generic', () => {
    expect(TAB).toContain("?? 'Identifier'")
  })

  it('no branch keys off an event category', () => {
    for (const [, src] of SOURCES) {
      expect(src).not.toContain('eventCategory')
      expect(src).not.toContain('eventType')
    }
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 8 — DESIGN TOKENS
// ════════════════════════════════════════════════════════════════════════════

describe('8 — the tab is built from the design system', () => {
  it('uses the typography tokens, not pixel literals', () => {
    expect(TAB).toContain('text-fs-')
    expect(TAB).not.toMatch(/text-\[\d+px\]/)
  })

  it('uses the radius tokens, not raw Tailwind radii', () => {
    expect(TAB).toMatch(/rounded-(control|surface|pill)/)
    expect(TAB).not.toContain('rounded-xl')
    expect(TAB).not.toContain('rounded-2xl')
  })

  it('uses the semantic accent system, not raw palette colours', () => {
    expect(TAB).toContain('accent(')
    for (const raw of [/bg-emerald-\d/, /bg-amber-\d/, /bg-red-\d/, /text-emerald-\d/,
                       /text-amber-\d/, /text-red-\d/, /bg-sky-\d/, /bg-rose-\d/]) {
      expect(TAB).not.toMatch(raw)
    }
  })

  it('draws no decorative chart — the only visual is a capacity meter', () => {
    expect(TAB).toContain('role="progressbar"')
    expect(TAB).not.toContain('<svg')
    expect(TAB).not.toContain('recharts')
  })

  it('the meter refuses to render without a proportion', () => {
    const meter = TAB.slice(TAB.indexOf('function Meter'), TAB.indexOf('function Metric'))
    expect(meter).toContain('percent === null')
    expect(meter).toContain('border-dashed')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 9 — ACCESSIBILITY (structural)
// ════════════════════════════════════════════════════════════════════════════

describe('9 — the workspace is operable without sight or a mouse', () => {
  it('the meter carries progressbar semantics and a name', () => {
    expect(TAB).toContain('role="progressbar"')
    expect(TAB).toContain('aria-valuenow')
    expect(TAB).toContain('aria-valuemin={0}')
    expect(TAB).toContain('aria-valuemax={100}')
    expect(TAB).toMatch(/aria-label=\{label\}/)
  })

  it('unknown and unlimited are readable, never a bare glyph', () => {
    // RD-BIB-UX-03 · the `Metric` component carried the second sr-only string
    // ("Unavailable") and no longer renders anywhere — the status card it existed
    // for was replaced. `Figure` is now the only unknown-bearing primitive, and it
    // still speaks. The affordance is intact; only the dead one is gone.
    expect(TAB).toContain('className="sr-only">Unknown<')
    expect(TAB).not.toContain('function Metric(')
    expect(TAB).toContain('No limit')
    // The infinity sign is not used as the sole carrier of meaning.
    expect(TAB).not.toContain('∞')
  })

  it('every input is labelled', () => {
    const inputs = (TAB.match(/<input /g) ?? []).length
    const labels = (TAB.match(/<label /g) ?? []).length
    expect(inputs).toBeGreaterThan(0)
    expect(labels).toBeGreaterThanOrEqual(inputs - 1)   // one search input uses aria-label
    // RD-BIB-UX-03 · the search label now names the configured identifier, so it is
    // a template literal rather than a fixed string. Still exactly one aria-label.
    //
    // RD-BIB-TIMING-02 · RE-ANCHORED. Search now also matches the device value —
    // "whose device is this?" is a question asked at a counter — so on an event
    // that HAS a second credential the label names it too. BOTH branches are
    // pinned, so neither can quietly stop naming what it actually searches.
    expect(TAB).toContain('`Search participants by name, email or ${label}`')
    expect(TAB).toContain('`Search participants by name, email, ${label} or ${rowTagLabel}`')
  })

  it('icon-only buttons are named', () => {
    for (const name of ['Close editor', 'Remove range', 'Dismiss result', 'Edit ', 'Delete ']) {
      expect(TAB).toContain(name)
    }
  })

  it('toggles expose pressed state, and tabs expose selection', () => {
    expect(TAB).toContain('aria-pressed=')
    expect(TAB).toContain('role="tab"')
    expect(TAB).toContain('aria-selected=')
    expect(TAB).toContain('role="tablist"')
  })

  it('sections are headed and associated', () => {
    expect(TAB).toContain('aria-labelledby=')
    expect(TAB).toMatch(/<h[234]/)
  })

  it('every control has a visible focus ring', () => {
    const controls = ['FIELD', 'GHOST_BTN', 'PRIMARY_BTN', 'ICON_BTN']
    for (const c of controls) {
      const decl = TAB.slice(TAB.indexOf(`const ${c} =`))
      expect(decl.slice(0, 400), c).toContain('focus-visible:ring')
    }
  })

  it('touch targets are at least 44px', () => {
    for (const c of ['GHOST_BTN', 'PRIMARY_BTN', 'ICON_BTN']) {
      const decl = TAB.slice(TAB.indexOf(`const ${c} =`), TAB.indexOf(`const ${c} =`) + 400)
      expect(decl, c).toMatch(/h-11|size-11/)
    }
  })

  it('status changes are announced', () => {
    expect(TAB).toContain('aria-live="polite"')
    expect(TAB).toContain('aria-busy="true"')
  })

  it('the loading state is a skeleton with a spoken label, not a bare spinner', () => {
    expect(TAB).toContain('animate-pulse')
    // RD-BIB-UX-03 · the spoken label used the event's configured noun.
    //
    // RD-BIB-TIMING-02 · RE-ANCHORED. That noun is not known until the workspace
    // has loaded, and until then `label` falls back to the internal word
    // "Identifier" — so this screen announced "Loading Identifiers…", teaching
    // the organizer a word that appears nowhere else in their event. The rule
    // (a spoken label, not a bare spinner) is unchanged; the label now names the
    // JOB rather than a guessed noun.
    expect(TAB).toContain('<span className="sr-only">Loading…</span>')
    expect(TAB).not.toContain('Loading {label}s…')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 10 — READ COST + LIFECYCLE + SECURITY (structural)
// ════════════════════════════════════════════════════════════════════════════

describe('10 — the workspace adds no reads and hides no refusals', () => {
  it('exactly two requests load the workspace', () => {
    const loader = TAB.slice(TAB.indexOf('const loadCore'), TAB.indexOf('useEffect(()'))
    expect((loader.match(/fetch\(/g) ?? []).length).toBe(2)
    expect(loader).toContain('Promise.all')
  })

  it('the planning PREVIEW fetches nothing — only a confirmed run writes', () => {
    // RD-EVENT-19E added execution to this section, so the section as a whole now
    // contains fetches. The property that still matters is narrower and unchanged:
    // computing the preview is pure, so choosing a pass costs no request.
    const preview = TAB.slice(TAB.indexOf('const preview = useMemo'), TAB.indexOf('const runnableScopes'))
    expect(preview).not.toContain('fetch(')
    expect(preview).toContain('buildAssignmentPreview')
    // Every fetch in the section is behind the confirmation.
    const plan = TAB.slice(TAB.indexOf('function PlanSection'), TAB.indexOf('function RunResult'))
    const firstFetch = plan.indexOf('fetch(')
    expect(plan.indexOf('await confirm({')).toBeLessThan(firstFetch)
  })

  it('there is no request per pass and no request per pool', () => {
    expect(TAB).not.toMatch(/passes\.map\([^)]*fetch/)
    expect(TAB).not.toMatch(/pools\.map\([^)]*fetch/)
    expect(TAB).not.toContain('all=true')
  })

  it('no polling — every timer is a one-shot, and none repeats', () => {
    // The property is that nothing on this screen re-queries on a clock.
    expect(TAB).not.toContain('setInterval')

    // RD-BIB-UX-04 · a second timer shape now exists: the manual-assignment input
    // DEBOUNCES its availability lookup by 350ms. A debounce is the opposite of
    // polling — it exists to make FEWER requests than keystrokes, it fires once,
    // and it is cleared on every change and on unmount. The rule this test guards
    // (no repeating timer, no clock-driven refetch) is unchanged; the assertion is
    // widened from "every timer is a mount defer" to "every timer is a one-shot".
    const total     = (TAB.match(/setTimeout\(/g) ?? []).length
    const deferred  = (TAB.match(/setTimeout\(\(\) => void [^\n]*?,\s*0\)/g) ?? []).length
    const debounced = total - deferred
    expect(total).toBeGreaterThan(0)
    // RD-BIB-TIMING-02 · RE-ANCHORED from 1 to 2, and RD-BIB-TIMING-03 to 3. Each
    // is the same shape for the same reason — an availability lookup that checks
    // one device against the lock before offering to write it — on the three
    // screens that can assign one: manual number assignment, the participant row,
    // and the Timing Chips workspace panel. All are one-shot, all are cleared
    // below, and none refetches on a clock. The exact count is asserted so a
    // RD-BIB-TIMING-04 · 3 → 4. The fourth is the Timing Chips workspace's
    // TARGETED SEARCH, which is a debounce for the same reason as the other
    // three: it makes fewer requests than keystrokes, fires once, is cleared on
    // every change, and additionally discards a stale reply by sequence number.
    // Still no clock-driven refetch anywhere. The exact count is asserted so a
    // FIFTH cannot appear unnoticed.
    expect(debounced).toBe(4)

    // EVERY timer is cleared, defer and debounce alike, so none can outlive its
    // effect and land on an unmounted component or a stale input.
    expect((TAB.match(/clearTimeout\(t\)/g) ?? []).length).toBe(total)
  })

  it('the pass list rides the request that was already being made', () => {
    expect(ROUTE).toContain('passes: scope.passes')
    const get = ROUTE.slice(ROUTE.indexOf('export async function GET'), ROUTE.indexOf('type Action'))
    expect((get.match(/await /g) ?? []).length).toBeLessThanOrEqual(3)
  })

  it('a locked event shows the reason and offers no executable action', () => {
    expect(TAB).toContain('gate.open')
    expect(TAB).toContain('!gate.open')
    expect(TAB).toContain('locked={!gate.open}')
    // Row actions are not rendered at all when locked.
    expect(TAB).toContain('{!locked && (')
  })

  it('the lifecycle verdict comes from the server, not from a second policy here', () => {
    expect(TAB).toContain('overview?.assignmentGate')
    // No EVENT lifecycle is judged in the browser. (`job.status === 'cancelled'`
    // in the run result is a JOB state reported by the server, not a policy.)
    expect(TAB).not.toMatch(/lifecycleStatus\s*===/)
    expect(TAB).not.toMatch(/lifecycle[^\n]*'archived'/)
  })

  it('allocation itself is never performed in the browser', () => {
    // RD-EVENT-19E ships execution, so the plan section now posts. What it must
    // never do is allocate: no locks, no counters, no range walking client-side —
    // it asks the server to run a job and reports what came back.
    const plan = TAB.slice(TAB.indexOf('function PlanSection'), TAB.indexOf('function RunResult'))
    for (const banned of ['identifierLocks', 'identifierCounters', 'nextNumberInRanges', 'formatIdentifier']) {
      expect(plan, banned).not.toContain(banned)
    }
    expect(plan).toContain('/assign-jobs')
  })

  it('the client sends no ownership claim', () => {
    expect(TAB).not.toMatch(/organizerUid/)
    expect(TAB).not.toMatch(/body:.*uid/)
    expect(TAB).toContain('Authorization: `Bearer ${token}`')
  })

  it('destructive actions confirm first', () => {
    expect(TAB).toContain('confirm({')
    expect(TAB).toContain("tone: 'danger'")
  })
})

// ════════════════════════════════════════════════════════════════════════════
// RD-BIB-UX-03 — THE AT-A-GLANCE STATUS
// ════════════════════════════════════════════════════════════════════════════

describe('RD-BIB-UX-03 · the status an organizer reads in five seconds', () => {
  const S = (over: Partial<Parameters<typeof resolveIdentifierStatus>[0]> = {}) =>
    resolveIdentifierStatus({
      configured: true, hasAnyRange: true,
      scopes: [{ participants: 600, assigned: 290, need: 310 }],
      eligible: 600, assignedLocks: 290,
      capacity: 600, capacityKind: 'finite', available: 310,
      ...over,
    })

  it('the four figures are sums over the passes, exact when every pass is exact', () => {
    const s = S()
    expect(s.participants).toBe(600)
    expect(s.assigned).toBe(290)
    expect(s.need).toBe(310)
    expect(s.available).toBe(310)
    expect(s.needBasis).toBe('exact')
    expect(s.state).toBe('healthy')
  })

  it('ONE uncountable pass makes the total unknown — it does not make it smaller', () => {
    const s = S({ scopes: [
      { participants: 600, assigned: 290, need: 310 },
      { participants: null, assigned: null, need: null },
    ] })
    expect(s.participants).toBeNull()
    expect(s.assigned).toBeNull()
    expect(s.needBasis).toBe('minimum')   // falls back to the provable floor
  })

  it('provably short is INSUFFICIENT, and names the shortfall', () => {
    const s = S({ scopes: [{ participants: 1475, assigned: 290, need: 1185 }], available: 810 })
    expect(s.state).toBe('insufficient')
    expect(s.shortBy).toBe(375)
    // The headline names the SHORTFALL rather than the two totals: with per-pass
    // ranges the totals can look comfortable while a single pass is short.
    expect(identifierStatusHeadline(s, 'BIB Number')).toMatch(/375 participants cannot be given a BIB Number/)
  })

  it('a pass short of its OWN numbers makes the event short, however healthy the total', () => {
    // 1,108 numbers spread over three ranges do not help the pass whose range holds
    // 20 for 30 people — a pass never borrows another pass's numbers.
    const s = resolveIdentifierStatus({
      configured: true, hasAnyRange: true,
      scopes: [
        { participants: 60, assigned: 12, need: 48, available: 588 },
        { participants: 50, assigned: 0,  need: 50, available: 500 },
        { participants: 30, assigned: 0,  need: 30, available: 20 },   // ← short by 10
      ],
      eligible: 140, assignedLocks: 12,
      capacity: 1120, capacityKind: 'finite', available: 1108,
    })
    expect(s.shortBy).toBe(10)
    expect(s.state).toBe('insufficient')
  })

  it('a pass with NO range of its own counts every one of its people as short', () => {
    const s = resolveIdentifierStatus({
      configured: true, hasAnyRange: true,
      scopes: [
        { participants: 600, assigned: 290, need: 310, available: 310 },
        { participants: 50,  assigned: 0,   need: 50,  available: 0 },   // no range
      ],
      eligible: 650, assignedLocks: 290,
      capacity: 600, capacityKind: 'finite', available: 310,
    })
    expect(s.shortBy).toBe(50)
    expect(s.state).toBe('insufficient')
  })

  it('without per-pass figures it falls back to the event comparison', () => {
    const s = resolveIdentifierStatus({
      configured: true, hasAnyRange: true,
      scopes: [{ participants: 400, assigned: 0, need: 400 }],   // no `available` key
      eligible: 400, assignedLocks: 0,
      capacity: 310, capacityKind: 'finite', available: 310,
    })
    expect(s.shortBy).toBe(90)
  })

  it('a shortfall is NEVER claimed from a floor — a bound could understate it', () => {
    const s = S({ scopes: [{ participants: 1475, assigned: 290, need: null }], available: 10 })
    expect(s.needBasis).toBe('minimum')
    expect(s.shortBy).toBeNull()
    expect(s.state).not.toBe('insufficient')
  })

  it('nothing left is EXHAUSTED, and the headline says who is waiting', () => {
    const s = S({ scopes: [{ participants: 52, assigned: 10, need: 42 }], available: 0, capacity: 10, assignedLocks: 10 })
    expect(s.state).toBe('exhausted')
    expect(identifierStatusHeadline(s, 'BIB Number')).toMatch(/42 participants still need one/)
  })

  it('under a tenth remaining is LOW, not yet critical', () => {
    const s = S({ capacity: 600, available: 30, scopes: [{ participants: 600, assigned: 570, need: 30 }], assignedLocks: 570 })
    expect(s.state).toBe('low')
  })

  it('no configuration is its own state, never "0 available"', () => {
    const s = S({ configured: false })
    expect(s.state).toBe('not_configured')
    expect(identifierStatusHeadline(s, 'BIB Number')).toMatch(/No BIB Number ranges are configured/)
  })

  it('an unreadable usage is UNKNOWN and draws no meter', () => {
    const s = S({ available: null, assignedLocks: null })
    expect(s.state).toBe('unknown')
    expect(s.percentUsed).toBeNull()
  })

  it('an unlimited range draws no percentage — never a fabricated 0 or 100', () => {
    const s = S({ capacityKind: 'unlimited', capacity: null, available: null })
    expect(s.percentUsed).toBeNull()
    expect(s.shortBy).toBeNull()
  })

  it('the meter is a real proportion when there is one', () => {
    expect(S({ capacity: 1100, assignedLocks: 290 }).percentUsed).toBe(26)
  })

  it('a zero capacity yields no percentage rather than a division by zero', () => {
    expect(S({ capacity: 0, assignedLocks: 0 }).percentUsed).toBeNull()
  })

  it('every state has a tone, and only the bad ones are loud', () => {
    expect(IDENTIFIER_STATUS_TONE.healthy).toBe('verify')
    expect(IDENTIFIER_STATUS_TONE.low).toBe('pending')
    expect(IDENTIFIER_STATUS_TONE.exhausted).toBe('critical')
    expect(IDENTIFIER_STATUS_TONE.insufficient).toBe('critical')
    expect(IDENTIFIER_STATUS_TONE.not_configured).toBe('neutral')
    expect(IDENTIFIER_STATUS_TONE.unknown).toBe('neutral')
  })

  it('the headline speaks the CONFIGURED noun, whatever the event is', () => {
    const s = S({ scopes: [{ participants: 20, assigned: 0, need: 20 }], available: 500 })
    expect(identifierStatusHeadline(s, 'Delegate Number')).toContain('Delegate Number')
    expect(identifierStatusHeadline(s, 'Entry Number')).toContain('Entry Number')
    expect(identifierStatusHeadline(s, 'Delegate Number')).not.toMatch(/bib/i)
  })
})

describe('RD-BIB-UX-03 · the page says what to do, in words about numbers', () => {
  it('the status card leads the page, and the capacity card is gone', () => {
    expect(TAB).toContain('<IdentifierStatusCard')
    expect(TAB).not.toContain('id="id-capacity"')
    expect(TAB).not.toContain('function UnassignedNote')
  })

  it('configuration and assignment are presented as two numbered steps', () => {
    // RD-BIB-TIMING-03 · WorkflowStrip is DELETED. CredentialSequence presents the
    // same ordered steps and their progress, so the two were the same row of
    // information twice. The rule — the work is shown as numbered steps, in order
    // — is unchanged.
    expect(TAB).toContain('function CredentialSequence')
    expect(TAB).toContain('function StepMark')
    expect(TAB).toContain('Assign ${label}s')
  })

  it('an exhausted range explains itself and offers the fix', () => {
    expect(TAB).toContain('Range exhausted')
    expect(TAB).toContain('still need one')
    expect(TAB).toContain('Add another range')
  })

  it('an unconfigured event gets an onboarding state, not "No limit"', () => {
    expect(TAB).toContain('s are not configured yet')
    // RD-BIB-TIMING-03 · RE-ANCHORED for CASE only — see the note in
    // identifierAssignmentExecution. The onboarding state itself is unchanged.
    // RD-BIB-TIMING-03 · the article follows the configured noun, so an event that
    // calls them Entry Numbers reads "Create an Entry Number range" rather than
    // the "a Entry Number" this sentence used to produce.
    expect(TAB).toContain('Create {article(label)} {label} range before assigning')
  })

  it('the implementation vocabulary is gone from what the reader sees', () => {
    // `pool` survives only as an internal identifier; never as prose.
    // An arrow function contains '>', so a naive >…< match reads `setSection('pools')`
    // as prose. Real JSX text carries no arrow and no braces.
    const prose = TAB.split('\n')
      .filter(l => !l.includes('=>'))
      .filter(l => />[^<>{}]*\bpools?\b[^<>{}]*</i.test(l))
    expect(prose).toEqual([])
    expect(TAB).not.toContain('Not countable yet')
    expect(TAB).not.toContain('Choose value')
    expect(TAB).not.toContain('>Value</label>')
  })

  it('the tabs name the job, in the event\'s own noun', () => {
    expect(TAB).toContain("s.key === 'plan' ? `Assign ${label}s`")
    expect(TAB).toContain("s.key === 'pools' ? `${label} ranges`")
  })

  it('the participant filters name operational states', () => {
    expect(TAB).toContain('`Has ${article(label)} ${label}`')
    expect(TAB).toContain('`Needs ${article(label)} ${label}`')
  })
})

describe('RD-BIB-UX-03 · a stored config is not a configured range', () => {
  it('an event that never set a range is NOT_CONFIGURED, not "Ready · No limit"', () => {
    // The built-in default pool is unbounded, so an untouched event used to report
    // healthy capacity and offer to assign from a range nobody had created.
    const s = resolveIdentifierStatus({
      configured: true, hasAnyRange: false,
      scopes: [{ participants: 75, assigned: 0, need: 75 }],
      eligible: 75, assignedLocks: 0,
      capacity: null, capacityKind: 'unlimited', available: null,
    })
    expect(s.state).toBe('not_configured')
    expect(identifierStatusHeadline(s, 'BIB Number')).toMatch(/No BIB Number ranges are configured/)
  })

  it('the unrestricted scope is not a pass and never poisons the totals', () => {
    // Pools naming no pass produce a scope with passId null and no participant
    // figures. Counting it made every total on a defaulted event read "Unknown".
    const s = resolveIdentifierStatus({
      configured: true, hasAnyRange: true,
      scopes: [
        { participants: 600, assigned: 290, need: 310, available: 310 },
        { participants: null, assigned: null, need: null, unrestricted: true },
      ],
      eligible: 600, assignedLocks: 290,
      capacity: 600, capacityKind: 'finite', available: 310,
    })
    expect(s.participants).toBe(600)
    expect(s.assigned).toBe(290)
    expect(s.need).toBe(310)
    expect(s.needBasis).toBe('exact')
  })

  it('an unlimited range never claims a number of available ones', () => {
    const s = resolveIdentifierStatus({
      configured: true, hasAnyRange: true,
      scopes: [{ participants: 75, assigned: 0, need: 75, available: null }],
      eligible: 75, assignedLocks: 0,
      capacity: null, capacityKind: 'unlimited', available: null,
    })
    const line = identifierStatusHeadline(s, 'BIB Number')
    expect(line).toMatch(/no fixed end/)
    expect(line).not.toMatch(/\b0 BIB Numbers are available/)
  })
})
