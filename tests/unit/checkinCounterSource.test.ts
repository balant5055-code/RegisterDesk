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

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, join } from 'node:path'

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')

const CHECKIN_DIR = 'app/(dashboard)/dashboard/events/[eventId]/checkin'
const CLIENT      = `${CHECKIN_DIR}/CheckInClient.tsx`

/** Strips line and block comments so the explanatory comments here are not false positives. */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

describe('CheckInClient reads attendance from the authorized API, not Firestore', () => {
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

  it('calls the existing authorized attendance endpoint', () => {
    expect(src).toMatch(/\/api\/organizer\/events\/\$\{eventId\}\/attendance/)
  })

  it('sends the bearer token with that request', () => {
    expect(src).toMatch(/Authorization:\s*`Bearer \$\{token\}`/)
  })

  it('reads confirmedRegistrations, matching the counter base the UI has always shown', () => {
    // `totalRegistrations` would silently change what the denominator means and make the
    // figure jump on the first refresh.
    expect(src).toMatch(/data\.confirmedRegistrations/)
    expect(src).toMatch(/data\.checkedInCount/)
  })

  it('refreshes after a successful check-in rather than trusting the optimistic bump', () => {
    expect(src).toMatch(/refreshAttendance/)
    // The optimistic increment is retained (established pattern) but must be followed by a
    // server read — so more than one call site exists.
    expect(src.match(/refreshAttendance\(\)/g)?.length ?? 0).toBeGreaterThanOrEqual(4)
  })

  it('surfaces a degraded state instead of presenting stale numbers as current', () => {
    expect(src).toMatch(/countsStale/)
    expect(read(CLIENT)).toMatch(/Attendance count unavailable/)
  })

  it('does not zero the counters when the refresh fails', () => {
    // A `setLiveCheckedIn(0)` / `setLiveTotal(0)` in the failure path would show 0 as
    // though it were a real count — the exact dishonesty this sprint removes.
    expect(src).not.toMatch(/setLive(CheckedIn|Total)\(0\)/)
  })
})

describe('no sibling check-in component reintroduces a counter read', () => {
  const files = readdirSync(resolve(process.cwd(), CHECKIN_DIR))
    .filter(f => f.endsWith('.tsx'))
    .map(f => join(CHECKIN_DIR, f).replace(/\\/g, '/'))

  it('covers every component in the check-in directory', () => {
    expect(files.length).toBeGreaterThanOrEqual(5)
    expect(files.some(f => f.endsWith('CheckInClient.tsx'))).toBe(true)
  })

  it.each(
    readdirSync(resolve(process.cwd(), CHECKIN_DIR))
      .filter(f => f.endsWith('.tsx'))
      .filter(f => statSync(resolve(process.cwd(), CHECKIN_DIR, f)).isFile()),
  )('%s does not read registrationCounters from the client', file => {
    const src = code(read(`${CHECKIN_DIR}/${file}`))
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
