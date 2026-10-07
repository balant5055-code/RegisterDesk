// RD-RACEOPS-01 Sprint 1 — Race Operations event eligibility.
//
// Which events may receive published results, and — when they may not — that the
// organizer is given a real reason rather than a silently missing row. Every member
// of the EXISTING EventLifecycleStatus union is covered, so adding a lifecycle state
// without deciding its Race Operations behaviour fails here.

import { describe, it, expect } from 'vitest'
import { resolveRaceOpsEligibility, RACE_OPS_TYPE_REASON } from '@/features/race-operations/utils/eligibility'
import { RACE_OPS_ELIGIBLE_LIFECYCLE } from '@/features/race-operations/types'
import type { EventLifecycleStatus } from '@/types/events'

// Mirrors the EventLifecycleStatus union in types/events.ts.
const ALL_LIFECYCLE: EventLifecycleStatus[] = [
  'draft', 'pending_review', 'changes_requested', 'published',
  'registration_closed', 'completed', 'cancelled', 'archived', 'unpublished',
]

const RACES = 3
// RD-RACEOPS-02B · the lifecycle and race-count rules are exercised on a sports event; the
// event-type rule has its own group at the foot of this file.
const SPORTS = 'sports'

describe('resolveRaceOpsEligibility — lifecycle', () => {
  it.each(['published', 'registration_closed', 'completed'])(
    '%s with races → eligible, no reason',
    status => {
      expect(resolveRaceOpsEligibility(status, RACES, SPORTS)).toEqual({ eligible: true })
    },
  )

  it.each(['draft', 'pending_review', 'changes_requested'])(
    '%s → ineligible, told to publish first',
    status => {
      const r = resolveRaceOpsEligibility(status, RACES, SPORTS)
      expect(r.eligible).toBe(false)
      expect(r.reason).toBe('Publish this event before recording results.')
    },
  )

  it('cancelled → ineligible with its own reason', () => {
    expect(resolveRaceOpsEligibility('cancelled', RACES, SPORTS))
      .toEqual({ eligible: false, reason: 'This event was cancelled.' })
  })

  it('archived → ineligible with its own reason', () => {
    expect(resolveRaceOpsEligibility('archived', RACES, SPORTS))
      .toEqual({ eligible: false, reason: 'This event is archived.' })
  })

  it('unpublished → ineligible with its own reason (never falls back to draft copy)', () => {
    expect(resolveRaceOpsEligibility('unpublished', RACES, SPORTS))
      .toEqual({ eligible: false, reason: 'This event is currently offline.' })
  })

  it('an unrecognised status is ineligible and still carries a reason', () => {
    const r = resolveRaceOpsEligibility('some_future_state', RACES, SPORTS)
    expect(r.eligible).toBe(false)
    expect(r.reason).toBe('Results are not available for this event.')
  })

  it('every lifecycle state resolves to an explicit outcome with a reason when denied', () => {
    for (const status of ALL_LIFECYCLE) {
      const r = resolveRaceOpsEligibility(status, RACES, SPORTS)
      expect(r.eligible).toBe(RACE_OPS_ELIGIBLE_LIFECYCLE.includes(status))
      if (!r.eligible) expect(r.reason).toBeTruthy()
    }
  })
})

describe('resolveRaceOpsEligibility — races (distance = pass, Phase 0 · D2)', () => {
  it('an otherwise-eligible event with zero races is ineligible', () => {
    expect(resolveRaceOpsEligibility('published', 0, SPORTS))
      .toEqual({ eligible: false, reason: 'This event has no races or passes configured.' })
  })

  it('one race is enough', () => {
    expect(resolveRaceOpsEligibility('published', 1, SPORTS)).toEqual({ eligible: true })
  })

  it('lifecycle is checked before race count — a draft never reports the race reason', () => {
    const r = resolveRaceOpsEligibility('draft', 0, SPORTS)
    expect(r.reason).toBe('Publish this event before recording results.')
  })
})

// ─── RD-RACEOPS-02B · event type ─────────────────────────────────────────────

describe('resolveRaceOpsEligibility — event type (RD-RACEOPS-02B)', () => {
  it('every sports event is admitted whatever its subtype — the pipeline is one elapsed time per bib per pass', () => {
    // subtype is not an input: running, cycling, swimming and triathlon all arrive as 'sports'
    expect(resolveRaceOpsEligibility('published', RACES, 'sports')).toEqual({ eligible: true })
  })

  it.each(['conference', 'workshop', 'meetup', 'fundraising', 'exhibition', 'community', 'cultural', 'awards', 'custom'])(
    '%s → ineligible with the event-type reason, whatever the lifecycle', type => {
      for (const status of ALL_LIFECYCLE) {
        expect(resolveRaceOpsEligibility(status, RACES, type)).toEqual({ eligible: false, reason: RACE_OPS_TYPE_REASON })
      }
    })

  it('an unknown type (null) is ineligible — a sports-only capability is offered because the event SAYS it is sports', () => {
    expect(resolveRaceOpsEligibility('published', RACES, null)).toEqual({ eligible: false, reason: RACE_OPS_TYPE_REASON })
  })

  it('type is checked before lifecycle and race count — a conference draft with no passes reports the type reason', () => {
    expect(resolveRaceOpsEligibility('draft', 0, 'conference').reason).toBe(RACE_OPS_TYPE_REASON)
  })
})
