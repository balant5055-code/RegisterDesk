// RD-EVENT-19C — Identifier eligibility & assignment decision model.
//
// THE RULE. Every assignment question gets one answer from one place, with a
// machine-readable reason attached — and where RegisterDesk has no rule, the
// answer is "unknown" or "divergent", never a guess dressed as a decision.
//
// What is pinned here, and why each matters:
//   1. PASS SCOPE — a participant on one pass can NEVER receive a number from
//      another pass's pool. A printed identifier cannot be taken back.
//   2. ALL PASSES means every pass keeps drawing from its OWN pool. It is not
//      "merge every pool into one bucket", which is the exact failure the
//      pass-scoped design exists to prevent.
//   3. DIVERGENCE is reported. `pending` is allocatable by the engine and
//      invisible to the roster; 19C states both answers and picks neither.
//   4. UNKNOWN NEVER BECOMES YES. An unreadable lock is not a free number.
//   5. LIFECYCLE fails closed on anything the platform does not define.
//   6. GAPS ARE JUMPED, never filled — 5999 → 7000.
//
// Source-level assertions are comment-stripped so prose ABOUT the code can never
// satisfy them.

import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

vi.mock('@/lib/firebase/admin', () => ({ adminDb: {} }))

import {
  resolveEventAssignmentGate, decideRegistrationEligibility, decidePoolScope,
  decideExistingIdentifier, decideValueCollision, decideAssignment,
  resolveSelectionScopes, poolsServingPass, poolPassScope,
  previewRangeAllocation, buildAssignmentPreview, identifierPolicyIsDivergent,
  IDENTIFIER_LOCKED_LIFECYCLE, KNOWN_LIFECYCLE,
  UNASSIGNED_REQUIREMENT, HAS_IDENTIFIER_FIELD,
} from '@/lib/identifiers/assignmentDecision'
import type {
  AssignmentSelection, CurrentIdentifier, PoolScopeContext,
} from '@/lib/identifiers/assignmentDecision'
import { defaultIdentifierConfig, DEFAULT_POOL_ID } from '@/lib/identifiers/config'
import type { IdentifierConfig, IdentifierPool } from '@/lib/identifiers/types'
import type { IdentifierPoolStat } from '@/lib/identifiers/statistics'

// ─── Source helpers ─────────────────────────────────────────────────────────

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

const DECIDE = code(read('lib/identifiers/assignmentDecision.ts'))
const SCOPE  = code(read('lib/identifiers/organizerScope.ts'))
const ROUTE  = code(read('app/api/organizer/events/[eventId]/identifiers/route.ts'))
const BULK   = code(read('app/api/organizer/events/[eventId]/identifiers/bulk/route.ts'))
const ENGINE = code(read('lib/identifiers/engine.ts'))

// ─── Fixtures ───────────────────────────────────────────────────────────────

const cfg = (pools: IdentifierPool[], over: Partial<IdentifierConfig> = {}): IdentifierConfig =>
  ({ ...defaultIdentifierConfig('evt'), pools, defaultPoolId: pools[0]?.poolId ?? DEFAULT_POOL_ID, ...over })

const ctxOf = (passes: Array<{ id: string; name: string }>): PoolScopeContext =>
  ({ passes, passesKnown: true })
const CTX_UNKNOWN: PoolScopeContext = { passes: [], passesKnown: false }

const NO_IDENTIFIER: CurrentIdentifier = { identifier: null, legacyValue: null }
const holding = (value: string, poolId = 'a', state = 'assigned'): CurrentIdentifier =>
  ({ identifier: { value, poolId, state: state as never }, legacyValue: value })

const stat = (over: Partial<IdentifierPoolStat> = {}): Pick<IdentifierPoolStat,
  'state' | 'capacity' | 'capacityKind' | 'available' | 'assigned' | 'consumed' | 'nextNumber' | 'stateReason'> => ({
  state: 'available', capacity: 100, capacityKind: 'finite', available: 90,
  assigned: 10, consumed: 0, nextNumber: 11, stateReason: null, ...over,
})

// ════════════════════════════════════════════════════════════════════════════
// 1 — EVENT LIFECYCLE
// ════════════════════════════════════════════════════════════════════════════

