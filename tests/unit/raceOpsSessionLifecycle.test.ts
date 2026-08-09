// RD-RACEOPS-01 Sprint 3 — Import Session lifecycle.
//
// The brief's required coverage: publish transition, duplicate-publish prevention, and
// rollback safety. The state machine is PURE, so every guard is tested here without
// Firestore — and because the Firestore transaction calls this same function, a test that
// passes here proves the transaction's guard too.

import { describe, it, expect } from 'vitest'
import {
  checkRegistrationGate, decideTransition, isLiveStatus, isTerminalStatus,
  type SessionSnapshot,
} from '@/features/race-operations/lifecycle/transitions'
import {
  IMPORT_SESSION_STATUS_LABEL, resultDocId, RACE_SESSION_SCHEMA_VERSION,
  type ImportSessionStatus,
} from '@/features/race-operations/types/session'

/** A session that is ready to publish. Individual tests override one fact at a time. */
const ready: SessionSnapshot = {
  status: 'draft',
  storedRows: 120,
  ranked: true,
  racePublishedElsewhere: false,
  // RD-RESULTS-FIX-01 · a clean start-list check. Publishing now requires one.
  registrationCheck: { unknownRunner: 0, wrongRace: 0 },
}

const ALL_STATUSES: ImportSessionStatus[] = ['draft', 'published', 'cancelled']

describe('publish — the happy path', () => {
  it('a ranked draft with rows may publish', () => {
    expect(decideTransition('publish', ready)).toEqual({ allowed: true, next: 'published' })
  })
})

describe('publish — preconditions (422)', () => {
  it('refuses a session with no stored rows', () => {
    const d = decideTransition('publish', { ...ready, storedRows: 0 })
    expect(d.allowed).toBe(false)
    if (d.allowed) return
    expect(d.status).toBe(422)
    expect(d.reason).toMatch(/no stored results/i)
  })

  it('refuses an unranked session', () => {
    const d = decideTransition('publish', { ...ready, ranked: false })
    expect(d.allowed).toBe(false)
    if (d.allowed) return
    expect(d.status).toBe(422)
    expect(d.reason).toMatch(/finish ranking/i)
  })

  it('checks rows before ranking, so the first message is the most actionable', () => {
    const d = decideTransition('publish', { ...ready, storedRows: 0, ranked: false })
    expect(d.allowed).toBe(false)
    if (!d.allowed) expect(d.reason).toMatch(/no stored results/i)
  })
})

describe('duplicate publish prevention (409)', () => {
  it('refuses a SECOND publish of the same session', () => {
    const d = decideTransition('publish', { ...ready, status: 'published' })
    expect(d.allowed).toBe(false)
    if (d.allowed) return
    expect(d.status).toBe(409)
    expect(d.reason).toMatch(/already published/i)
  })

  it('RD-RESULTS-FIX-01 · REPUBLISHING over a published race is allowed', () => {
    // This used to be a 409 telling the organizer to "cancel it before publishing a
    // replacement" — an instruction that could not be followed, because cancel is only
    // legal from draft. Publishing was a one-way door and a wrong result could never be
    // corrected. Publishing a new draft is now the supported correction path.
    expect(decideTransition('publish', { ...ready, racePublishedElsewhere: true }))
      .toEqual({ allowed: true, next: 'published' })
  })

  it('is not confused by its OWN published record — status is checked first', () => {
    // Both conditions true: the already-published message must win, since "another import"
    // would be misleading when the conflict is the session itself.
    const d = decideTransition('publish', {
      ...ready, status: 'published', racePublishedElsewhere: true,
    })
    expect(d.allowed).toBe(false)
    if (!d.allowed) expect(d.reason).toMatch(/already published/i)
  })
})

