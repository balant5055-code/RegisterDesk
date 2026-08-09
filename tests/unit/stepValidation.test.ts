// RD-EVENT-04 — parity between the validation contract and the live gates it mirrors.
//
// The reference expressions below are copied VERBATIM from the `isNextDisabled` gates and
// `canProceed` definitions as they stand today:
//
//   Step1View:715, Step2View:287, Step3View:1577, Step4View:1047, Step5View:70
//
// Each validator is exercised across the full truth table of its inputs and must agree with
// its reference on EVERY combination. A rule change that is not also made in the component
// fails here — which is the point: this contract is allowed to centralise invocation, never
// to quietly relax or tighten what an organizer must fill in.

import { describe, it, expect } from 'vitest'
import {
  validateEventType, validateVisibility, validateAccess, validatePricing, validateForm,
  validateStep, hasValidator, STEP_VALIDATORS, DEFERRED_GATES, UNGATED_STEPS,
} from '@/lib/events/builder/stepValidation'
import { stepsFor } from '@/lib/events/builder/stepRegistry'

// ─── Reference: the live expressions ─────────────────────────────────────────

const liveEventType = (selectedType: string | null, hasValidSubtype: boolean, isFundraising: boolean, campaignType: string | null) =>
  selectedType !== null && hasValidSubtype && (!isFundraising || campaignType !== null)

const liveVisibility = (selectedVisibility: string | null) =>
  selectedVisibility !== null

const liveAccess = (selectedAccess: string | null, approvedContacts: unknown[]) =>
  selectedAccess !== null && (selectedAccess !== 'approved_contacts' || approvedContacts.length > 0)

// Step4 has no `canProceed`; its gate is inline `isNextDisabled={pricing.passes.length === 0}`.
const livePricing = (passes: unknown[]) => !(passes.length === 0)

const liveForm = (template: unknown[], fields: unknown[]) =>
  template.length > 0 || fields.length > 0

// ─── Truth tables ────────────────────────────────────────────────────────────

const TYPES = [null, 'marathon', 'donation'] as const
const BOOLS = [false, true] as const
const CAMPAIGNS = [null, 'event_only', 'event_plus_donation'] as const
const ACCESS = [null, 'open', 'approved_contacts', 'invite_only'] as const
const COUNTS = [0, 1, 5] as const

const list = (n: number) => Array.from({ length: n }, (_, i) => i)

describe('every validator agrees with its live gate on the full truth table', () => {
  it('eventType · Step1View:715', () => {
    for (const selectedType of TYPES)
      for (const hasValidSubtype of BOOLS)
        for (const isFundraising of BOOLS)
          for (const campaignType of CAMPAIGNS) {
            const label = `${selectedType}/${hasValidSubtype}/${isFundraising}/${campaignType}`
            expect(
              validateEventType({ selectedType, hasValidSubtype, isFundraising, campaignType }).valid,
              label,
            ).toBe(liveEventType(selectedType, hasValidSubtype, isFundraising, campaignType))
          }
  })

  it('visibility · Step2View:287 (and the campaign wizard at page:3505)', () => {
    for (const selectedVisibility of [null, 'public', 'private'] as const) {
      expect(validateVisibility({ selectedVisibility }).valid)
        .toBe(liveVisibility(selectedVisibility))
    }
  })

  it('access · Step3View:1577', () => {
    for (const selectedAccess of ACCESS)
      for (const n of COUNTS) {
        const label = `${selectedAccess}/${n}`
        expect(validateAccess({ selectedAccess, approvedContactsCount: n }).valid, label)
          .toBe(liveAccess(selectedAccess, list(n)))
      }
  })

  it('pricing · Step4View:1047', () => {
    for (const n of COUNTS) {
      expect(validatePricing({ passCount: n }).valid).toBe(livePricing(list(n)))
    }
  })

  it('form · Step5View:70', () => {
    for (const t of COUNTS)
      for (const f of COUNTS) {
        expect(validateForm({ templateCount: t, fieldCount: f }).valid, `${t}/${f}`)
          .toBe(liveForm(list(t), list(f)))
      }
  })
})

