// RD-CHECKIN-STAFF-02 · a gate operator can actually reach their gate.
//
// ═══ WHAT WENT WRONG, AND WHY TESTS DID NOT CATCH IT ═════════════════════════
// Three defects that were each individually invisible to a green suite, because every one
// of them is a decision about REAL DATA rather than a branch that throws:
//
//   1. The guard redirected to `eventIds[0]`. With one assignment that is right by
//      accident; with two it is a coin flip. On the live account the coin landed on a
//      two-registration test event while the actual race sat at index 1.
//   2. The guard latched itself off BEFORE awaiting anything, and swallowed every failure.
//      One expired token on the first paint and the operator was parked on a dashboard
//      that shows them nothing, for the rest of the session.
//   3. Ownership was inferred from `users/{uid}.role === 'organizer'`. Both live gate
//      operators have that row and own zero events, so the ownership fix — written to stop
//      cross-workspace reads — would have resolved them to their own empty workspace and
//      cut them off from check-in entirely.
//
// So the resolver is tested BEHAVIOURALLY against the exact live shapes (organizer profile
// present, zero drafts, one membership), not by reading its source. The two client surfaces
// are pinned at the source level, because what matters about them is the absence of a
// choice — `eventIds[0]`, a permanent latch — and absence is what source assertions prove.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const read  = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

// ─────────────────────────────────────────────────────────────────────────────
// A minimal Firestore stand-in. `drafts` is the ONLY thing under test here: it is
// the evidence the resolver is now required to use.
// ─────────────────────────────────────────────────────────────────────────────

interface Fixture {
  drafts:      Record<string, number>     // uid → number of eventDrafts
  draftsThrow: boolean
}

const fixture: Fixture = { drafts: {}, draftsThrow: false }

const memberships = vi.fn()

vi.mock('@/lib/firebase/admin', () => ({
  adminDb: {
    collection: (name: string) => ({
      doc: (uid: string) => ({
        // Present for EVERY uid, with role 'organizer' — deliberately mirroring live data,
        // where this row exists for gate operators too. If the resolver ever consults it
        // again, these tests still pass it and the behavioural assertions below fail.
        get: async () => ({ exists: true, data: () => ({ role: 'organizer' }) }),
        collection: (sub: string) => ({
          limit: () => ({
            get: async () => {
              if (fixture.draftsThrow) throw new Error('firestore unavailable')
              const n = name === 'users' && sub === 'eventDrafts' ? (fixture.drafts[uid] ?? 0) : 0
              return { empty: n === 0, docs: Array.from({ length: n }, () => ({})) }
            },
          }),
        }),
      }),
    }),
  },
}))

vi.mock('@/lib/team/access', () => ({
  verifyCaller:      vi.fn(),
  requirePermission: vi.fn(),
  activeMemberships: (uid: string) => memberships(uid),
}))

// The two live accounts, by their real shape.
const STAFF_UID = 'staffUid'
const OWNER_UID = 'ownerUid'
const ORG_UID   = 'invitingOrganizerUid'
const LIVE_EVENT = '76lLBPiwauEpj1eWmDlj'
const TEST_EVENT = 'k31aQSYy0LQd9JhFDUUG'

const staffMembership = {
  organizerUid: ORG_UID,
  role:         'checkin_staff' as const,
  eventIds:     [TEST_EVENT, LIVE_EVENT],
}

beforeEach(() => {
  fixture.drafts = {}
  fixture.draftsThrow = false
  memberships.mockReset()
})

afterEach(() => { vi.resetModules() })

async function resolveFor(uid: string) {
  const { resolveWorkspaceUid } = await import('@/lib/team/workspace')
  return resolveWorkspaceUid(uid)
}

// ─── 1 · the resolver, against live shapes ───────────────────────────────────