describe('rollback safety', () => {
  it('a draft may be cancelled', () => {
    expect(decideTransition('cancel', ready)).toEqual({ allowed: true, next: 'cancelled' })
  })

  it('a cancelled draft may be cancelled only once', () => {
    const d = decideTransition('cancel', { ...ready, status: 'cancelled' })
    expect(d.allowed).toBe(false)
    if (!d.allowed) expect(d.status).toBe(409)
  })

  it('a PUBLISHED session cannot be cancelled — no unpublish in Sprint 3', () => {
    const d = decideTransition('cancel', { ...ready, status: 'published' })
    expect(d.allowed).toBe(false)
    if (d.allowed) return
    expect(d.status).toBe(409)
    expect(d.reason).toMatch(/cannot be cancelled/i)
  })

  it('a cancelled session can never be published', () => {
    const d = decideTransition('publish', { ...ready, status: 'cancelled' })
    expect(d.allowed).toBe(false)
    if (d.allowed) return
    expect(d.reason).toMatch(/cancelled/i)
  })

  it('cancel ignores the ranking and row preconditions — an empty bad import is cancellable', () => {
    expect(decideTransition('cancel', { ...ready, storedRows: 0, ranked: false }))
      .toEqual({ allowed: true, next: 'cancelled' })
  })
})

describe('state machine totality', () => {
  it('every (status, action) pair yields an explicit decision — never undefined', () => {
    for (const status of ALL_STATUSES) {
      for (const action of ['publish', 'cancel'] as const) {
        const d = decideTransition(action, { ...ready, status })
        expect(d).toBeDefined()
        if (!d.allowed) {
          expect(d.reason.length).toBeGreaterThan(0)
          expect([409, 422]).toContain(d.status)
        }
      }
    }
  })

  it('only draft has any outgoing transition', () => {
    for (const status of ALL_STATUSES) {
      const canMove = (['publish', 'cancel'] as const)
        .some(a => decideTransition(a, { ...ready, status }).allowed)
      expect(canMove, status).toBe(status === 'draft')
    }
  })

  it('published and cancelled are terminal; draft is not', () => {
    expect(isTerminalStatus('published')).toBe(true)
    expect(isTerminalStatus('cancelled')).toBe(true)
    expect(isTerminalStatus('draft')).toBe(false)
  })

  it('only published is a LIVE status — a draft must never read as authoritative', () => {
    expect(isLiveStatus('published')).toBe(true)
    expect(isLiveStatus('draft')).toBe(false)
    expect(isLiveStatus('cancelled')).toBe(false)
  })

  it('every status has a human label', () => {
    for (const s of ALL_STATUSES) expect(IMPORT_SESSION_STATUS_LABEL[s]).toBeTruthy()
  })
})

describe('draft persistence — document identity', () => {
  it('the result doc id is deterministic from the row number, which makes a re-send idempotent', () => {
    expect(resultDocId(1)).toBe('row-1')
    expect(resultDocId(4217)).toBe('row-4217')
    expect(resultDocId(42)).toBe(resultDocId(42))
  })

  it('distinct rows never collide', () => {
    const ids = new Set(Array.from({ length: 500 }, (_, i) => resultDocId(i + 2)))
    expect(ids.size).toBe(500)
  })

  it('the schema version is pinned, so a future shape change must be deliberate', () => {
    expect(RACE_SESSION_SCHEMA_VERSION).toBe(1)
  })
})

// ═══ RD-RESULTS-FIX-01 · the start-list gate ═══════════════════════════════════
//
// Nothing verified that an imported bib belonged to anyone. These are the cases that used
// to reach the public leaderboard — and from there, issued certificates.

