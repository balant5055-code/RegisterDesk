// RD-RACEOPS-01 Sprint 1 — Race Operations event eligibility.
//
// Which events may receive published results, and — when they may not — that the
// organizer is given a real reason rather than a silently missing row. Every member
// of the EXISTING EventLifecycleStatus union is covered, so adding a lifecycle state
// without deciding its Race Operations behaviour fails here.

import { describe, it, expect } from 'vitest'
import { resolveRaceOpsEligibility } from '@/features/race-operations/utils/eligibility'
import { RACE_OPS_ELIGIBLE_LIFECYCLE } from '@/features/race-operations/types'
import type { EventLifecycleStatus } from '@/types/events'

// Mirrors the EventLifecycleStatus union in types/events.ts.
const ALL_LIFECYCLE: EventLifecycleStatus[] = [
  'draft', 'pending_review', 'changes_requested', 'published',
  'registration_closed', 'completed', 'cancelled', 'archived', 'unpublished',
]

const RACES = 3

describe('resolveRaceOpsEligibility — lifecycle', () => {
  it.each(['published', 'registration_closed', 'completed'])(
    '%s with races → eligible, no reason',
    status => {
      expect(resolveRaceOpsEligibility(status, RACES)).toEqual({ eligible: true })
    },
  )

  it.each(['draft', 'pending_review', 'changes_requested'])(
    '%s → ineligible, told to publish first',
    status => {
      const r = resolveRaceOpsEligibility(status, RACES)
      expect(r.eligible).toBe(false)
      expect(r.reason).toBe('Publish this event before recording results.')
    },
  )

  it('cancelled → ineligible with its own reason', () => {
    expect(resolveRaceOpsEligibility('cancelled', RACES))
      .toEqual({ eligible: false, reason: 'This event was cancelled.' })
  })

  it('archived → ineligible with its own reason', () => {
    expect(resolveRaceOpsEligibility('archived', RACES))
      .toEqual({ eligible: false, reason: 'This event is archived.' })
  })

  it('unpublished → ineligible with its own reason (never falls back to draft copy)', () => {
    expect(resolveRaceOpsEligibility('unpublished', RACES))
      .toEqual({ eligible: false, reason: 'This event is currently offline.' })
  })

  it('an unrecognised status is ineligible and still carries a reason', () => {
    const r = resolveRaceOpsEligibility('some_future_state', RACES)
    expect(r.eligible).toBe(false)
    expect(r.reason).toBe('Results are not available for this event.')
  })

  it('every lifecycle state resolves to an explicit outcome with a reason when denied', () => {
    for (const status of ALL_LIFECYCLE) {
      const r = resolveRaceOpsEligibility(status, RACES)
      expect(r.eligible).toBe(RACE_OPS_ELIGIBLE_LIFECYCLE.includes(status))
      if (!r.eligible) expect(r.reason).toBeTruthy()
    }
  })
})

describe('resolveRaceOpsEligibility — races (distance = pass, Phase 0 · D2)', () => {
  it('an otherwise-eligible event with zero races is ineligible', () => {
    expect(resolveRaceOpsEligibility('published', 0))
      .toEqual({ eligible: false, reason: 'This event has no races or passes configured.' })
  })

  it('one race is enough', () => {
    expect(resolveRaceOpsEligibility('published', 1)).toEqual({ eligible: true })
  })

  it('lifecycle is checked before race count — a draft never reports the race reason', () => {
    const r = resolveRaceOpsEligibility('draft', 0)
    expect(r.reason).toBe('Publish this event before recording results.')
  })
})
