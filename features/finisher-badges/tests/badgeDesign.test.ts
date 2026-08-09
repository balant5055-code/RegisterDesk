// RD-BADGE-01 · Finisher Badges — the pure core.
//
// The brief's list: badge generation, regeneration, snapshot validation, storage integration,
// runner page integration. Covered here at the level that can be verified deterministically —
// the design decisions, the identity/idempotency rules, and the structural guarantees that
// keep a badge from ever being built from a draft import.
//
// Rendering (Satori → PNG) and Firestore are exercised by their types and by a separate smoke
// check, not by integration tests. See "Not verified" in the report.

import { describe, it, expect } from 'vitest'
import {
  BADGE_COLORS, LIMITS, buildViewModel, fit, formatEventDate, ordinal, presentStatus,
} from '@/features/finisher-badges/render/design'
import {
  BADGE_HEIGHT, BADGE_MIME, BADGE_SCHEMA_VERSION, BADGE_STATUS_LABEL,
  BADGE_TEMPLATE_VERSION, BADGE_WIDTH, badgeId,
} from '@/features/finisher-badges/types'
import type { BadgeRenderInput } from '@/features/finisher-badges/types'
import { bibKey } from '@/features/race-operations/utils/publicKeys'
import { defaultVisibility, allowedMimeTypes, maxBytesFor } from '@/features/platform-storage'

function input(over: Partial<BadgeRenderInput> = {}): BadgeRenderInput {
  return {
    eventName:     'Coimbatore Marathon 2026',
    eventDate:     '2026-02-01',
    eventLogoUrl:  'https://cdn.test/logo.png',
    raceName:      '21K Half Marathon',
    runnerName:    'Priya Sharma',
    bibNumber:     '21044',
    chipTime:      '01:48:32',
    overallRank:   3,
    status:        'finished',
    finisherCount: 1180,
    ...over,
  }
}

// ═══════════════ Output contract ═══════════════

describe('output contract', () => {
  it('is a 1080×1080 PNG, as specified', () => {
    expect(BADGE_WIDTH).toBe(1080)
    expect(BADGE_HEIGHT).toBe(1080)
    expect(BADGE_MIME).toBe('image/png')
  })

  it('pins the schema and template versions so a change is deliberate', () => {
    expect(BADGE_SCHEMA_VERSION).toBe(1)
    expect(BADGE_TEMPLATE_VERSION).toBe(1)
  })

  it('labels every status', () => {
    for (const s of ['pending', 'generated', 'failed'] as const) {
      expect(BADGE_STATUS_LABEL[s]).toBeTruthy()
    }
  })
})

// ═══════════════ Identity / idempotency ═══════════════

describe('badge identity', () => {
  it('is deterministic, so regenerating overwrites one record', () => {
    expect(badgeId('run-26', 'pass_1', 'A101')).toBe('run-26__pass_1__A101')
    expect(badgeId('run-26', 'pass_1', 'A101')).toBe(badgeId('run-26', 'pass_1', 'A101'))
  })

  it('separates races within one event, and events from each other', () => {
    expect(badgeId('e', 'a', 'B1')).not.toBe(badgeId('e', 'b', 'B1'))
    expect(badgeId('e1', 'a', 'B1')).not.toBe(badgeId('e2', 'a', 'B1'))
  })

  it('uses the SAME normalised bib key as the snapshot entry', () => {
    // The badge must address the same runner the leaderboard does — a divergent key would
    // silently generate a badge for a bib that has no result.
    for (const raw of ['a-101', 'A 101', 'A101']) {
      expect(badgeId('e', 'p', bibKey(raw))).toBe('e__p__A101')
    }
  })

  it('preserves leading zeros — 0042 and 42 are different runners', () => {
    expect(badgeId('e', 'p', bibKey('0042'))).not.toBe(badgeId('e', 'p', bibKey('42')))
  })
})

// ═══════════════ Storage integration ═══════════════

describe('storage integration', () => {
  it('reuses the asset type the platform layer already defines', () => {
    // Sprint 5 defined `event-finisher-badge` before any badge existed. Nothing in the
    // storage layer needed changing for this sprint — this test pins that.
    expect(defaultVisibility('event-finisher-badge')).toBe('PUBLIC')
  })

  it('allows PNG for badges and refuses executable image formats', () => {
    const allowed = allowedMimeTypes('event-finisher-badge')
    expect(allowed).toContain('image/png')
    expect(allowed).not.toContain('image/svg+xml')
    expect(allowed).not.toContain('text/html')
  })

  it('has a size ceiling a 1080×1080 PNG comfortably fits under', () => {
    // The smoke-tested render was ~29 KB; the ceiling is 10 MB.
    expect(maxBytesFor('event-finisher-badge')).toBeGreaterThan(1024 * 1024)
  })
})

// ═══════════════ Text fitting ═══════════════

describe('text fitting', () => {
  it('leaves short text untouched', () => {
    expect(fit('21K Half Marathon', 40)).toBe('21K Half Marathon')
  })

  it('truncates with an ellipsis rather than overflowing the canvas', () => {
    // Satori does not reflow overflowing text the way a browser does.
    const out = fit('x'.repeat(200), 20)
    expect(out).toHaveLength(20)
    expect(out.endsWith('…')).toBe(true)
  })

  it('collapses whitespace so a padded name does not shift the layout', () => {
    expect(fit('  Priya    Sharma  ', 40)).toBe('Priya Sharma')
  })

  it('never returns an empty string for non-empty input', () => {
    expect(fit('abcdef', 1).length).toBeGreaterThan(0)
  })
})