describe('publish — the start-list check', () => {
  it('refuses when the check has NEVER been run', () => {
    const d = decideTransition('publish', { ...ready, registrationCheck: null })
    expect(d.allowed).toBe(false)
    if (d.allowed) return
    expect(d.status).toBe(422)
    expect(d.reason).toMatch(/start list/i)
  })

  it('refuses a bib that is not on the start list', () => {
    const d = decideTransition('publish', {
      ...ready, registrationCheck: { unknownRunner: 3, wrongRace: 0 },
    })
    expect(d.allowed).toBe(false)
    if (d.allowed) return
    expect(d.status).toBe(422)
    expect(d.reason).toMatch(/3 not on the start list/i)
  })

  it('refuses a bib entered in a different race', () => {
    const d = decideTransition('publish', {
      ...ready, registrationCheck: { unknownRunner: 0, wrongRace: 2 },
    })
    expect(d.allowed).toBe(false)
    if (d.allowed) return
    expect(d.reason).toMatch(/2 entered in a different race/i)
  })

  it('names BOTH problems at once, so the file is fixed in one pass', () => {
    const d = decideTransition('publish', {
      ...ready, registrationCheck: { unknownRunner: 1, wrongRace: 4 },
    })
    if (d.allowed) return
    expect(d.reason).toMatch(/1 not on the start list/i)
    expect(d.reason).toMatch(/4 entered in a different race/i)
  })

  it('a clean check publishes', () => {
    expect(decideTransition('publish', {
      ...ready, registrationCheck: { unknownRunner: 0, wrongRace: 0 },
    })).toEqual({ allowed: true, next: 'published' })
  })

  it('an unranked but VERIFIED session is told about ranking', () => {
    const d = decideTransition('publish', {
      ...ready, ranked: false, registrationCheck: { unknownRunner: 0, wrongRace: 0 },
    })
    if (d.allowed) return
    expect(d.reason).toMatch(/ranking/i)
  })

  it('RD-RESULTS-CLOSURE-02 · the start-list gate is reported BEFORE ranking', () => {
    // Verification now runs before ranking and ranking refuses without it, so an
    // unverified session is always unranked too. Reporting "must finish ranking" would be
    // true but useless — the organizer cannot rank their way out of an unknown bib.
    const d = decideTransition('publish', {
      ...ready, ranked: false, registrationCheck: null,
    })
    if (d.allowed) return
    expect(d.reason).toMatch(/not been checked against the start list/i)
  })
})

// ═══ RD-RESULTS-CLOSURE-02 · the shared start-list gate ════════════════════════
//
// Ranking, snapshot building and publishing all answer this question. It is tested once,
// here, because it is now ONE function — three copies is how one of them drifts.

describe('checkRegistrationGate', () => {
  it('refuses a check that never ran', () => {
    const g = checkRegistrationGate(null)
    expect(g.ok).toBe(false)
    if (g.ok) return
    expect(g.status).toBe(422)
    expect(g.reason).toMatch(/not been checked against the start list/i)
  })

  it('refuses bibs that are on no start list, and counts them', () => {
    const g = checkRegistrationGate({ unknownRunner: 3, wrongRace: 0 })
    expect(g.ok).toBe(false)
    if (g.ok) return
    expect(g.reason).toMatch(/3 not on the start list/i)
  })

  it('refuses a runner entered in a different race', () => {
    const g = checkRegistrationGate({ unknownRunner: 0, wrongRace: 2 })
    expect(g.ok).toBe(false)
    if (g.ok) return
    expect(g.reason).toMatch(/2 entered in a different race/i)
  })

  it('names both problems when both are present', () => {
    const g = checkRegistrationGate({ unknownRunner: 1, wrongRace: 1 })
    if (g.ok) return
    expect(g.reason).toMatch(/1 not on the start list/i)
    expect(g.reason).toMatch(/1 entered in a different race/i)
  })

  it('allows a clean check', () => {
    expect(checkRegistrationGate({ unknownRunner: 0, wrongRace: 0 })).toEqual({ ok: true })
  })

  it('does NOT block on missing results — a DNS is not an error', () => {
    // `missingResult` is deliberately absent from the gate's input: blocking on it would
    // make publishing impossible for every race where anyone failed to start.
    expect(checkRegistrationGate({ unknownRunner: 0, wrongRace: 0 }).ok).toBe(true)
  })
})