describe('1 — lifecycle: the platform\'s own read-only rule, and unknown fails closed', () => {
  const open = ['published', 'registration_closed', 'completed', 'unpublished',
                'draft', 'pending_review', 'changes_requested']
  for (const ls of open) {
    it(`${ls} · assignment is open`, () => {
      expect(resolveEventAssignmentGate(ls)).toMatchObject({ open: true, reason: null })
    })
  }

  for (const ls of ['cancelled', 'archived']) {
    it(`${ls} · read-only, and it says which`, () => {
      const g = resolveEventAssignmentGate(ls)
      expect(g.open).toBe(false)
      expect(g.reason).toBe('EVENT_LOCKED')
      expect(g.detail).toContain(ls)
    })
  }

  it('an UNRECOGNISED lifecycle fails closed', () => {
    const g = resolveEventAssignmentGate('being_reviewed_by_legal')
    expect(g.open).toBe(false)
    expect(g.reason).toBe('EVENT_LIFECYCLE_UNKNOWN')
  })

  it('a MISSING lifecycle fails closed', () => {
    for (const v of [null, undefined, '', 42 as never]) {
      expect(resolveEventAssignmentGate(v).open).toBe(false)
    }
  })

  it('the detail is a sentence, never a raw status or an internal id', () => {
    const g = resolveEventAssignmentGate('nonsense')
    expect(g.detail).toMatch(/^[A-Z].*\.$/)
    expect(g.detail).not.toContain('nonsense')
  })

  it('the locked set is the platform\'s isLocked rule, not a new one', () => {
    expect([...IDENTIFIER_LOCKED_LIFECYCLE]).toEqual(['cancelled', 'archived'])
    const READINESS = code(read('lib/eventSetup/readiness.ts'))
    expect(READINESS).toContain("lifecycleStatus === 'cancelled'")
    expect(READINESS).toContain("lifecycleStatus === 'archived'")
  })

  it('every lifecycle the platform defines is represented', () => {
    for (const ls of ['draft', 'pending_review', 'changes_requested', 'published',
                      'registration_closed', 'completed', 'cancelled', 'archived', 'unpublished']) {
      expect([...KNOWN_LIFECYCLE]).toContain(ls)
    }
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 2 — REGISTRATION ELIGIBILITY
// ════════════════════════════════════════════════════════════════════════════

describe('2 — who may hold one: both rules stated, neither invented', () => {
  it('confirmed · eligible', () => {
    expect(decideRegistrationEligibility({ status: 'confirmed' }))
      .toMatchObject({ state: 'eligible', eligible: true, reason: null, action: 'assign' })
  })

  it('cancelled · ineligible with its own reason', () => {
    expect(decideRegistrationEligibility({ status: 'cancelled' }))
      .toMatchObject({ state: 'ineligible', reason: 'REGISTRATION_CANCELLED', action: 'blocked' })
  })

  it('rejected · ineligible with its own reason', () => {
    expect(decideRegistrationEligibility({ status: 'rejected' }))
      .toMatchObject({ state: 'ineligible', reason: 'REGISTRATION_REJECTED' })
  })

  for (const status of ['pending', 'waitlisted']) {
    it(`${status} · DIVERGENT, with both answers attached`, () => {
      const d = decideRegistrationEligibility({ status })
      expect(d.state).toBe('divergent')
      expect(d.eligible).toBe(false)
      expect(d.reason).toBe('REGISTRATION_NOT_ON_ROSTER')
      expect(d.divergence).toEqual({ engineAllows: true, rosterLists: false })
    })
  }

  it('a caller may resolve the divergence EXPLICITLY, either way', () => {
    expect(decideRegistrationEligibility({ status: 'pending' }, { treatDivergentAs: 'engine' }).eligible).toBe(true)
    expect(decideRegistrationEligibility({ status: 'pending' }, { treatDivergentAs: 'roster' }).eligible).toBe(false)
  })

  it('resolving it still carries the divergence, so the choice stays auditable', () => {
    const d = decideRegistrationEligibility({ status: 'pending' }, { treatDivergentAs: 'engine' })
    expect(d.divergence).toEqual({ engineAllows: true, rosterLists: false })
  })

  it('an UNKNOWN status is unknown, and unknown is not yes', () => {
    const d = decideRegistrationEligibility({ status: 'archived_by_support' })
    expect(d.state).toBe('unknown')
    expect(d.eligible).toBe(false)
    expect(d.reason).toBe('REGISTRATION_STATUS_UNKNOWN')
  })

  it('a MISSING status is unknown too', () => {
    expect(decideRegistrationEligibility({}).state).toBe('unknown')
  })

  it('a MISSING registration is ineligible, not unknown', () => {
    expect(decideRegistrationEligibility(null))
      .toMatchObject({ state: 'ineligible', reason: 'REGISTRATION_MISSING' })
  })

  it('refunded payment does NOT decide eligibility — it is an open product question', () => {
    // The engine has never consulted paymentStatus; check-in's REFUNDED block is a
    // gate rule. 19C reports rather than importing one rule into the other.
    expect(decideRegistrationEligibility({ status: 'confirmed', paymentStatus: 'refunded' }).eligible).toBe(true)
    const fn = DECIDE.slice(DECIDE.indexOf('export function decideRegistrationEligibility'))
    expect(fn.slice(0, fn.indexOf('export function decidePoolScope'))).not.toContain('paymentStatus')
  })

  it('the divergence is derived from the 19A constants, not restated here', () => {
    expect(identifierPolicyIsDivergent()).toBe(true)
    expect(DECIDE).toContain('ENGINE_TERMINAL_STATUSES')
    expect(DECIDE).toContain('ROSTER_STATUSES')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 3 — PASS / POOL SCOPE
// ════════════════════════════════════════════════════════════════════════════

describe('3 — a pass-scoped pool serves ONLY its passes', () => {
  const ctx = ctxOf([{ id: '5k', name: 'Five' }, { id: '10k', name: 'Ten' }])
  const scoped: IdentifierPool = { poolId: 'p5', label: 'P5', passIds: ['5k'] }
  const open:   IdentifierPool = { poolId: 'def', label: 'Default' }

  it('the right pass is accepted', () => {
    expect(decidePoolScope(scoped, '5k', ctx)).toMatchObject({ eligible: true, poolId: 'p5' })
  })

  it('THE RULE · another pass is refused', () => {
    expect(decidePoolScope(scoped, '10k', ctx))
      .toMatchObject({ eligible: false, reason: 'PASS_OUT_OF_POOL_SCOPE' })
  })

  it('an UNKNOWN pass is refused, never routed into a pass pool', () => {
    expect(decidePoolScope(scoped, 'pass-that-never-existed', ctx))
      .toMatchObject({ eligible: false, reason: 'PASS_OUT_OF_POOL_SCOPE' })
  })

  it('a registration with NO pass cannot enter a pass-scoped pool', () => {
    expect(decidePoolScope(scoped, null, ctx))
      .toMatchObject({ eligible: false, reason: 'PASS_MISSING' })
  })

  it('an UNRESTRICTED pool accepts anybody, including a passless registration', () => {
    expect(decidePoolScope(open, null, ctx).eligible).toBe(true)
    expect(decidePoolScope(open, 'anything', ctx).eligible).toBe(true)
  })

  it('a pool whose every pass was DELETED cannot receive anybody', () => {
    const orphan: IdentifierPool = { poolId: 'gone', label: 'Gone', passIds: ['deleted'] }
    expect(decidePoolScope(orphan, 'deleted', ctx))
      .toMatchObject({ eligible: false, reason: 'POOL_PASS_DELETED' })
  })

  it('a partially-orphaned pool still serves its surviving pass', () => {
    const mixed: IdentifierPool = { poolId: 'm', label: 'M', passIds: ['5k', 'deleted'] }
    expect(decidePoolScope(mixed, '5k', ctx).eligible).toBe(true)
  })

  it('when passes are UNKNOWN nothing is called deleted', () => {
    const orphan: IdentifierPool = { poolId: 'gone', label: 'Gone', passIds: ['deleted'] }
    expect(decidePoolScope(orphan, 'deleted', CTX_UNKNOWN).eligible).toBe(true)
  })

  it('a MISSING pool is refused', () => {
    expect(decidePoolScope(null, '5k', ctx)).toMatchObject({ eligible: false, reason: 'POOL_MISSING' })
  })

  it('a LEGACY matchRule.by = pass still scopes the pool', () => {
    const legacy: IdentifierPool = { poolId: 'l', label: 'L', matchRule: { by: 'pass', values: ['5k'] } }
    expect(decidePoolScope(legacy, '5k', ctx).eligible).toBe(true)
    expect(decidePoolScope(legacy, '10k', ctx).eligible).toBe(false)
  })

  it('a category matchRule does NOT make a pool pass-scoped', () => {
    const byCat: IdentifierPool = { poolId: 'c', label: 'C', matchRule: { by: 'category', values: ['elite'] } }
    expect(poolPassScope(byCat)).toBeNull()
    expect(decidePoolScope(byCat, '10k', ctx).eligible).toBe(true)
  })

  it('passIds outranks a legacy matchRule, exactly as 19A resolution does', () => {
    const both: IdentifierPool = {
      poolId: 'b', label: 'B', passIds: ['5k'], matchRule: { by: 'pass', values: ['10k'] },
    }
    expect(poolPassScope(both)).toEqual(['5k'])
    expect(decidePoolScope(both, '10k', ctx).eligible).toBe(false)
  })
})

describe('3b — several pools may serve one pass, and identity is preserved', () => {
  const config = cfg([
    { poolId: 'a1', label: 'A1', passIds: ['5k'], ranges: [{ start: 5001, end: 5999 }] },
    { poolId: 'a2', label: 'A2', passIds: ['5k'], ranges: [{ start: 7000, end: 7500 }] },
    { poolId: 'b',  label: 'B',  passIds: ['10k'] },
    { poolId: 'def', label: 'D' },
  ], { defaultPoolId: 'def' })

  it('both pools serve the pass, and stay two pools', () => {
    const pools = poolsServingPass(config, '5k')
    expect(pools.map(p => p.poolId)).toEqual(['a1', 'a2'])
  })

  // RD-BIB-01 · this assertion is INVERTED on purpose, and the inversion is the fix.
  //
  // It used to read "falls back to the unrestricted pools", and that fallback was
  // observed in the audit issuing a 10 KM entrant a number out of the default pool —
  // on a freshly-defaulted config, number 1. On an event that maps numbers to passes,
  // an unmatched pass is a configuration gap, and the caller must be told so rather
  // than handed somebody else's block. The legacy behaviour is preserved for events
  // that never opted into pass scoping — asserted immediately below.
  it('a pass with no pool of its own gets NOTHING on a pass-scoped event', () => {
    expect(poolsServingPass(config, 'unclaimed')).toEqual([])
  })

  it('a legacy event with no pass scoping still uses its unrestricted pool', () => {
    const legacy = cfg([{ poolId: 'def', label: 'D' }], { defaultPoolId: 'def' })
    expect(poolsServingPass(legacy, 'anything').map(p => p.poolId)).toEqual(['def'])
  })

  it('the fallback is only used when NO pool claims the pass', () => {
    expect(poolsServingPass(config, '10k').map(p => p.poolId)).toEqual(['b'])
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 4 — SELECTION / ALL PASSES SEMANTICS
// ════════════════════════════════════════════════════════════════════════════

describe('4 — ALL PASSES keeps every pass on its own pool', () => {
  const config = cfg([
    { poolId: 'p5',  label: 'P5',  passIds: ['5k'],  ranges: [{ start: 5001, end: 5999 }] },
    { poolId: 'p10', label: 'P10', passIds: ['10k'], ranges: [{ start: 7000, end: 7500 }] },
    { poolId: 'ph',  label: 'PH',  passIds: ['half'], ranges: [{ start: 8000, end: 8799 }] },
  ], { defaultPoolId: 'p5' })
  const ctx = ctxOf([{ id: '5k', name: '5 KM' }, { id: '10k', name: '10 KM' }, { id: 'half', name: 'Half' }])

  it('one selected pass yields one scope', () => {
    const s = resolveSelectionScopes({ kind: 'pass', passIds: ['5k'] }, config, ctx)
    expect(s).toHaveLength(1)
    expect(s[0]).toMatchObject({ passId: '5k', passName: '5 KM' })
    expect(s[0].pools.map(p => p.poolId)).toEqual(['p5'])
  })

  it('several selected passes yield several scopes, in the caller\'s order', () => {
    const s = resolveSelectionScopes({ kind: 'pass', passIds: ['half', '5k'] }, config, ctx)
    expect(s.map(x => x.passId)).toEqual(['half', '5k'])
  })

  it('a duplicated pass is only listed once', () => {
    const s = resolveSelectionScopes({ kind: 'pass', passIds: ['5k', '5k'] }, config, ctx)
    expect(s).toHaveLength(1)
  })

  it('ALL PASSES yields one scope per pass, each with its OWN pool', () => {
    const s = resolveSelectionScopes({ kind: 'all_passes' }, config, ctx)
    expect(s.map(x => x.passId)).toEqual(['5k', '10k', 'half'])
    expect(s.map(x => x.pools.map(p => p.poolId))).toEqual([['p5'], ['p10'], ['ph']])
  })

  it('ALL PASSES does NOT merge the pools into one anonymous bucket', () => {
    const s = resolveSelectionScopes({ kind: 'all_passes' }, config, ctx)
    const everyPool = s.flatMap(x => x.pools.map(p => p.poolId))
    expect(new Set(everyPool).size).toBe(3)
    // No scope may reach a pool belonging to another pass.
    for (const scope of s) {
      for (const pool of scope.pools) {
        expect(poolPassScope(pool)).toContain(scope.passId)
      }
    }
  })

  it('ALL PASSES ordering follows the EVENT, not the configuration', () => {
    const reordered = cfg([
      { poolId: 'ph',  label: 'PH',  passIds: ['half'] },
      { poolId: 'p5',  label: 'P5',  passIds: ['5k'] },
      { poolId: 'p10', label: 'P10', passIds: ['10k'] },
    ], { defaultPoolId: 'p5' })
    const s = resolveSelectionScopes({ kind: 'all_passes' }, reordered, ctx)
    expect(s.map(x => x.passId)).toEqual(['5k', '10k', 'half'])
  })

  it('ALL PASSES lists an ORPHANED pass so its unfillable pool is visible', () => {
    const withOrphan = cfg([
      { poolId: 'p5', label: 'P5', passIds: ['5k'] },
      { poolId: 'gh', label: 'Ghost', passIds: ['deleted'] },
    ], { defaultPoolId: 'p5' })
    const s = resolveSelectionScopes({ kind: 'all_passes' }, withOrphan, ctxOf([{ id: '5k', name: '5 KM' }]))
    expect(s.map(x => x.passId)).toEqual(['5k', 'deleted'])
    expect(s[1]).toMatchObject({ passExists: false, blocked: 'POOL_PASS_DELETED' })
  })

  it('ALL PASSES on an event with NO passes still offers the unrestricted scope', () => {
    const only = cfg([{ poolId: 'def', label: 'D' }])
    const s = resolveSelectionScopes({ kind: 'all_passes' }, only, ctxOf([]))
    expect(s).toHaveLength(1)
    expect(s[0]).toMatchObject({ passId: null })
    expect(s[0].pools.map(p => p.poolId)).toEqual(['def'])
  })

  it('an unrestricted pool is NOT listed twice when passes already fall back to it', () => {
    const fallback = cfg([{ poolId: 'def', label: 'D' }])
    const s = resolveSelectionScopes({ kind: 'all_passes' }, fallback, ctx)
    expect(s.map(x => x.passId)).toEqual(['5k', '10k', 'half'])
    // Three scopes, all pointing at the one pool — and no extra null scope.
    expect(s.every(x => x.pools.map(p => p.poolId).join() === 'def')).toBe(true)
    expect(s.some(x => x.passId === null)).toBe(false)
  })

  it('an explicit POOL selection reports the passes that pool serves', () => {
    const s = resolveSelectionScopes({ kind: 'pool', poolId: 'p10' }, config, ctx)
    expect(s).toHaveLength(1)
    expect(s[0]).toMatchObject({ passId: '10k', passName: '10 KM' })
  })

  it('an unknown pool selection is blocked, not silently empty', () => {
    const s = resolveSelectionScopes({ kind: 'pool', poolId: 'nope' }, config, ctx)
    expect(s[0].blocked).toBe('POOL_MISSING')
  })

  it('a pass with no pool at all is blocked with a reason', () => {
    const none = cfg([{ poolId: 'p5', label: 'P5', passIds: ['5k'] }])
    const s = resolveSelectionScopes({ kind: 'pass', passIds: ['10k'] }, none, ctx)
    expect(s[0].blocked).toBe('POOL_MISSING')
  })

  it('scope resolution is deterministic', () => {
    const a = JSON.stringify(resolveSelectionScopes({ kind: 'all_passes' }, config, ctx))
    const b = JSON.stringify(resolveSelectionScopes({ kind: 'all_passes' }, config, ctx))
    expect(a).toBe(b)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 5 — EXISTING IDENTIFIER MATRIX
// ════════════════════════════════════════════════════════════════════════════

describe('5 — what an assignment means for somebody who already holds one', () => {
  it('holds nothing → a new assignment', () => {
    expect(decideExistingIdentifier(NO_IDENTIFIER, null, 'a'))
      .toMatchObject({ eligible: true, action: 'assign', poolId: 'a' })
  })

  it('holds exactly the requested value → a no-op, not an error', () => {
    expect(decideExistingIdentifier(holding('5001'), '5001', 'a'))
      .toMatchObject({ eligible: true, action: 'noop' })
  })

  it('holds a DIFFERENT value → a swap, and it is not automatic', () => {
    const d = decideExistingIdentifier(holding('5001'), '5002', 'a')
    expect(d.action).toBe('swap')
    expect(d.eligible).toBe(false)
    expect(d.reason).toBe('ALREADY_ASSIGNED')
  })

  it('holds one from a DIFFERENT pool → still a swap, targeting the new pool', () => {
    expect(decideExistingIdentifier(holding('5001', 'a'), null, 'b'))
      .toMatchObject({ action: 'swap', poolId: 'b' })
  })

  it('a CONSUMED identifier is never changed automatically', () => {
    const d = decideExistingIdentifier(holding('5001', 'a', 'consumed'), '5002', 'a')
    expect(d).toMatchObject({ eligible: false, reason: 'IDENTIFIER_CONSUMED', action: 'blocked' })
    expect(d.action).not.toBe('swap')
  })

  it('INCONSISTENT · a legacy mirror with no generic identifier is unknown, not free', () => {
    const d = decideExistingIdentifier({ identifier: null, legacyValue: '999' }, null, 'a')
    expect(d.state).toBe('unknown')
    expect(d.reason).toBe('LEGACY_MIRROR_WITHOUT_LOCK')
    expect(d.eligible).toBe(false)
  })

  it('a generic identifier with no legacy mirror is fine — the generic one is the authority', () => {
    const d = decideExistingIdentifier({ identifier: { value: '5001', poolId: 'a', state: 'assigned' }, legacyValue: null }, '5001', 'a')
    expect(d.action).toBe('noop')
  })

  it('the decision layer never rewrites a mirror — it holds no writer', () => {
    for (const banned of ['adminDb', 'runTransaction', 'FieldValue', '.doc(', '.collection(']) {
      expect(DECIDE, banned).not.toContain(banned)
    }
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 6 — COLLISION / REUSE MATRIX
// ════════════════════════════════════════════════════════════════════════════

describe('6 — may this VALUE go to this participant', () => {
  const base = {
    registrationId: 'me', reusePolicy: 'after_cancel_before_checkin' as const,
    phase: 'pre_event' as const, allowDuplicate: false,
  }

  it('no lock → available', () => {
    expect(decideValueCollision({ ...base, lock: null }))
      .toMatchObject({ eligible: true, action: 'assign' })
  })

  it('assigned to somebody else → refused', () => {
    expect(decideValueCollision({ ...base, lock: { state: 'assigned', registrationId: 'other', everCheckedIn: false } }))
      .toMatchObject({ eligible: false, reason: 'IDENTIFIER_OWNED_BY_OTHER' })
  })

  it('reserved by nobody → still held, refused', () => {
    expect(decideValueCollision({ ...base, lock: { state: 'reserved', registrationId: null, everCheckedIn: false } }))
      .toMatchObject({ eligible: false, reason: 'IDENTIFIER_OWNED_BY_OTHER' })
  })

  it('already mine → a no-op', () => {
    expect(decideValueCollision({ ...base, lock: { state: 'assigned', registrationId: 'me', everCheckedIn: false } }))
      .toMatchObject({ eligible: true, action: 'noop' })
  })

  it('blocked → refused with its own reason', () => {
    expect(decideValueCollision({ ...base, lock: { state: 'blocked', registrationId: null, everCheckedIn: false } }))
      .toMatchObject({ reason: 'IDENTIFIER_BLOCKED' })
  })

  it('retired → refused with its own reason', () => {
    expect(decideValueCollision({ ...base, lock: { state: 'retired', registrationId: null, everCheckedIn: false } }))
      .toMatchObject({ reason: 'IDENTIFIER_RETIRED' })
  })

  it('consumed by somebody else → refused', () => {
    expect(decideValueCollision({ ...base, lock: { state: 'consumed', registrationId: 'other', everCheckedIn: true } }))
      .toMatchObject({ reason: 'IDENTIFIER_CONSUMED' })
  })

  it('released and policy allows → reuse', () => {
    expect(decideValueCollision({ ...base, lock: { state: 'released', registrationId: 'other', everCheckedIn: false } }))
      .toMatchObject({ eligible: true, action: 'reuse' })
  })

  it('released but everCheckedIn → NEVER reusable, whatever the policy says', () => {
    expect(decideValueCollision({ ...base, lock: { state: 'released', registrationId: 'other', everCheckedIn: true } }))
      .toMatchObject({ eligible: false, reason: 'IDENTIFIER_NOT_REUSABLE' })
  })

  it('released but policy says never → refused', () => {
    expect(decideValueCollision({
      ...base, reusePolicy: 'never', lock: { state: 'released', registrationId: 'other', everCheckedIn: false },
    })).toMatchObject({ eligible: false, reason: 'IDENTIFIER_NOT_REUSABLE' })
  })

  it('a value held only in the LEGACY collection is refused', () => {
    expect(decideValueCollision({ ...base, lock: null, legacyOwner: 'someone-else' }))
      .toMatchObject({ eligible: false, reason: 'IDENTIFIER_OWNED_BY_OTHER' })
  })

  it('a legacy value held by ME is not a collision', () => {
    expect(decideValueCollision({ ...base, lock: null, legacyOwner: 'me' }).eligible).toBe(true)
  })

  it('AN UNREADABLE LOCK IS NOT A FREE NUMBER', () => {
    const d = decideValueCollision({ ...base, lock: null, lockUnavailable: true })
    expect(d.state).toBe('unknown')
    expect(d.eligible).toBe(false)
    expect(d.reason).toBe('POOL_USAGE_UNAVAILABLE')
  })

  it('reuse eligibility is delegated to canReuse, not restated', () => {
    expect(DECIDE).toContain('canReuse(lock, reusePolicy, phase)')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 7 — THE COMPOSITE DECISION
// ════════════════════════════════════════════════════════════════════════════

describe('7 — the widest reason wins', () => {
  const ctx = ctxOf([{ id: '5k', name: 'Five' }])
  const pool: IdentifierPool = { poolId: 'p5', label: 'P5', passIds: ['5k'], ranges: [{ start: 1, end: 100 }] }
  const config = cfg([pool])

  const input = (over: Record<string, unknown> = {}) => ({
    config, lifecycleStatus: 'published',
    registration: { status: 'confirmed', passId: '5k' },
    registrationId: 'r1', pool, current: NO_IDENTIFIER, ctx,
    poolUsage: stat(), ...over,
  })

  it('a clean case is eligible', () => {
    expect(decideAssignment(input())).toMatchObject({ eligible: true, action: 'assign', poolId: 'p5' })
  })

  it('a locked EVENT outranks a wrong pass', () => {
    const d = decideAssignment(input({
      lifecycleStatus: 'archived', registration: { status: 'confirmed', passId: '10k' },
    }))
    expect(d.reason).toBe('EVENT_LOCKED')
  })

  it('a cancelled REGISTRATION outranks a wrong pass', () => {
    const d = decideAssignment(input({ registration: { status: 'cancelled', passId: '10k' } }))
    expect(d.reason).toBe('REGISTRATION_CANCELLED')
  })

  it('a wrong pass outranks an exhausted pool', () => {
    const d = decideAssignment(input({
      registration: { status: 'confirmed', passId: '10k' },
      poolUsage: stat({ state: 'exhausted', available: 0 }),
    }))
    expect(d.reason).toBe('PASS_OUT_OF_POOL_SCOPE')
  })

  it('identifiers switched off outranks everything', () => {
    const d = decideAssignment(input({ config: cfg([pool], { enabled: false }) }))
    expect(d.reason).toBe('IDENTIFIERS_DISABLED')
  })

  it('an exhausted pool blocks an automatic assignment', () => {
    expect(decideAssignment(input({ poolUsage: stat({ state: 'exhausted', available: 0 }) })))
      .toMatchObject({ eligible: false, reason: 'POOL_EXHAUSTED' })
  })

  it('an exhausted pool does NOT block an explicit value — it consumes no sequence', () => {
    const d = decideAssignment(input({
      poolUsage: stat({ state: 'available', available: 0 }), requestedValue: 'VIP-1',
    }))
    expect(d.eligible).toBe(true)
  })

  it('UNREADABLE usage is unknown, never "there is room"', () => {
    const d = decideAssignment(input({ poolUsage: stat({ state: 'unavailable', available: null }) }))
    expect(d.state).toBe('unknown')
    expect(d.reason).toBe('POOL_USAGE_UNAVAILABLE')
    expect(d.eligible).toBe(false)
  })

  it('an INCONSISTENT pool is unknown, not quietly usable', () => {
    const d = decideAssignment(input({ poolUsage: stat({ state: 'inconsistent', available: null }) }))
    expect(d.state).toBe('unknown')
    expect(d.reason).toBe('POOL_INCONSISTENT')
  })

  it('an unlimited pool with 0 available is not exhausted', () => {
    const d = decideAssignment(input({
      poolUsage: stat({ capacityKind: 'unlimited', capacity: null, available: null, state: 'unlimited' }),
    }))
    expect(d.eligible).toBe(true)
  })

  it('a divergent registration is surfaced, not silently assigned', () => {
    const d = decideAssignment(input({ registration: { status: 'pending', passId: '5k' } }))
    expect(d.state).toBe('divergent')
    expect(d.eligible).toBe(false)
  })

  it('an unknown lifecycle is unknown, not merely ineligible', () => {
    expect(decideAssignment(input({ lifecycleStatus: 'who_knows' })).state).toBe('unknown')
  })

  it('an already-assigned participant yields action swap, not a silent overwrite', () => {
    const d = decideAssignment(input({ current: holding('50', 'p5') }))
    expect(d.action).toBe('swap')
    expect(d.eligible).toBe(false)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 8 — RANGE PREVIEW
// ════════════════════════════════════════════════════════════════════════════

describe('8 — what a run would issue, without issuing it', () => {
  const gapped: IdentifierPool = {
    poolId: 'g', label: 'G', ranges: [{ start: 5001, end: 5999 }, { start: 7000, end: 7500 }],
  }

  it('capacity is the sum of the ranges, never highest-minus-lowest', () => {
    const p = previewRangeAllocation(gapped, null, 1)
    expect(p.capacity).toBe(1500)
    expect(p.capacity).not.toBe(7500 - 5001 + 1)
  })

  it('starts at the first range when no counter exists', () => {
    expect(previewRangeAllocation(gapped, null, 1).nextValue).toBe(5001)
  })

  it('THE GAP IS JUMPED, never filled', () => {
    const p = previewRangeAllocation(gapped, 5998, 4)
    expect(p.nextValue).toBe(5998)
    expect(p.lastValue).toBe(7001)      // 5998, 5999, 7000, 7001
    expect(p.gapsCrossed).toBe(1)
  })

  it('a counter parked inside a gap resumes at the next range', () => {
    expect(previewRangeAllocation(gapped, 6500, 1).nextValue).toBe(7000)
  })

  it('reports how many it can actually issue when the request exceeds the ranges', () => {
    const p = previewRangeAllocation({ poolId: 'x', label: 'X', ranges: [{ start: 1, end: 3 }] }, 1, 10)
    expect(p.issuable).toBe(3)
    expect(p.lastValue).toBe(3)
    expect(p.exhausted).toBe(false)
  })

  it('an exhausted pool issues nothing and says so', () => {
    const p = previewRangeAllocation({ poolId: 'x', label: 'X', ranges: [{ start: 1, end: 3 }] }, 4, 5)
    expect(p.exhausted).toBe(true)
    expect(p.issuable).toBe(0)
    expect(p.nextValue).toBeNull()
  })

  it('an UNLIMITED pool has no capacity and is never exhausted', () => {
    const p = previewRangeAllocation({ poolId: 'o', label: 'O' }, 10, 5)
    expect(p.capacityKind).toBe('unlimited')
    expect(p.capacity).toBeNull()
    expect(p.exhausted).toBe(false)
    expect(p.lastValue).toBe(14)
  })

  it('a LEGACY scalar range still previews', () => {
    const p = previewRangeAllocation({ poolId: 'l', label: 'L', rangeStart: 100, rangeEnd: 109 }, 100, 3)
    expect(p.capacity).toBe(10)
    expect(p.lastValue).toBe(102)
  })

  it('ranges[] supersedes the legacy pair, and they are never merged', () => {
    const both: IdentifierPool = {
      poolId: 'b', label: 'B', ranges: [{ start: 10, end: 19 }], rangeStart: 500, rangeEnd: 999,
    }
    const p = previewRangeAllocation(both, null, 1)
    expect(p.nextValue).toBe(10)
    expect(p.capacity).toBe(10)
  })

  it('the walker is 19A\'s, not a second implementation', () => {
    expect(DECIDE).toContain('nextNumberInRanges')
    expect(DECIDE).not.toContain('function nextNumberInRanges')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 9 — ASSIGNMENT PREVIEW CONTRACT
// ════════════════════════════════════════════════════════════════════════════

describe('9 — the preview a future UI consumes', () => {
  const config = cfg([
    { poolId: 'p5',  label: 'P5',  passIds: ['5k'],  ranges: [{ start: 5001, end: 5300 }] },
    { poolId: 'p10', label: 'P10', passIds: ['10k'], ranges: [{ start: 7000, end: 7200 }] },
  ], { defaultPoolId: 'p5' })
  const ctx = ctxOf([{ id: '5k', name: '5 KM' }, { id: '10k', name: '10 KM' }])
  const stats = new Map([
    ['p5',  stat({ capacity: 300, available: 99, assigned: 200, consumed: 1, nextNumber: 5202 })],
    ['p10', stat({ capacity: 201, available: 201, assigned: 0, consumed: 0, nextNumber: null })],
  ])

  const preview = (selection: AssignmentSelection, over: Record<string, unknown> = {}) =>
    buildAssignmentPreview({
      selection, config, lifecycleStatus: 'published', ctx, poolStats: stats, ...over,
    })

  it('ALL PASSES gives a per-pass breakdown', () => {
    const p = preview({ kind: 'all_passes' })
    expect(p.scopes.map(s => s.passName)).toEqual(['5 KM', '10 KM'])
    expect(p.scopes[0].poolIds).toEqual(['p5'])
    expect(p.scopes[1].poolIds).toEqual(['p10'])
  })

  it('already-assigned counts assigned PLUS consumed — both are held', () => {
    expect(preview({ kind: 'all_passes' }).scopes[0].alreadyAssigned).toMatchObject({ value: 201, status: 'known' })
  })

  it('capacity available comes from the pool statistics', () => {
    const p = preview({ kind: 'all_passes' })
    expect(p.scopes[0].capacityAvailable).toBe(99)
    expect(p.totals.capacityAvailable).toBe(300)
  })

  it('REMAINING and WOULD-ASSIGN are UNKNOWN, and name what is missing', () => {
    const p = preview({ kind: 'all_passes' })
    expect(p.scopes[0].remaining.status).toBe('unavailable')
    expect(p.scopes[0].remaining.value).toBeNull()
    expect(p.totals.wouldAssign.status).toBe('unavailable')
    expect(p.totals.remaining.reason).toBe(UNASSIGNED_REQUIREMENT)
    expect(UNASSIGNED_REQUIREMENT).toMatch(/backfill/)
  })

  it('it is NOT eligible minus assigned', () => {
    const p = preview({ kind: 'all_passes' }, { eligibleByPass: new Map([['5k', 500], ['10k', 300]]) })
    expect(p.scopes[0].eligible.value).toBe(500)
    expect(p.scopes[0].alreadyAssigned.value).toBe(201)
    expect(p.scopes[0].remaining.value).toBeNull()     // 299 would be a guess
  })

  it('eligible counts are used when supplied, and unknown when not', () => {
    expect(preview({ kind: 'all_passes' }).scopes[0].eligible.status).toBe('unavailable')
    expect(preview({ kind: 'all_passes' }, { eligibleByPass: new Map([['5k', 12], ['10k', 8]]) })
      .totals.eligible).toMatchObject({ value: 20, status: 'known' })
  })

  it('a locked event makes the preview NOT ready, and says why', () => {
    const p = preview({ kind: 'all_passes' }, { lifecycleStatus: 'cancelled' })
    expect(p.ready).toBe(false)
    expect(p.blockers.map(b => b.reason)).toContain('EVENT_LOCKED')
  })

  it('an exhausted pool becomes a scope blocker', () => {
    const exhausted = new Map(stats)
    exhausted.set('p10', stat({ state: 'exhausted', available: 0, capacity: 201 }))
    const p = preview({ kind: 'all_passes' }, { poolStats: exhausted })
    expect(p.scopes[1].blockers.map(b => b.reason)).toContain('POOL_EXHAUSTED')
    expect(p.ready).toBe(false)
  })

  it('an UNREADABLE pool makes only its own scope unknown', () => {
    const partial = new Map(stats)
    partial.set('p10', stat({ state: 'unavailable', available: null, assigned: null, consumed: null }))
    const p = preview({ kind: 'all_passes' }, { poolStats: partial })
    expect(p.scopes[0].alreadyAssigned.value).toBe(201)
    expect(p.scopes[1].alreadyAssigned.value).toBeNull()
    expect(p.totals.alreadyAssigned.value).toBeNull()
    expect(p.totals.capacityAvailable).toBeNull()
  })

  it('a shared unrestricted pool is counted ONCE in the totals', () => {
    const shared = cfg([{ poolId: 'def', label: 'D' }])
    const sharedStats = new Map([['def', stat({ capacity: 100, available: 40, assigned: 60, consumed: 0 })]])
    const p = buildAssignmentPreview({
      selection: { kind: 'all_passes' }, config: shared, lifecycleStatus: 'published',
      ctx, poolStats: sharedStats,
    })
    expect(p.scopes).toHaveLength(2)              // one per pass…
    expect(p.totals.capacityAvailable).toBe(40)   // …but the pool counts once
    expect(p.totals.alreadyAssigned.value).toBe(60)
  })

  it('the range preview rides along for the scope\'s first pool', () => {
    const p = preview({ kind: 'pass', passIds: ['5k'] })
    expect(p.scopes[0].range?.nextValue).toBe(5202)
    expect(p.scopes[0].range?.capacity).toBe(300)
  })

  it('the eligibility divergence is restated so a UI cannot omit it', () => {
    expect(preview({ kind: 'all_passes' }).eligibilityPolicy).toBe('divergent')
  })

  it('the preview does no I/O and cannot become a scan', () => {
    const fn = DECIDE.slice(DECIDE.indexOf('export function buildAssignmentPreview'))
    expect(fn).not.toContain('await')
    expect(fn).not.toContain('fetch')
  })

  it('the preview carries no PII', () => {
    // `passName` is configuration an organizer typed, not personal data — the
    // preview is counts plus the names of passes and pools, and nothing else.
    const json = JSON.stringify(preview({ kind: 'all_passes' })).toLowerCase()
    for (const f of ['email', 'phone', 'attendee', 'registrationid', 'firstname', 'formresponses']) {
      expect(json, f).not.toContain(f)
    }
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 10 — EVENT-TYPE MATRIX
// ════════════════════════════════════════════════════════════════════════════

const CATEGORIES: Array<{ category: string; label: string; passes: Array<{ id: string; name: string }>; pools: IdentifierPool[] }> = [
  { category: 'Conference', label: 'Delegate ID',
    passes: [{ id: 'p-vip', name: 'VIP' }, { id: 'p-gen', name: 'General' }],
    pools: [{ poolId: 'vip', label: 'VIP', passIds: ['p-vip'], ranges: [{ start: 1, end: 500 }] },
            { poolId: 'gen', label: 'General', passIds: ['p-gen'], ranges: [{ start: 501, end: 2000 }] }] },
  { category: 'Exhibition & Expo', label: 'Visitor ID',
    passes: [{ id: 'p-vis', name: 'Visitor' }, { id: 'p-exh', name: 'Exhibitor' }],
    pools: [{ poolId: 'vis', label: 'Visitors', passIds: ['p-vis'], ranges: [{ start: 1, end: 5000 }] },
            { poolId: 'exh', label: 'Exhibitors', passIds: ['p-exh'], ranges: [{ start: 9000, end: 9499 }] }] },
  { category: 'Sports & Fitness', label: 'Bib Number',
    passes: [{ id: 'p-s', name: 'Short' }, { id: 'p-m', name: 'Medium' }, { id: 'p-l', name: 'Long' }],
    pools: [{ poolId: 's', label: 'Short', passIds: ['p-s'], ranges: [{ start: 5001, end: 5999 }] },
            { poolId: 'm', label: 'Medium', passIds: ['p-m'], ranges: [{ start: 7000, end: 7500 }] },
            { poolId: 'l', label: 'Long', passIds: ['p-l'], ranges: [{ start: 8000, end: 8799 }] }] },
  { category: 'Workshop & Training', label: 'Participant ID',
    passes: [{ id: 'p-b', name: 'Beginner' }, { id: 'p-a', name: 'Advanced' }],
    pools: [{ poolId: 'b', label: 'Beginner', passIds: ['p-b'], ranges: [{ start: 1, end: 300 }] },
            { poolId: 'a', label: 'Advanced', passIds: ['p-a'], ranges: [{ start: 1001, end: 1300 }] }] },
  { category: 'Business Meetup', label: 'Member ID',
    passes: [{ id: 'p-d', name: 'Delegate' }],
    pools: [{ poolId: 'd', label: 'Delegates', passIds: ['p-d'], ranges: [{ start: 1, end: 500 }] }] },
  { category: 'Community & Awareness', label: 'Volunteer ID',
    passes: [{ id: 'p-v', name: 'Volunteer' }],
    pools: [{ poolId: 'v', label: 'Volunteers', passIds: ['p-v'], ranges: [{ start: 1, end: 300 }] }] },
  { category: 'Cultural & Entertainment', label: 'Seat Number',
    passes: [{ id: 'p-ga', name: 'General' }, { id: 'p-vip', name: 'VIP' }],
    pools: [{ poolId: 'ga', label: 'General', passIds: ['p-ga'], ranges: [{ start: 1, end: 800 }] },
            { poolId: 'vp', label: 'VIP', passIds: ['p-vip'], ranges: [{ start: 900, end: 999 }] }] },
  { category: 'Awards & Recognition', label: 'Nominee ID',
    passes: [{ id: 'p-n', name: 'Nominee' }],
    pools: [{ poolId: 'n', label: 'Nominees', passIds: ['p-n'], ranges: [{ start: 1, end: 200 }] }] },
  { category: 'Fundraising & Charity', label: 'Supporter ID',
    passes: [{ id: 'p-s', name: 'Supporter' }],
    pools: [{ poolId: 'sup', label: 'Supporters', passIds: ['p-s'] }] },      // unlimited
  { category: 'Custom Event', label: 'Access Code',
    passes: [{ id: 'p-1', name: 'Tier one' }, { id: 'p-2', name: 'Tier two' }],
    pools: [{ poolId: 't1', label: 'T1', passIds: ['p-1'], ranges: [{ start: 1, end: 50 }, { start: 200, end: 250 }] },
            { poolId: 't2', label: 'T2', passIds: ['p-2'], ranges: [{ start: 500, end: 600 }] }] },
]

describe('10 — one decision layer for every event category', () => {
  for (const fx of CATEGORIES) {
    describe(fx.category, () => {
      const config = cfg(fx.pools, { label: fx.label, defaultPoolId: fx.pools[0].poolId })
      const ctx = ctxOf(fx.passes)

      it('each pass resolves to its own pool', () => {
        for (const pass of fx.passes) {
          const pools = poolsServingPass(config, pass.id)
          expect(pools.length).toBeGreaterThan(0)
          for (const pool of pools) expect(poolPassScope(pool)).toContain(pass.id)
        }
      })

      it('a participant on one pass is refused by every other pass\'s pool', () => {
        if (fx.passes.length < 2) return
        const [first, second] = fx.passes
        const otherPool = poolsServingPass(config, second.id)[0]
        expect(decidePoolScope(otherPool, first.id, ctx))
          .toMatchObject({ eligible: false, reason: 'PASS_OUT_OF_POOL_SCOPE' })
      })

      it('ALL PASSES lists every pass, each on its own pool', () => {
        const scopes = resolveSelectionScopes({ kind: 'all_passes' }, config, ctx)
        expect(scopes.map(s => s.passId)).toEqual(fx.passes.map(p => p.id))
      })

      it('a clean assignment is eligible', () => {
        const pool = poolsServingPass(config, fx.passes[0].id)[0]
        expect(decideAssignment({
          config, lifecycleStatus: 'published',
          registration: { status: 'confirmed', passId: fx.passes[0].id },
          registrationId: 'r', pool, current: NO_IDENTIFIER, ctx,
          poolUsage: stat({ capacityKind: pool.ranges || pool.rangeStart ? 'finite' : 'unlimited' }),
        }).eligible).toBe(true)
      })

      it('the label is data — the decision layer never sees it', () => {
        expect(DECIDE).not.toContain(fx.label)
      })

      it('the preview works with this shape', () => {
        const stats = new Map(fx.pools.map(p => [p.poolId, stat()]))
        const p = buildAssignmentPreview({
          selection: { kind: 'all_passes' }, config, lifecycleStatus: 'published', ctx, poolStats: stats,
        })
        expect(p.scopes.length).toBeGreaterThan(0)
        expect(p.ready).toBe(true)
      })
    })
  }

  it('all ten categories are covered', () => expect(CATEGORIES).toHaveLength(10))

  it('the decision layer names no sport and no example pass', () => {
    for (const word of [/\brunner/i, /\bmarathon/i, /\bfinisher/i, /\brace\b/i, /\blane\b/i,
                        /\b5\s?km\b/i, /\b10\s?km\b/i, /half.?marathon/i]) {
      expect(DECIDE).not.toMatch(word)
    }
  })

  it('every remaining "bib" is a legacy compatibility name', () => {
    for (const raw of DECIDE.split('\n')) {
      const line = raw.split('//')[0]
      if (!/bib/i.test(line)) continue
      expect(/bibLocks|bibNumber|bibCategory/.test(line), line.trim()).toBe(true)
    }
  })

  it('no decision branches on an event category', () => {
    expect(DECIDE).not.toContain('eventCategory')
    expect(DECIDE).not.toContain('eventType')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 11 — WIRING (structural)
// ════════════════════════════════════════════════════════════════════════════

describe('11 — the decision layer is authoritative, not decorative', () => {
  it('the mutation route REFUSES a locked event', () => {
    expect(ROUTE).toContain('resolveEventAssignmentGate(scope.lifecycleStatus)')
    const post = ROUTE.slice(ROUTE.indexOf('export async function POST'))
    expect(post.indexOf('resolveEventAssignmentGate')).toBeLessThan(post.indexOf('switch (action)'))
    expect(post).toContain('status: 409')
  })

  it('the gate runs BEFORE the body is even parsed', () => {
    const post = ROUTE.slice(ROUTE.indexOf('export async function POST'))
    expect(post.indexOf('resolveEventAssignmentGate')).toBeLessThan(post.indexOf('await req.json()'))
  })

  it('BULK cannot be the way around the gate', () => {
    expect(BULK).toContain('resolveEventAssignmentGate(scope.lifecycleStatus)')
    expect(BULK).toContain("mode === 'commit'")
  })

  it('a PREVIEW is still allowed on a locked event — it writes nothing', () => {
    const guard = BULK.slice(BULK.indexOf("if (mode === 'commit')"))
    expect(guard.slice(0, 300)).toContain('resolveEventAssignmentGate')
  })

  it('the GET reports the gate, so the UI never offers what POST will refuse', () => {
    expect(ROUTE).toContain('assignmentGate:')
  })

  it('the lifecycle costs no extra read — it rides the draft the scope already reads', () => {
    expect(SCOPE).toContain('lifecycleStatus: typeof d.lifecycleStatus')
    const fn = SCOPE.slice(SCOPE.indexOf('export async function resolveIdentifierScope'))
    const body = fn.slice(0, fn.indexOf('function readPasses'))
    expect((body.match(/\.get\(\)/g) ?? []).length).toBe(1)
  })

  it('the response exposes a REASON CODE, never a raw internal message', () => {
    expect(ROUTE).toContain('code: gate.reason')
    expect(ROUTE).not.toContain('err.stack')
  })

  it('the allocation transaction was NOT touched by this phase', () => {
    expect(ENGINE).toContain('adminDb.runTransaction')
    expect(ENGINE).toContain("collection('identifierLocks')")
    expect(ENGINE).toContain('bibNumber:')
    expect(ENGINE).not.toContain('assignmentDecision')
  })

  it('the additive data-model proposal is now IMPLEMENTED, atomically', () => {
    expect(HAS_IDENTIFIER_FIELD).toBe('hasIdentifier')
    // RD-BIB-01 · 19C designed this field and deliberately did not write it, because
    // a partially populated field under-reports. That reservation is now answered by
    // COVERAGE CHECKING rather than by abstinence: the read model compares
    // true + false against the roster total and reports UNKNOWN when they disagree,
    // so a half-populated field can never produce a confidently wrong number.
    //
    // What the engine must guarantee is that the field only ever moves inside the
    // same transaction as the lock and the other mirrors.
    expect(ENGINE).toContain('hasIdentifier: true')
    expect(ENGINE).toContain('hasIdentifier: false')
    const assignWrite = ENGINE.slice(ENGINE.indexOf('hasIdentifier: true') - 900, ENGINE.indexOf('hasIdentifier: true'))
    expect(assignWrite).toContain('txn.update(rRef, {')
    expect(assignWrite).toContain('bibNumber:   value')
  })

  it('the field is never updated on its own', () => {
    // Every occurrence lives inside a txn.update that also moves a mirror.
    for (const m of ENGINE.matchAll(/hasIdentifier: (true|false)/g)) {
      const before = ENGINE.slice(Math.max(0, m.index! - 700), m.index!)
      expect(before, m[0]).toMatch(/txn\.update\(rRef, \{/)
      expect(before, m[0]).toMatch(/bibNumber/)
    }
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 12 — SECURITY (structural)
// ════════════════════════════════════════════════════════════════════════════

describe('12 — nothing in the decision path trusts the client', () => {
  it('the pass used for scoping comes from the stored registration', () => {
    expect(SCOPE).toContain("typeof r.passId === 'string'")
    expect(ROUTE).toContain('scopedPassId = guard.passId')
    expect(ROUTE).not.toMatch(/passId:\s*body\./)
  })

  it('the lifecycle comes from the owned draft, never the request', () => {
    expect(ROUTE).toContain('scope.lifecycleStatus')
    expect(ROUTE).not.toMatch(/lifecycle.*body\./)
  })

  it('every route still resolves scope before anything else', () => {
    for (const src of [ROUTE, BULK]) {
      const post = src.slice(src.indexOf('export async function POST'))
      expect(post.indexOf('resolveIdentifierScope')).toBeLessThan(post.indexOf('await req.json()'))
    }
  })

  it('a malformed id still cannot produce a 500', () => {
    const fn = SCOPE.slice(SCOPE.indexOf('export async function resolveIdentifierScope'))
    expect(fn.indexOf('try {')).toBeLessThan(fn.indexOf('adminDb.doc('))
  })

  it('the decision layer cannot read or write anything at all', () => {
    expect(DECIDE).not.toContain('adminDb')
    expect(DECIDE).not.toContain('firebase')
    expect(DECIDE).not.toContain('fetch(')
  })

  it('a client-supplied pool cannot escape its pass scope', () => {
    // Even when an explicit poolId names another pass's pool, scope still refuses.
    const config = cfg([
      { poolId: 'mine',  label: 'Mine',  passIds: ['a'] },
      { poolId: 'theirs', label: 'Theirs', passIds: ['b'] },
    ])
    const ctx = ctxOf([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }])
    expect(decideAssignment({
      config, lifecycleStatus: 'published',
      registration: { status: 'confirmed', passId: 'a' }, registrationId: 'r',
      pool: config.pools[1], current: NO_IDENTIFIER, ctx, poolUsage: stat(),
    })).toMatchObject({ eligible: false, reason: 'PASS_OUT_OF_POOL_SCOPE' })
  })
})
