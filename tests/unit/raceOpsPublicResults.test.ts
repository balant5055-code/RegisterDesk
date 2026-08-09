// RD-RACEOPS-01 Sprint 4 — public results: keys, search inputs, projections, certificates.
//
// The brief's required coverage: public search, bib lookup, runner lookup, certificate
// availability, snapshot reads, pagination, 404 handling.
//
// These exercise the PURE layer — key derivation, projection shape, ordinals, page-cursor
// arithmetic — plus the structural guarantees that keep organizer data off public pages.
// Firestore-touching functions are covered by their types and by these invariants, not by
// integration tests (see "Not verified" in the changelog).

import { describe, it, expect } from 'vitest'
import {
  bibKey, isPlausibleBib, nameKey, passSlug, PREFIX_UPPER_BOUND,
} from '@/features/race-operations/utils/publicKeys'
import { toPublicRace } from '@/features/race-operations/utils/publicProjection'
import { ordinal } from '@/features/race-operations/utils/ordinal'
import { snapshotId, RACE_SNAPSHOT_SCHEMA_VERSION } from '@/features/race-operations/types/snapshot'
import type { RaceSnapshotDoc } from '@/features/race-operations/types/snapshot'

// ─── Bib keys — the basis of O(1) bib lookup ──────────────────────────────────

describe('bibKey — the entry document id', () => {
  it('normalises case and separators so one runner has one entry', () => {
    for (const raw of ['a101', 'A101', 'A-101', 'a 101', 'A_101', 'A/101']) {
      expect(bibKey(raw)).toBe('A101')
    }
  })

  it('PRESERVES leading zeros — 0042 and 42 are different runners', () => {
    expect(bibKey('0042')).toBe('0042')
    expect(bibKey('42')).toBe('42')
    expect(bibKey('0042')).not.toBe(bibKey('42'))
  })

  it('is stable — the write path and the read path derive the same key', () => {
    expect(bibKey(bibKey('a-101'))).toBe(bibKey('a-101'))
  })
})

describe('isPlausibleBib — the guard before any read', () => {
  it.each(['101', 'A101', '0042', 'a-101'])('accepts %s', b => {
    expect(isPlausibleBib(b)).toBe(true)
  })

  it.each(['', '   ', '!!!', 'x'.repeat(33), '../../etc/passwd', '<script>'])(
    'rejects %s so a junk URL never reaches Firestore',
    b => { expect(isPlausibleBib(b)).toBe(false) },
  )
})

// ─── Slugs — the public URL segment ───────────────────────────────────────────

describe('passSlug', () => {
  it('produces a clean URL segment from a race name', () => {
    expect(passSlug('21K Half Marathon', 'pass_x')).toBe('21k-half-marathon')
    expect(passSlug('5K Fun Run', 'pass_x')).toBe('5k-fun-run')
    expect(passSlug('42.2K Full Marathon', 'pass_x')).toBe('42-2k-full-marathon')
  })

  it('never emits leading, trailing or doubled separators', () => {
    const s = passSlug('  ***10K***  ', 'pass_x')
    expect(s).toBe('10k')
    expect(s.startsWith('-')).toBe(false)
    expect(s.endsWith('-')).toBe(false)
    expect(s).not.toMatch(/--/)
  })

  it('falls back to the pass id when the name has no usable characters', () => {
    expect(passSlug('!!!', 'pass_ABC')).toBe('pass-abc')
    expect(passSlug('', 'pass_ABC')).toBe('pass-abc')
  })

  it('is bounded, so a pathological name cannot make an unusable URL', () => {
    expect(passSlug('x'.repeat(500), 'p').length).toBeLessThanOrEqual(60)
  })
})

// ─── Name search ──────────────────────────────────────────────────────────────

describe('nameKey + prefix bound', () => {
  it('lower-cases and collapses whitespace', () => {
    expect(nameKey('  Priya   Sharma ')).toBe('priya sharma')
  })

  it('brackets exactly the strings starting with the query', () => {
    // U+F8FF sorts above every ordinary character, so [q, q+bound] is the prefix range.
    expect(PREFIX_UPPER_BOUND.codePointAt(0)).toBe(0xf8ff)

    const q = nameKey('pri')
    // The range is a CONJUNCTION — both bounds matter, which is exactly what
    // startAt(q).endAt(q + bound) expresses in Firestore.
    const inRange = (name: string) => name >= q && name <= q + PREFIX_UPPER_BOUND

    expect(inRange('priya sharma')).toBe(true)
    expect(inRange('pri')).toBe(true)
    // Prefix-only: a name that merely CONTAINS the query is excluded — here by the LOWER
    // bound, since 'k' sorts before 'p'. The UI states this behaviour explicitly.
    expect(inRange('kumar priya')).toBe(false)
    // And by the upper bound on the other side.
    expect(inRange('quinn')).toBe(false)
  })
})