describe('resolveWorkspaceUid: ownership needs evidence', () => {
  it('a checkin_staff member with an organizer profile and ZERO events resolves to the INVITING workspace', async () => {
    // THE REGRESSION. This is exactly reach.vpe@gmail.com and punjaimarathon@gmail.com:
    // users/{uid}.role === 'organizer', zero eventDrafts, one active membership.
    memberships.mockResolvedValue([staffMembership])
    fixture.drafts = {}                                  // owns nothing

    const ctx = await resolveFor(STAFF_UID)

    expect(ctx.workspaceUid).toBe(ORG_UID)               // NOT their own empty workspace
    expect(ctx.isOwner).toBe(false)
    expect(ctx.role).toBe('checkin_staff')
    expect(ctx.eventIds).toEqual([TEST_EVENT, LIVE_EVENT])
    expect(ctx.permissions).toEqual(['checkin'])         // and no more than that
  })

  it('an owner who ALSO holds a membership still resolves to their OWN workspace', async () => {
    // The ac80b07 fix, preserved. Evidence of ownership is present, so ownership wins.
    memberships.mockResolvedValue([staffMembership])
    fixture.drafts = { [OWNER_UID]: 1 }

    const ctx = await resolveFor(OWNER_UID)

    expect(ctx.workspaceUid).toBe(OWNER_UID)
    expect(ctx.isOwner).toBe(true)
    expect(ctx.role).toBe('owner')
  })

  it('an owner with no memberships never pays for the evidence read', async () => {
    memberships.mockResolvedValue([])
    fixture.draftsThrow = true      // would throw if consulted

    const ctx = await resolveFor(OWNER_UID)

    expect(ctx.workspaceUid).toBe(OWNER_UID)
    expect(ctx.isOwner).toBe(true)
  })

  it('an unreadable evidence read fails CLOSED — towards self, never into a membership', async () => {
    memberships.mockResolvedValue([staffMembership])
    fixture.draftsThrow = true

    const ctx = await resolveFor(STAFF_UID)

    // The safe direction: a transient Firestore failure can only ever show the caller
    // their own data. It must never be able to open another organizer's workspace.
    expect(ctx.workspaceUid).toBe(STAFF_UID)
    expect(ctx.workspaceUid).not.toBe(ORG_UID)
    expect(ctx.isOwner).toBe(true)
  })

  it('the organizer profile row alone is never enough', async () => {
    // Every uid in this fixture has role: 'organizer'. If that were still the signal, the
    // first test in this block would resolve to self — so this pins the discrimination
    // rather than the implementation.
    memberships.mockResolvedValue([staffMembership])
    fixture.drafts = { [ORG_UID]: 12 }        // the INVITER owns plenty; the caller none

    const ctx = await resolveFor(STAFF_UID)

    expect(ctx.workspaceUid).toBe(ORG_UID)
    expect(ctx.isOwner).toBe(false)
  })
})

// ─── 2 · the guard's redirect target ─────────────────────────────────────────

describe('CheckinStaffGuard: never guesses which event', () => {
  const GUARD = strip(read('components/dashboard/CheckinStaffGuard.tsx'))

  it('does not redirect to eventIds[0] on a merely non-empty list', () => {
    // The defect, stated precisely. Reading element 0 is fine once the list is known to
    // hold exactly one; what was wrong was reading it whenever the list was non-empty.
    expect(GUARD).not.toContain('info.eventIds.length > 0')
    expect(GUARD).not.toMatch(/eventIds\.length\s*(>|>=)\s*\d/)
    // And there is only ONE indexed read, so the guarded-ness proven below covers it all.
    expect(GUARD.match(/eventIds\[0\]/g)).toHaveLength(1)
  })

  it('goes straight to the gate ONLY when exactly one event is assigned', () => {
    expect(GUARD).toContain('info.eventIds.length === 1')
    expect(GUARD).toContain('`/ops/checkin/${encodeURIComponent(info.eventIds[0])}`')
    // …and that single-element read is guarded by the length check, not standalone.
    const cond = GUARD.indexOf('info.eventIds.length === 1')
    const use  = GUARD.indexOf('encodeURIComponent(info.eventIds[0])')
    expect(cond).toBeGreaterThan(-1)
    expect(cond).toBeLessThan(use)
  })

  it('sends every other case to /ops to choose', () => {
    expect(GUARD).toContain(": '/ops'")
  })
})

// ─── 3 · the guard's failure behaviour ───────────────────────────────────────