describe('the rules that are easy to get subtly wrong', () => {
  it('a non-fundraising flow does NOT require a campaign type', () => {
    expect(validateEventType({
      selectedType: 'marathon', hasValidSubtype: true, isFundraising: false, campaignType: null,
    }).valid).toBe(true)
  })

  it('a fundraising flow DOES require one', () => {
    const r = validateEventType({
      selectedType: 'marathon', hasValidSubtype: true, isFundraising: true, campaignType: null,
    })
    expect(r.valid).toBe(false)
    expect(r.errors[0].code).toBe('campaign_type_required')
  })

  it('only approved_contacts needs a non-empty contact list', () => {
    expect(validateAccess({ selectedAccess: 'open', approvedContactsCount: 0 }).valid).toBe(true)
    expect(validateAccess({ selectedAccess: 'approved_contacts', approvedContactsCount: 0 }).valid).toBe(false)
    expect(validateAccess({ selectedAccess: 'approved_contacts', approvedContactsCount: 1 }).valid).toBe(true)
  })

  it('form is satisfied by a template OR a field — not both', () => {
    expect(validateForm({ templateCount: 1, fieldCount: 0 }).valid).toBe(true)
    expect(validateForm({ templateCount: 0, fieldCount: 1 }).valid).toBe(true)
    expect(validateForm({ templateCount: 0, fieldCount: 0 }).valid).toBe(false)
  })
})

describe('result shape', () => {
  it('a valid result carries no errors, an invalid one carries exactly one code', () => {
    const good = validateVisibility({ selectedVisibility: 'public' })
    expect(good).toEqual({ valid: true, errors: [], warnings: [] })

    const bad = validateVisibility({ selectedVisibility: null })
    expect(bad.valid).toBe(false)
    expect(bad.errors).toHaveLength(1)
    expect(bad.errors[0]).toEqual({ code: 'visibility_required', field: 'visibility' })
    expect(bad.warnings).toEqual([])
  })

  it('no step raises a warning today', () => {
    expect(validateEventType({ selectedType: null, hasValidSubtype: false, isFundraising: true, campaignType: null }).warnings).toEqual([])
    expect(validatePricing({ passCount: 0 }).warnings).toEqual([])
  })

  it('error codes are unique across the registry', () => {
    const codes = [
      validateEventType({ selectedType: null, hasValidSubtype: false, isFundraising: false, campaignType: null }),
      validateEventType({ selectedType: 'x', hasValidSubtype: false, isFundraising: false, campaignType: null }),
      validateEventType({ selectedType: 'x', hasValidSubtype: true, isFundraising: true, campaignType: null }),
      validateVisibility({ selectedVisibility: null }),
      validateAccess({ selectedAccess: null, approvedContactsCount: 0 }),
      validateAccess({ selectedAccess: 'approved_contacts', approvedContactsCount: 0 }),
      validatePricing({ passCount: 0 }),
      validateForm({ templateCount: 0, fieldCount: 0 }),
    ].map(r => r.errors[0].code)
    expect(new Set(codes).size).toBe(codes.length)
  })
})

describe('the lookup is keyed by stable id', () => {
  it('validateStep dispatches to the same function as a direct call', () => {
    expect(validateStep('pricing', { passCount: 0 }))
      .toEqual(validatePricing({ passCount: 0 }))
    expect(validateStep('access', { selectedAccess: 'open', approvedContactsCount: 0 }))
      .toEqual(validateAccess({ selectedAccess: 'open', approvedContactsCount: 0 }))
  })

  it('every validated id is a real step id in some flow', () => {
    // Guards against a typo'd key that would silently never run. Checked against the
    // registry itself rather than a hand-kept list, so the two cannot drift.
    const known = new Set(
      (['standard', 'fundraising', 'campaign'] as const).flatMap(f => stepsFor(f).map(s => s.id)),
    )
    for (const id of Object.keys(STEP_VALIDATORS)) {
      expect(known, `unknown step id: ${id}`).toContain(id)
    }
  })

  it('deferred steps DO have a validator — the deferral lives at the call site', () => {
    // RD-EVENT-05: these were unmodelled while the contract was inert. They now delegate to
    // lib/campaigns, and it is the `showErrors &&` guard in the component — not a missing
    // validator — that keeps Continue enabled on a first visit.
    for (const id of DEFERRED_GATES) {
      expect(hasValidator(id), id).toBe(true)
    }
  })

  it('ungated steps have no validator', () => {
    for (const id of UNGATED_STEPS) {
      expect(hasValidator(id), id).toBe(false)
    }
  })

  it('review is absent — publish authority stays with validatePublish', () => {
    expect(hasValidator('review')).toBe(false)
    expect(UNGATED_STEPS).toContain('review')
  })
})