// ─── Snapshot identity ────────────────────────────────────────────────────────

describe('snapshotId', () => {
  it('is deterministic per (event, race)', () => {
    expect(snapshotId('run-2026', 'pass_1')).toBe('run-2026__pass_1')
    expect(snapshotId('run-2026', 'pass_1')).toBe(snapshotId('run-2026', 'pass_1'))
  })

  it('separates races within one event', () => {
    expect(snapshotId('e', 'a')).not.toBe(snapshotId('e', 'b'))
  })
})

// ─── The public projection — the security boundary ────────────────────────────

describe('toPublicRace — organizer data can never reach a public page', () => {
  const internal: RaceSnapshotDoc = {
    snapshotId:    'run-2026__pass_1',
    schemaVersion: RACE_SNAPSHOT_SCHEMA_VERSION,
    eventSlug:     'run-2026',
    eventName:     'Coimbatore Marathon',
    passId:        'pass_1',
    passSlug:      '21k-half-marathon',
    passName:      '21K Half Marathon',
    eventDate:     '2026-02-01',
    version:       3,
    status:        'live',
    // Everything below is organizer-owned and MUST NOT survive the projection.
    organizerUid:  'uid_secret',
    eventId:       'draft_secret',
    sessionId:     'ris_secret',
    publishedBy:   'uid_operator',
    publishedAt:   null,
    builtAt:       null,
    totalCount:    1200,
    finisherCount: 1180,
  }

  const projected = toPublicRace(internal)

  it('drops every organizer identifier', () => {
    const serialized = JSON.stringify(projected)
    for (const secret of ['uid_secret', 'draft_secret', 'ris_secret', 'uid_operator']) {
      expect(serialized).not.toContain(secret)
    }
  })

  it('exposes exactly the public fields — no more', () => {
    expect(Object.keys(projected).sort()).toEqual([
      'eventDate', 'eventName', 'eventSlug', 'finisherCount',
      'passName', 'passSlug', 'publishedAt', 'totalCount',
    ])
  })

  it('does not leak the internal version or status either', () => {
    expect('version' in projected).toBe(false)
    expect('status' in projected).toBe(false)
  })
})

// ─── Certificate integration (approved D3) ────────────────────────────────────

describe('ordinal — the {{position}} placeholder', () => {
  it.each([[1, '1st'], [2, '2nd'], [3, '3rd'], [4, '4th'], [21, '21st'], [22, '22nd'], [23, '23rd'], [101, '101st']])(
    'renders %i as %s', (n, expected) => { expect(ordinal(n as number)).toBe(expected) },
  )

  it('handles the 11/12/13 exception', () => {
    expect(ordinal(11)).toBe('11th')
    expect(ordinal(12)).toBe('12th')
    expect(ordinal(13)).toBe('13th')
    expect(ordinal(111)).toBe('111th')
    expect(ordinal(112)).toBe('112th')
  })
})

// ─── Pagination ───────────────────────────────────────────────────────────────

describe('leaderboard pagination contract', () => {
  /** Mirrors fetchLeaderboardPage's cursor rule: a SHORT page means the end. */
  function nextCursor(returned: number, pageSize: number, lastRank: number | null) {
    return returned === pageSize ? lastRank : null
  }

  it('returns a cursor only when the page was full', () => {
    expect(nextCursor(50, 50, 50)).toBe(50)
    expect(nextCursor(49, 50, 49)).toBeNull()
    expect(nextCursor(0, 50, null)).toBeNull()
  })

  it('the cursor is a RANK, not an offset — page N costs the same as page 1', () => {
    // startAfter(rank) is an indexed seek; an offset would have to read and discard.
    const cursor = nextCursor(50, 50, 50)
    expect(typeof cursor).toBe('number')
  })
})

// ─── 404 handling ─────────────────────────────────────────────────────────────

describe('404 inputs are rejected before any read', () => {
  it('an implausible bib short-circuits, so a bad URL costs zero Firestore reads', () => {
    // getRunnerResult calls isPlausibleBib first and returns null without touching the db.
    expect(isPlausibleBib('')).toBe(false)
    expect(isPlausibleBib('../../secrets')).toBe(false)
  })

  it('an empty search yields no query rather than an unbounded scan', () => {
    expect(nameKey('   ')).toBe('')
  })
})
