// RD-CHECKIN-COUNTER-FIX-01 — the check-in screen must not read counters from Firestore.
//
// These read component sources as TEXT, following the idiom already established by
// stepValidationMigration.test.ts: the absence of a direct client read is a source-level
// fact, and no amount of exercising the attendance endpoint proves that a listener has not
// been reintroduced somewhere else.
//
// Why a source test rather than a component test: this repository runs Vitest in the `node`
// environment with no jsdom and no React Testing Library, and no Firestore rules-testing
// harness. Adding either purely for this sprint would introduce a test framework the brief
// rules out. The invariant that actually regressed is source-level, so that is what is
// pinned here.
//
// The regression being prevented has TWO parts, and both matter:
//   1. `registrationCounters` is denied to the client SDK by firestore.rules.
//   2. Gate check-ins increment `registrationCounters/{slug}/attendanceShards/{k}`, never
//      the base document — so a client reading the base gets a number that never moves,
//      even if the rule were opened.
//
// ═══ RE-ANCHORED BY RD-CHECKIN-2.0 ═══════════════════════════════════════════
// The invariant is UNCHANGED and still worth pinning; what changed is where the
// check-in screen lives. `CheckInClient.tsx` and its four siblings were replaced by
// ONE shared workspace under components/checkin/workspace/, rendered by both the
// organizer page and the gate console. The assertions therefore moved to that
// directory, and two of them were restated against the new names for the same
// facts:
//
//   • the attendance endpoint is now /api/checkin/ops/[eventId] — a gate-shaped
//     response (four numbers) rather than the organizer attendance endpoint, which
//     also returns per-pass breakdowns a gate operator should not receive;
//   • the degraded state is `statsUnavailable` (server-sent) rather than
//     `countsStale` (client-inferred). Same requirement — never present an
//     unreadable aggregate as a real number — enforced one layer earlier.
//
// The "does not zero the counters" assertion is kept verbatim in spirit and made
// stronger: the workspace renders an em dash for null, so a `?? 0` anywhere in the
// header would be the regression.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, join } from 'node:path'

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')

const WORKSPACE_DIR = 'components/checkin/workspace'
const CLIENT        = `${WORKSPACE_DIR}/CheckinWorkspace.tsx`
const HEADER        = `${WORKSPACE_DIR}/AttendanceHeader.tsx`

/** Strips line and block comments so the explanatory comments here are not false positives. */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

describe('the check-in workspace reads attendance from the authorized API, not Firestore', () => {
  const src = code(read(CLIENT))

  it('does not import the Firebase client SDK', () => {
    expect(src).not.toMatch(/from\s+['"]firebase\/firestore['"]/)
  })

  it('does not reference the registrationCounters collection in executable code', () => {
    expect(src).not.toMatch(/registrationCounters/)
  })

  it('holds no Firestore realtime listener', () => {
    expect(src).not.toMatch(/onSnapshot/)
  })

  it('calls the authorized gate endpoint', () => {
    expect(src).toMatch(/\/api\/checkin\/ops\/\$\{encodeURIComponent\(eventId\)\}/)
  })

  it('sends the bearer token with that request', () => {
    expect(src).toMatch(/Authorization:\s*`Bearer \$\{t\}`/)
  })

  it('refreshes from the server after a successful check-in rather than bumping a local number', () => {
    // The previous implementation incremented a client-held count and reconciled
    // later. The counters are the authority, so the workspace re-reads instead —
    // and it must do so from more than one place (admit, undo, walk-in, sync).
    expect(src).toMatch(/load\(\{ quiet: true \}\)/)
    expect(src.match(/load\(\{ quiet: true \}\)/g)?.length ?? 0).toBeGreaterThanOrEqual(4)
    expect(src).not.toMatch(/setCtx\(c => \(c \? \{ \.\.\.c, checkedIn: c\.checkedIn \+ 1 \}/)
  })

  it('surfaces a degraded state instead of presenting stale numbers as current', () => {
    expect(src).toMatch(/statsUnavailable/)
    expect(read(HEADER)).toMatch(/Attendance counts are unavailable/)
  })

  it('renders an unreadable aggregate as a dash, never as zero', () => {
    const header = code(read(HEADER))
    // The formatter is the single place a number becomes text, and it must not be
    // able to turn "unknown" into "0".
    expect(header).toMatch(/typeof n === 'number' \? n\.toLocaleString\('en-IN'\) : '—'/)
    expect(header).not.toMatch(/checkedIn \?\? 0/)
    expect(header).not.toMatch(/totalExpected \?\? 0/)
  })
})

describe('no sibling workspace component reintroduces a counter read', () => {
  const files = readdirSync(resolve(process.cwd(), WORKSPACE_DIR))
    .filter(f => f.endsWith('.tsx'))
    .map(f => join(WORKSPACE_DIR, f).replace(/\\/g, '/'))

  it('covers every component in the workspace directory', () => {
    expect(files.length).toBeGreaterThanOrEqual(5)
    expect(files.some(f => f.endsWith('CheckinWorkspace.tsx'))).toBe(true)
  })

  it.each(
    readdirSync(resolve(process.cwd(), WORKSPACE_DIR))
      .filter(f => f.endsWith('.tsx'))
      .filter(f => statSync(resolve(process.cwd(), WORKSPACE_DIR, f)).isFile()),
  )('%s does not read registrationCounters from the client', file => {
    const src = code(read(`${WORKSPACE_DIR}/${file}`))
    expect(src).not.toMatch(/registrationCounters/)
    expect(src).not.toMatch(/onSnapshot/)
  })
})

describe('the server side of the contract is unchanged', () => {
  it('gate check-ins still write to the attendance SHARD, not the base counter', () => {
    // If this ever flips back to the base document, the client could legitimately read the
    // base again — and this test should be the thing that prompts that conversation.
    const counters = read('lib/firebase/firestore/registrationCounters.ts')
    expect(counters).toMatch(/txn\.set\(\s*attendanceShardRef\(/)
  })

  it('firestore.rules still denies registrationCounters to clients', () => {
    const rules = read('firestore.rules')
    const block = /match \/registrationCounters\/\{docId\} \{\s*allow read, write: if false;/
    expect(rules).toMatch(block)
  })
})
