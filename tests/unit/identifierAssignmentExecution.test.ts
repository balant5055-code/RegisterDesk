// RD-EVENT-19E — Identifier assignment execution.
//
// THE RULE. This is the phase that writes identifiers onto real people, so every
// structural guarantee has to be checked at the source as well as in the emulator:
//   1. ONE engine. Every identifier is still minted by allocateIdentifier.
//   2. ONE job architecture. This is a strategy on the platform kernel, not a
//      second runner with its own leases and cursors.
//   3. IDEMPOTENCY is enforced INSIDE the transaction, not by a client guard.
//   4. ALL PASSES creates one job per pass. A pass with no pool is refused, never
//      folded into another pass's pool.
//   5. The client never sends registration ids and never downloads the roster.
//   6. The server gates the commit; a disabled button is not a security boundary.
//
// Source assertions are comment-stripped so prose cannot satisfy them.

import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

vi.mock('@/lib/firebase/admin', () => ({ adminDb: {} }))

import { planScopes } from '@/lib/identifiers/assignmentJob'
import { defaultIdentifierConfig } from '@/lib/identifiers/config'
import type { IdentifierConfig, IdentifierPool } from '@/lib/identifiers/types'

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

const JOB    = code(read('lib/identifiers/assignmentJob.ts'))
const ENGINE = code(read('lib/identifiers/engine.ts'))
const TYPES  = code(read('lib/identifiers/types.ts'))
const CREATE = code(read('app/api/organizer/events/[eventId]/identifiers/assign-jobs/route.ts'))
const PROC   = code(read('app/api/organizer/events/[eventId]/identifiers/assign-jobs/[jobId]/process/route.ts'))
const CRON   = code(read('app/api/cron/identifier-assign/route.ts'))
const TAB    = code(read('app/(dashboard)/dashboard/events/[eventId]/tabs/SportsTab.tsx'))
const WORKFLOW = read('.github/workflows/cron-runners.yml')

const cfg = (pools: IdentifierPool[]): IdentifierConfig =>
  ({ ...defaultIdentifierConfig('evt'), pools, defaultPoolId: pools[0]?.poolId ?? 'default' })

// ════════════════════════════════════════════════════════════════════════════
// 1 — ONE ENGINE, ONE JOB ARCHITECTURE
// ════════════════════════════════════════════════════════════════════════════

