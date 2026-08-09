// RD-EVENT-02 — the step registry must describe TODAY'S wizard exactly.
//
// These tests are the behaviour-preservation contract. Every expectation below was read off
// the positional `if (step === N)` chains in the Event Builder before any refactor, so if a
// future edit changes what a step writes, this fails rather than an organizer's draft
// silently losing a field.

import { describe, it, expect } from 'vitest'
import {
  STEP_REGISTRY, draftKeyFor, indexOfStep, stepAt, stepsFor, wizardStepsFor,
} from '@/lib/events/builder/stepRegistry'

describe('flow shapes match the shipped step lists', () => {
  it('standard has the 8 steps of WIZARD_STEPS, in order', () => {
    expect(wizardStepsFor('standard').map(s => s.name)).toEqual([
      'Event Type', 'Visibility', 'Access Control', 'Passes & Pricing',
      'Form', 'Details', 'License', 'Review',
    ])
  })

  it('fundraising inserts Fundraising after Details and keeps License before Review', () => {
    expect(wizardStepsFor('fundraising').map(s => s.name)).toEqual([
      'Event Type', 'Visibility', 'Access Control', 'Passes & Pricing',
      'Form', 'Details', 'Fundraising', 'License', 'Review',
    ])
  })

  it('campaign is its own 4-step wizard', () => {
    expect(wizardStepsFor('campaign').map(s => s.name)).toEqual([
      'Visibility', 'Campaign Details', 'Donation Settings', 'Review',
    ])
  })

  it('order is derived from position in every flow', () => {
    for (const flow of ['standard', 'fundraising', 'campaign'] as const) {
      stepsFor(flow).forEach((s, i) => expect(s.order).toBe(i))
    }
  })
})

describe('draft keys match the positional chains they replace', () => {
  it('standard · saveDraft writes the same field at every index', () => {
    const expected = [
      'step0', 'visibility', 'accessControl', 'pricing',
      'registrationForm', 'eventDetails', 'licenseTier', 'pricing',
    ]
    expected.forEach((key, i) => expect(draftKeyFor('standard', i, 'saveDraft')).toBe(key))
  })

  it('fundraising · saveDraft writes linkedCampaign at 6, licenseTier at 7, pricing at 8', () => {
    expect(draftKeyFor('fundraising', 6, 'saveDraft')).toBe('linkedCampaign')
    expect(draftKeyFor('fundraising', 7, 'saveDraft')).toBe('licenseTier')
    expect(draftKeyFor('fundraising', 8, 'saveDraft')).toBe('pricing')
  })

  it('autosave is wired for ONLY Passes & Pricing, Form and Details', () => {
    const wired = stepsFor('standard')
      .map((s, i) => (draftKeyFor('standard', i, 'autosave') ? s.id : null))
      .filter(Boolean)
    expect(wired).toEqual(['pricing', 'form', 'details'])
  })
})

describe('the asymmetry between call sites is preserved, not smoothed over', () => {
  it('goNext does NOT persist License or Review in either flow', () => {
    // The chain in `goNext` has no branch for these steps. Recording that here is what stops
    // a future "tidy-up" from quietly adding a write on step advance.
    for (const flow of ['standard', 'fundraising'] as const) {
      const license = indexOfStep(flow, 'license')
      const review  = indexOfStep(flow, 'review')
      expect(draftKeyFor(flow, license, 'next')).toBeNull()
      expect(draftKeyFor(flow, review, 'next')).toBeNull()
      // …while an explicit Save Draft on those same steps DOES persist.
      expect(draftKeyFor(flow, license, 'saveDraft')).toBe('licenseTier')
      expect(draftKeyFor(flow, review, 'saveDraft')).toBe('pricing')
    }
  })

  it('goNext persists Fundraising, because that branch does exist', () => {
    expect(draftKeyFor('fundraising', indexOfStep('fundraising', 'fundraising'), 'next'))
      .toBe('linkedCampaign')
  })

  it('every step with a key is reachable by at least one call site', () => {
    for (const flow of ['standard', 'fundraising', 'campaign'] as const) {
      stepsFor(flow).forEach((s, i) => {
        if (!s.draftKey) return
        const any = ['next', 'saveDraft', 'autosave'] as const
        expect(any.some(site => draftKeyFor(flow, i, site) !== null)).toBe(true)
      })
    }
  })
})

describe('lookups', () => {
  it('finds steps by meaning rather than by number', () => {
    expect(indexOfStep('standard', 'review')).toBe(7)
    expect(indexOfStep('fundraising', 'review')).toBe(8)
    // The same id resolves to a DIFFERENT index per flow — the exact hazard positional
    // logic could not express.
    expect(indexOfStep('standard', 'license')).not.toBe(indexOfStep('fundraising', 'license'))
  })

  it('returns null out of range instead of throwing', () => {
    expect(stepAt('standard', 99)).toBeNull()
    expect(stepAt('campaign', -1)).toBeNull()
    expect(draftKeyFor('standard', 99, 'saveDraft')).toBeNull()
  })

  it('unknown ids report -1', () => {
    expect(indexOfStep('standard', 'nope')).toBe(-1)
  })

  it('every id is unique within its flow', () => {
    for (const flow of Object.keys(STEP_REGISTRY) as (keyof typeof STEP_REGISTRY)[]) {
      const ids = STEP_REGISTRY[flow].map(s => s.id)
      expect(new Set(ids).size).toBe(ids.length)
    }
  })
})