describe('CheckinStaffGuard: a transient failure is not permanent', () => {
  const GUARD = strip(read('components/dashboard/CheckinStaffGuard.tsx'))

  it('does not latch before awaiting anything', () => {
    // The defect: `checked.current = true` sat on the line after the early return, so the
    // guard disabled itself whether or not it ever got an answer.
    expect(GUARD).not.toMatch(/if \(!user \|\| \w+\.current\) return\s*\n\s*\w+\.current = true/)
  })

  it('latches only AFTER a definitive answer', () => {
    const latch = GUARD.indexOf('resolved.current = true\n')
    const parse = GUARD.indexOf('await res.json()')
    expect(latch).toBeGreaterThan(-1)
    expect(parse).toBeGreaterThan(-1)
    expect(latch).toBeGreaterThan(parse)
  })

  it('retries a bounded number of times rather than once', () => {
    expect(GUARD).toContain('RETRY_DELAYS_MS')
    const delays = GUARD.match(/RETRY_DELAYS_MS = \[([^\]]+)\]/)
    expect(delays).not.toBeNull()
    expect(delays![1].split(',').length).toBeGreaterThan(1)
    expect(delays![1].split(',').length).toBeLessThan(6)   // bounded: a hint must not spin
  })

  it('retries the failures that are actually transient', () => {
    expect(GUARD).toContain('res.status === 401 || res.status >= 500')
    expect(GUARD).toContain('if (!token) continue')
    expect(GUARD).toMatch(/catch \{\s*continue/)
  })

  it('still respects a genuine refusal instead of hammering it', () => {
    expect(GUARD).toMatch(/if \(!res\.ok\) \{ resolved\.current = true; return \}/)
  })

  it('is still only a routing hint — it grants nothing', () => {
    expect(GUARD).not.toContain('permission')
    expect(GUARD).not.toContain('role ===')
    expect(GUARD).toContain('info.checkinOnly')
  })
})

// ─── 4 · the /ops landing surface ────────────────────────────────────────────

describe('/ops: a real destination, built only from what the operator already has', () => {
  const PAGE   = strip(read('app/ops/page.tsx'))
  const CLIENT = strip(read('app/ops/OpsIndexClient.tsx'))

  it('links each assigned event to its own gate', () => {
    expect(CLIENT).toContain('`/ops/checkin/${encodeURIComponent(gate.eventId)}`')
  })

  it('reuses the two existing endpoints and invents no new one', () => {
    expect(CLIENT).toContain("'/api/organizer/workspace'")
    expect(CLIENT).toContain('`/api/checkin/ops/${encodeURIComponent(eventId)}`')
    // Nothing else. In particular, no organizer events listing.
    const apis = [...CLIENT.matchAll(/['`](\/api\/[^'`]+)['`]/g)].map(m => m[1])
    expect(apis.every(a =>
      a === '/api/organizer/workspace' || a.startsWith('/api/checkin/ops/'))).toBe(true)
  })

  it('never asks for the events permission', () => {
    expect(CLIENT).not.toContain("'events'")
    expect(CLIENT).not.toContain('/api/organizer/events')
  })

  it('keeps an empty state when nothing is assigned', () => {
    expect(CLIENT).toContain('ws.eventIds.length === 0')
    expect(CLIENT).toContain('Open the check-in link your organizer shared with you')
  })

  it('shows a closed gate as closed rather than as a link that would fail', () => {
    // The render branches on whether the gate refused, and ONLY the open branch is a Link.
    expect(CLIENT).toContain('gate.closed === null ? (')
    const branch = CLIENT.slice(CLIENT.indexOf('gate.closed === null ? ('))
    const elseAt = branch.indexOf(') : (')
    const closedBranch = branch.slice(elseAt, branch.indexOf('</li>'))
    expect(elseAt).toBeGreaterThan(-1)
    expect(closedBranch).toContain('<div')
    expect(closedBranch).not.toContain('<Link')      // no door that opens onto a refusal
    expect(closedBranch).toContain('{gate.closed}')  // and it says why
  })

  it('the page itself decides nothing', () => {
    expect(PAGE).toContain('OpsIndexClient')
    expect(PAGE).not.toContain('fetch(')
    expect(PAGE).not.toContain('adminDb')
  })
})