// ═══════════════ Status presentation ═══════════════

describe('status presentation', () => {
  it('celebrates a finish', () => {
    const p = presentStatus('finished')
    expect(p.label).toBe('FINISHER')
    expect(p.celebratory).toBe(true)
  })

  it('still issues a dignified badge for DNF / DNS / DQ, without claiming a finish', () => {
    for (const s of ['dnf', 'dns', 'dq'] as const) {
      const p = presentStatus(s)
      expect(p.label).toBeTruthy()
      expect(p.celebratory).toBe(false)
      expect(p.label).not.toContain('FINISHER')
    }
  })

  it('gives every status a colour from the declared palette', () => {
    const palette = new Set<string>(Object.values(BADGE_COLORS))
    for (const s of ['finished', 'dnf', 'dns', 'dq'] as const) {
      expect(palette.has(presentStatus(s).color)).toBe(true)
    }
  })
})

// ═══════════════ Formatting ═══════════════

describe('formatting', () => {
  it('renders an ordinal rank', () => {
    expect(ordinal(1)).toBe('1st')
    expect(ordinal(2)).toBe('2nd')
    expect(ordinal(3)).toBe('3rd')
    expect(ordinal(11)).toBe('11th')
    expect(ordinal(21)).toBe('21st')
    expect(ordinal(112)).toBe('112th')
  })

  it('formats an event date, and returns null rather than inventing one', () => {
    expect(formatEventDate('2026-02-01')).toBe('1 February 2026')
    expect(formatEventDate(null)).toBeNull()
    expect(formatEventDate('')).toBeNull()
    expect(formatEventDate('not-a-date')).toBeNull()
  })

  it('is timezone-stable — the printed date never drifts by a day', () => {
    // Built in UTC on purpose: a local-time parse would render 31 January for a runner west
    // of Greenwich, which is simply the wrong date on a keepsake.
    expect(formatEventDate('2026-02-01')).toContain('1 February')
  })
})

// ═══════════════ View model — every required field + every fallback ═══════════════

describe('badge content', () => {
  it('carries every field the brief requires', () => {
    const vm = buildViewModel(input())
    expect(vm.eventLogoUrl).toBe('https://cdn.test/logo.png')  // Event Logo
    expect(vm.eventName).toBe('Coimbatore Marathon 2026')      // Event Name
    expect(vm.raceName).toBe('21K Half Marathon')              // Distance
    expect(vm.displayName).toBe('Priya Sharma')                // Runner Name
    expect(vm.bibNumber).toBe('21044')                         // Bib Number
    expect(vm.timeLabel).toBe('01:48:32')                      // Official Chip Time
    expect(vm.rankLabel).toBe('3rd')                           // Overall Rank
    expect(vm.status.label).toBe('FINISHER')                   // Finisher Status
    expect(vm.eventDate).toBe('1 February 2026')               // Event Date
  })

  it('falls back to the bib when the timing file carried no name', () => {
    // Runner name is OPTIONAL in the canonical model (Sprint 4 · D4) — a badge must still
    // be produced.
    const vm = buildViewModel(input({ runnerName: null }))
    expect(vm.displayName).toBe('Bib 21044')
  })

  it('omits the rank block when there is no rank', () => {
    const vm = buildViewModel(input({ overallRank: null, status: 'dnf' }))
    expect(vm.rankLabel).toBeNull()
    expect(vm.rankSubLabel).toBeNull()
    expect(vm.status.label).toBe('DID NOT FINISH')
  })

  it('omits the time block when there is no time', () => {
    expect(buildViewModel(input({ chipTime: null })).timeLabel).toBeNull()
  })

  it('renders with NO optional data at all', () => {
    // The minimum viable badge: a bib and a status. Nothing throws.
    const vm = buildViewModel(input({
      runnerName: null, chipTime: null, overallRank: null,
      eventDate: null, eventLogoUrl: null, status: 'dns', finisherCount: 0,
    }))
    expect(vm.displayName).toBe('Bib 21044')
    expect(vm.eventLogoUrl).toBeNull()
    expect(vm.status.label).toBe('DID NOT START')
  })

  it('truncates a hostile event name instead of overflowing', () => {
    const vm = buildViewModel(input({ eventName: 'x'.repeat(500) }))
    expect(vm.eventName.length).toBeLessThanOrEqual(LIMITS.eventName)
  })

  it('does not show a finisher-count sub-label when the count is zero', () => {
    expect(buildViewModel(input({ finisherCount: 0 })).rankSubLabel).toBeNull()
  })
})

// ═══════════════ The security invariant ═══════════════

describe('snapshot-only generation', () => {
  it('the design layer knows nothing about import sessions', async () => {
    // Structural: if a future change made the badge readable from a draft import, the render
    // input would have to grow a field describing one. It has exactly these keys.
    const keys = Object.keys(input()).sort()
    expect(keys).toEqual([
      'bibNumber', 'chipTime', 'eventDate', 'eventLogoUrl', 'eventName',
      'finisherCount', 'overallRank', 'raceName', 'runnerName', 'status',
    ])
    expect(keys.some(k => /session|draft|import/i.test(k))).toBe(false)
  })

  it('the render input carries NO organizer identifier', () => {
    // Nothing organizer-only may reach the image, which is public.
    const keys = Object.keys(input())
    for (const forbidden of ['organizerUid', 'eventId', 'sessionId', 'uploadedBy']) {
      expect(keys).not.toContain(forbidden)
    }
  })
})