describe('1 — nothing was duplicated', () => {
  it('every identifier is still minted by the canonical engine', () => {
    expect(JOB).toContain('allocateIdentifier(')
    // No parallel allocator, no second locking scheme.
    for (const banned of ['identifierLocks', 'identifierCounters', 'runTransaction(async txn',
                          'nextNumberInRanges', 'formatIdentifier']) {
      expect(JOB, banned).not.toContain(banned)
    }
  })

  it('it is a strategy on the PLATFORM job kernel, not a new runner', () => {
    expect(JOB).toContain("from '@/lib/jobs/kernel'")
    expect(JOB).toContain("from '@/lib/jobs/runner'")
    expect(JOB).toContain('runJobChunk(')
    // No home-grown leasing/cursoring.
    for (const banned of ['lockedUntil', 'leaseJob(', 'commitChunk(']) {
      expect(JOB, banned).not.toContain(banned)
    }
  })

  it('eligibility and pass scope come from the 19C decision model', () => {
    expect(JOB).toContain('decidePoolScope(')
    expect(JOB).toContain('resolveEventAssignmentGate(')
    expect(JOB).toContain('poolsServingPass(')
    // No second eligibility predicate.
    expect(JOB).not.toMatch(/status === 'cancelled'/)
  })

  it('the selected status is taken from the 19A roster constant, not typed again', () => {
    expect(JOB).toContain('ROSTER_STATUSES[0]')
    expect(JOB).not.toMatch(/=== 'confirmed'/)
  })

  it('the cron reuses the same chunk processor as the routes', () => {
    expect(CRON).toContain('processIdentifierAssignmentChunk')
    expect(CRON).not.toContain('runJobChunk')
    expect(PROC).toContain('processIdentifierAssignmentChunk')
  })

  it('exactly ONE scheduler drives the cron route', () => {
    expect(WORKFLOW).toContain('/api/cron/identifier-assign')
    const vercel = read('vercel.json')
    expect(vercel).not.toContain('identifier-assign')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 2 — IDEMPOTENCY
// ════════════════════════════════════════════════════════════════════════════

describe('2 — a repeat can never re-number somebody', () => {
  it('the guard lives INSIDE the transaction, before any read or write', () => {
    const alloc = ENGINE.slice(
      ENGINE.indexOf('export async function allocateIdentifier'),
      ENGINE.indexOf('export async function autoAssignIfEnabled'),
    )
    const guard = alloc.indexOf('input.skipIfAssigned')
    expect(guard).toBeGreaterThan(-1)
    expect(guard).toBeGreaterThan(alloc.indexOf('adminDb.runTransaction'))
    // Before the counter is read and before any write.
    expect(guard).toBeLessThan(alloc.indexOf('const cRef = counterRef'))
    expect(guard).toBeLessThan(alloc.indexOf('txn.set(lRef'))
  })

  it('the job always allocates with it', () => {
    expect(JOB).toContain('skipIfAssigned: true')
  })

  it('it is OPTIONAL, so existing callers are byte-identical', () => {
    expect(TYPES).toContain('skipIfAssigned?: boolean')
    expect(TYPES).toContain('alreadyAssigned?: boolean')
    // Nothing else in the platform turns it on implicitly.
    const CHECKIN = code(read('app/api/checkin/scan/route.ts'))
    expect(CHECKIN).not.toContain('skipIfAssigned')
  })

  it('an already-assigned participant is reported, not silently counted as new', () => {
    expect(JOB).toContain('r.alreadyAssigned')
    expect(JOB).toContain("'ALREADY_ASSIGNED'")
    expect(JOB).toContain('skipped: true')
  })

  it('the tally is ATOMIC and AWAITED — a result must not undercount itself', () => {
    expect(JOB).toContain('FieldValue.increment(1)')
    expect(JOB).toContain('await tally(')
    // The fire-and-forget version could be read before it landed.
    expect(JOB).not.toContain('void tally(')
    // `update()` is required for a dotted path to mean a path.
    expect(JOB).toContain('.update(patch)')
    expect(JOB).not.toMatch(/set\(patch, \{ merge/)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 3 — ALL PASSES / SCOPE PLANNING
// ════════════════════════════════════════════════════════════════════════════

describe('3 — one job per pass, and a pass with no pool is refused', () => {
  const passes = [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }, { id: 'c', name: 'Gamma' }]
  const config = cfg([
    { poolId: 'pa', label: 'A', passIds: ['a'], ranges: [{ start: 1, end: 99 }] },
    { poolId: 'pb', label: 'B', passIds: ['b'], ranges: [{ start: 100, end: 199 }] },
  ])

  it('ALL PASSES plans one scope per pass, each on its own pool', () => {
    const s = planScopes(config, passes.slice(0, 2), { kind: 'all_passes' })
    expect(s.map(x => [x.passId, x.poolId])).toEqual([['a', 'pa'], ['b', 'pb']])
  })

  it('a pass with NO pool is BLOCKED, never given another pass\'s pool', () => {
    const s = planScopes(config, passes, { kind: 'all_passes' })
    const gamma = s.find(x => x.passId === 'c')!
    expect(gamma.poolId).toBeNull()
    expect(gamma.blocked).toBe('POOL_MISSING')
    expect(['pa', 'pb']).not.toContain(gamma.poolId)
  })

  it('one selected pass plans exactly one scope', () => {
    expect(planScopes(config, passes, { kind: 'pass', passIds: ['b'] }))
      .toEqual([{ passId: 'b', passName: 'Beta', poolId: 'pb', blocked: null }])
  })

  it('a duplicated pass is planned once', () => {
    expect(planScopes(config, passes, { kind: 'pass', passIds: ['a', 'a'] })).toHaveLength(1)
  })

  it('an event with no passes gets ONE unrestricted scope', () => {
    const open = cfg([{ poolId: 'def', label: 'D' }])
    expect(planScopes(open, [], { kind: 'all_passes' }))
      .toEqual([{ passId: null, passName: null, poolId: 'def', blocked: null }])
  })

  it('an event with no passes and no unrestricted pool is blocked', () => {
    const scoped = cfg([{ poolId: 'pa', label: 'A', passIds: ['a'] }])
    expect(planScopes(scoped, [], { kind: 'all_passes' })[0].blocked).toBe('POOL_MISSING')
  })

  it('several pools for one pass use the FIRST in configuration order', () => {
    const many = cfg([
      { poolId: 'first',  label: 'F', passIds: ['a'] },
      { poolId: 'second', label: 'S', passIds: ['a'] },
    ])
    expect(planScopes(many, passes, { kind: 'pass', passIds: ['a'] })[0].poolId).toBe('first')
  })

  it('planning is deterministic', () => {
    const a = JSON.stringify(planScopes(config, passes, { kind: 'all_passes' }))
    const b = JSON.stringify(planScopes(config, passes, { kind: 'all_passes' }))
    expect(a).toBe(b)
  })

  it('a legacy matchRule pool is planned like any other', () => {
    const legacy = cfg([{ poolId: 'lg', label: 'L', matchRule: { by: 'pass', values: ['a'] } }])
    expect(planScopes(legacy, passes, { kind: 'pass', passIds: ['a'] })[0].poolId).toBe('lg')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 4 — READ / WRITE BUDGET
// ════════════════════════════════════════════════════════════════════════════

describe('4 — the browser never carries the roster, and the server never scans it', () => {
  it('the client sends a SELECTION, never registration ids', () => {
    expect(CREATE).toContain('selection')
    expect(CREATE).not.toContain('registrationIds')
    const plan = TAB.slice(TAB.indexOf('async function execute'), TAB.indexOf('async function stop'))
    expect(plan).toContain('JSON.stringify(body)')
    expect(plan).toContain('selection')
    expect(plan).not.toContain('registrationIds')
    // The body carries pass ids at most — never participants.
    expect(plan).toContain('passIds: runnablePassIds')
  })

  it('the roster is PAGED server-side with a real cursor', () => {
    expect(JOB).toContain('FieldPath.documentId()')
    expect(JOB).toContain('.startAfter(cursor)')
    expect(JOB).toContain('.limit(limit)')
    // No unbounded read anywhere in the job.
    expect(JOB).not.toMatch(/\.where\([^)]*\)\s*\.get\(\)/)
  })

  it('the page projects only what it needs — no attendee PII is read', () => {
    // RD-BIB-01 · `registeredAt` joined the projection so registration-order paging
    // has a cursor. It is a timestamp, not PII, and the rule below is unchanged.
    expect(JOB).toContain(".select('passId', 'identifier', 'registeredAt')")
    for (const f of ['attendee', 'email', 'phone']) expect(JOB).not.toContain(f)
  })

  it('no items subcollection is written before a single identifier exists', () => {
    expect(JOB).not.toContain("collection('items')")
    expect(JOB).not.toContain('.collection(\'items\')')
  })

  it('the config and lifecycle are read ONCE per chunk, not per participant', () => {
    const ctxFn = JOB.slice(JOB.indexOf('async function loadContext'), JOB.indexOf('async function fetchPage'))
    expect(ctxFn).toContain('resolveIdentifierConfig')
    const item = JOB.slice(JOB.indexOf('async processItem'), JOB.indexOf('export async function processIdentifierAssignmentChunk'))
    expect(item).not.toContain('resolveIdentifierConfig')
    expect(item).not.toContain('eventDrafts')
  })

  it('processItem performs no extra registration read', () => {
    const item = JOB.slice(JOB.indexOf('async processItem'), JOB.indexOf('export async function processIdentifierAssignmentChunk'))
    expect(item).not.toContain("collection('registrations')")
    expect(item).toContain('item.hasIdentifier')
  })

  it('the client drives work rather than polling for a change', () => {
    const plan = TAB.slice(TAB.indexOf('async function execute'), TAB.indexOf('async function stop'))
    expect(plan).toContain('/process')
    expect(plan).not.toContain('setInterval')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 5 — SECURITY
// ════════════════════════════════════════════════════════════════════════════

describe('5 — the server decides everything that matters', () => {
  it('both routes resolve scope before anything else', () => {
    for (const src of [CREATE, PROC]) {
      expect(src).toContain('resolveIdentifierScope')
      const post = src.slice(src.indexOf('export async function POST'))
      expect(post.indexOf('resolveIdentifierScope')).toBeLessThan(post.indexOf('req.json()') + 1 || 1e9)
    }
  })

  it('the COMMIT is server-gated by the lifecycle, not by a disabled button', () => {
    expect(CREATE).toContain('resolveEventAssignmentGate(scope.lifecycleStatus)')
    const post = CREATE.slice(CREATE.indexOf('export async function POST'))
    expect(post.indexOf('resolveEventAssignmentGate')).toBeLessThan(post.indexOf('createIdentifierAssignmentJob'))
    expect(post).toContain('status: 409')
  })

  it('the job re-checks the gate every chunk, so an event locked mid-run stops', () => {
    expect(JOB).toContain('resolveEventAssignmentGate(lifecycleStatus)')
    expect(JOB).toContain('if (!gate.open) return { ok: false')
  })

  it('a client-named pass is only a SELECTOR — the pool comes from stored config', () => {
    expect(CREATE).toContain('planScopes(')
    // The request body is never read for a poolId.
    expect(CREATE).not.toMatch(/body[^\n]*poolId/)
    expect(CREATE).toContain('scope.passes')
  })

  it('a pass this event does not have is refused', () => {
    expect(CREATE).toContain('known.has(s.passId)')
    expect(CREATE).toContain("reason: 'PASS_MISSING'")
  })

  it('job ownership is proved from the STORED job document', () => {
    expect(PROC).toContain('job.organizerUid !== scope.workspaceUid')
    expect(PROC).toContain('job.eventId !== eventId')
    expect(PROC).toContain("status: 404")
  })

  it('no client-supplied uid is trusted anywhere', () => {
    for (const src of [CREATE, PROC]) {
      expect(src).not.toMatch(/body\.(uid|organizerUid)/)
    }
    expect(JOB).toContain('job.organizerUid')
  })

  it('the actor recorded in history is the authenticated caller', () => {
    expect(CREATE).toContain('createdBy: scope.callerUid')
    expect(JOB).toContain('actor:          job.createdBy || job.organizerUid')
  })

  it('the cron is fail-closed', () => {
    expect(CRON).toContain('isAuthorizedCron(req)')
    expect(CRON).toContain('cronUnauthorized()')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 6 — CONFIRMATION AND RESULT HONESTY
// ════════════════════════════════════════════════════════════════════════════

describe('6 — the organizer is told the truth before and after', () => {
  it('execution is confirmed, never a casual click', () => {
    const plan = TAB.slice(TAB.indexOf('async function execute'), TAB.indexOf('async function stop'))
    expect(plan).toContain('await confirm({')
    expect(plan.indexOf('await confirm({')).toBeLessThan(plan.indexOf('/assign-jobs'))
  })

  it('the confirmation names the identifier by its CONFIGURED label', () => {
    const plan = TAB.slice(TAB.indexOf('async function execute'), TAB.indexOf('async function stop'))
    // RD-BIB-TIMING-03 · RE-ANCHORED for CASE only. The rule — the confirmation
    // names the identifier by its CONFIGURED label and never a built-in word — is
    // unchanged and still asserted on the last line. What changed is that the
    // configured label is now printed exactly as the organizer typed it, so one
    // screen cannot read "BIB Numbers assigned" beside "needs a bib number".
    expect(plan).toContain('${label}')
    expect(plan).not.toContain('${label.toLowerCase()}')
    expect(plan).not.toMatch(/Assign BIBs|bib/i)
  })

  // RD-BIB-01 · INVERTED. The figure IS establishable now — the countable
  // `hasIdentifier` mirror makes it an exact aggregate — so the confirmation states
  // it, and admits the gap only when the roster is not fully covered by the field.
  it('the confirmation states the figure when it is provable, and admits it when not', () => {
    const plan = TAB.slice(TAB.indexOf('async function execute'), TAB.indexOf('async function stop'))
    expect(plan).toContain('will assign')
    expect(plan).toContain('an unverified number of')
    expect(plan).toContain('predate')
    expect(plan).toContain('cannot be undone')
  })

  it('the confirmation lists every scope separately', () => {
    const plan = TAB.slice(TAB.indexOf('async function execute'), TAB.indexOf('async function stop'))
    expect(plan).toContain('runnableRows.map')
    expect(plan).toContain('r.passName')
  })

  it('the result shows what was COMMITTED — never rolled back to zero', () => {
    const res = TAB.slice(TAB.indexOf('function RunResult'), TAB.indexOf('// ─── POOLS + RANGE EDITOR'))
    expect(res).toContain('Assigned')
    expect(res).toContain('Left alone')
    // RD-BIB-01 · the figure was headed "Failed", which is what an exhausted range
    // looked like to an organizer: an error, rather than a range that ran out. The
    // count is the same number; only the word it is given changed.
    expect(res).toContain('Not assigned')
    expect(res).toContain('n(c.failed)')
    expect(res).toContain('Processed')
    expect(res).toContain('Everything above is committed')
  })

  it('the result prints the range it ACTUALLY issued, not a span', () => {
    const res = TAB.slice(TAB.indexOf('function RunResult'), TAB.indexOf('// ─── POOLS + RANGE EDITOR'))
    expect(res).toContain('job.firstValue')
    expect(res).toContain('job.lastValue')
    expect(res).toContain('Any configured gap was skipped')
  })

  it('every reason is a sentence or a readable label, never a raw code', () => {
    const res = TAB.slice(TAB.indexOf('const REASON_LABEL'), TAB.indexOf('function RunResult'))
    for (const key of ['ALREADY_ASSIGNED', 'POOL_EXHAUSTED', 'VALUE_CONFLICT', 'PASS_OUT_OF_POOL_SCOPE']) {
      expect(res).toContain(key)
    }
    expect(TAB).toContain('REASON_LABEL[reason] ?? reason')
  })

  it('no progress meter is drawn for an unknown total', () => {
    const res = TAB.slice(TAB.indexOf('function RunResult'), TAB.indexOf('// ─── POOLS + RANGE EDITOR'))
    expect(res).toContain('c.total > 0 ?')
    expect(res).toContain('percent !== null &&')
  })

  it('a run in progress is announced to assistive technology', () => {
    const res = TAB.slice(TAB.indexOf('function RunResult'), TAB.indexOf('// ─── POOLS + RANGE EDITOR'))
    expect(res).toContain('aria-live="polite"')
    expect(res).toContain('aria-busy={running}')
  })

  it('the run can be stopped, and stopping keeps what was committed', () => {
    expect(TAB).toContain('async function stop()')
    expect(TAB).toContain("method: 'DELETE'")
    expect(TAB).toContain('already assigned is kept')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 7 — EVENT-TYPE NEUTRALITY
// ════════════════════════════════════════════════════════════════════════════

describe('7 — execution names no sport', () => {
  for (const [name, src] of [['job', JOB], ['create route', CREATE], ['cron', CRON]] as const) {
    it(`${name} is event-type neutral`, () => {
      // `runner` is excluded from the sweep by removing the platform job runner's
      // own import and identifiers first — it is the generic job RUNNER these files
      // are built on, not a participant in a road race.
      const scrubbed = src
        .replace(/@\/lib\/jobs\/runner/g, '@/lib/jobs/JOBRUNNER')
        .replace(/runJobChunk|JobStrategy|RunnerConfig/g, 'X')
      for (const w of [/\brunner\b/i, /\bmarathon/i, /\bfinisher/i, /\brace\b/i, /\blane\b/i,
                       /\b5\s?km\b/i, /\b10\s?km\b/i]) {
        expect(scrubbed, `${name}: ${w}`).not.toMatch(w)
      }
    })
  }

  it('the job carries the configured label as DATA', () => {
    expect(JOB).toContain('label:      string')
    expect(CREATE).toContain('label: config.label')
  })

  it('no "bib" outside the legacy compatibility names', () => {
    for (const raw of JOB.split('\n')) {
      const line = raw.split('//')[0]
      if (!/bib/i.test(line)) continue
      expect(/bibNumber|bibCategory|bibLocks/.test(line), line.trim()).toBe(true)
    }
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 8 — UNRESOLVED PRODUCT DECISIONS ARE PRESERVED, NOT DECIDED
// ════════════════════════════════════════════════════════════════════════════

describe('8 — 19E decides no policy that 19A/19C left open', () => {
  it('selection preserves the SHIPPED roster rule and says so', () => {
    expect(JOB).toContain('ROSTER_STATUSES[0]')
    const src = read('lib/identifiers/assignmentJob.ts')
    expect(src).toContain('THIS IS NOT A NEW PRODUCT DECISION')
    expect(src).toMatch(/pending.*waitlisted|waitlisted.*pending/)
  })

  it('paymentStatus is still not consulted — refunded stays an open question', () => {
    expect(JOB).not.toContain('paymentStatus')
    expect(JOB).not.toContain('refunded')
  })

  it('partial completion is the EXISTING contract, reported rather than hidden', () => {
    // Row-by-row failure was already how bulk behaved; exhaustion is counted, not
    // swallowed, and the committed rows stay committed.
    expect(JOB).toContain("reason = err instanceof IdentifierError ? err.code")
    expect(JOB).toContain('return { ok: false, error: reason }')
  })

  // RD-BIB-01 · INVERTED, and this is the headline of the phase. 19E could not state
  // how many numbers a run would issue, so it correctly refused to. The countable
  // `hasIdentifier` mirror makes it an exact aggregate, and the coverage check keeps
  // the refusal for any roster the field does not fully cover.
  it('the tab states the count when it is proven, and says why when it is not', () => {
    expect(TAB).toContain('label="Will be assigned"')
    expect(TAB).toContain('row.willAssign === null')
    expect(TAB).toContain('Cannot verify yet')
    // never a subtraction in the UI
    expect(TAB).not.toMatch(/eligibles*-s*assigned/)
  })
})
