// RD-EVENT-02 — the step registry must describe TODAY'S wizard exactly.
//
// These tests are the behaviour-preservation contract. Every expectation below was read off
// the positional `if (step === N)` chains in the Event Builder before any refactor, so if a
// future edit changes what a step writes, this fails rather than an organizer's draft
// silently losing a field.

import { describe, it, expect } from 'vitest'
import {
  STEP_REGISTRY, draftKeyFor, indexOfStep, resumeStepFor, stepAt, stepsFor, wizardStepsFor,
} from '@/lib/events/builder/stepRegistry'
import { WIZARD_STEPS } from '@/lib/events/builder/constants'

describe('flow shapes match the shipped step lists', () => {
  // RD-EVENT-COMMERCE-02 — 'License' became 'License & Services' (title only). No step was
  // added: capacity, services, the cost summary and the payment all live on that one step.
  // RD-EVENT-COMMERCE-05B — Review now PRECEDES License & Services, which is the final step.
  it('standard has the 8 steps of WIZARD_STEPS, in order (Review, then License & Services last)', () => {
    expect(wizardStepsFor('standard').map(s => s.name)).toEqual([
      'Event Type', 'Visibility', 'Access Control', 'Passes & Pricing',
      'Form', 'Details', 'Review', 'License & Services',
    ])
    expect(wizardStepsFor('standard')).toEqual(WIZARD_STEPS)
  })

  it('fundraising inserts Fundraising after Details, then Review, then License & Services last', () => {
    expect(wizardStepsFor('fundraising').map(s => s.name)).toEqual([
      'Event Type', 'Visibility', 'Access Control', 'Passes & Pricing',
      'Form', 'Details', 'Fundraising', 'Review', 'License & Services',
    ])
  })

  it('there is NO separate Payment step in any flow', () => {
    for (const flow of ['standard', 'fundraising', 'campaign'] as const) {
      expect(indexOfStep(flow, 'payment')).toBe(-1)
      expect(stepsFor(flow).map(s => s.title)).not.toContain('Payment')
    }
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
      'registrationForm', 'eventDetails', 'pricing', 'licenseTier',
    ]
    expected.forEach((key, i) => expect(draftKeyFor('standard', i, 'saveDraft')).toBe(key))
  })

  it('fundraising · saveDraft writes linkedCampaign at 6, pricing (Review) at 7, licenseTier (License) at 8', () => {
    expect(draftKeyFor('fundraising', 6, 'saveDraft')).toBe('linkedCampaign')
    expect(draftKeyFor('fundraising', 7, 'saveDraft')).toBe('pricing')
    expect(draftKeyFor('fundraising', 8, 'saveDraft')).toBe('licenseTier')
  })

  // RD-CE-FIX (Access Control Back) — Access Control autosaves too: it only saved on Continue / Save
  // Draft, so Back or "Back to Dashboard" lost its edits.
  it('autosave is wired for ONLY Access Control, Passes & Pricing, Form and Details', () => {
    const wired = stepsFor('standard')
      .map((s, i) => (draftKeyFor('standard', i, 'autosave') ? s.id : null))
      .filter(Boolean)
    expect(wired).toEqual(['access', 'pricing', 'form', 'details'])
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

describe('resumeStepFor — where a draft reopens', () => {
  it('returns every in-range index unchanged (existing drafts reopen where they were)', () => {
    for (const flow of ['standard', 'fundraising'] as const) {
      stepsFor(flow).forEach((_, i) => expect(resumeStepFor(flow, i)).toBe(i))
    }
  })

  it('clamps corrupt or out-of-range values instead of rendering no step', () => {
    expect(resumeStepFor('standard', 8)).toBe(7)
    expect(resumeStepFor('standard', 42)).toBe(7)
    expect(resumeStepFor('fundraising', 9)).toBe(8)
    expect(resumeStepFor('standard', -3)).toBe(0)
    expect(resumeStepFor('standard', 2.5)).toBe(0)
    expect(resumeStepFor('standard', undefined)).toBe(0)
    expect(resumeStepFor('standard', '7')).toBe(0)
  })
})

describe('lookups', () => {
  it('finds steps by meaning rather than by number', () => {
    expect(indexOfStep('standard', 'review')).toBe(6)
    expect(indexOfStep('fundraising', 'review')).toBe(7)
    expect(indexOfStep('standard', 'license')).toBe(7)       // the FINAL step
    expect(indexOfStep('fundraising', 'license')).toBe(8)
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
