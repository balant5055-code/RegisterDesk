// RD-EVENT-05 — the contract is the ONLY implementation of each step rule.
//
// The truth-table parity tests in `stepValidation.test.ts` prove the contract computes what
// the old expressions computed. These tests prove the old expressions are GONE — that no
// component still carries a second copy of a rule that could drift from the contract.
//
// They read the component sources as text, deliberately: a rule that has been re-inlined
// somewhere is a source-level fact, and no amount of calling `validateStep` in one place
// proves the absence of a duplicate in another.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { validateDetails, validateFundraising, STEP_VALIDATORS } from '@/lib/events/builder/stepValidation'
import { isCampaignDetailsValid, makeBlankCampaignDetailsDraft } from '@/lib/campaigns/campaignDetailsConfig'
import { isLinkedCampaignNavigationValid, makeBlankLinkedCampaignDraft } from '@/lib/campaigns/linkedCampaignConfig'

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')

const STEPS = {
  eventType:   'components/event-builder/steps/Step1View.tsx',
  visibility:  'components/event-builder/steps/Step2View.tsx',
  access:      'components/event-builder/steps/Step3View.tsx',
  pricing:     'components/event-builder/steps/Step4View.tsx',
  form:        'components/event-builder/steps/Step5View.tsx',
  fundraising: 'components/wizard/LinkedCampaignStep.tsx',
  details:     'app/(dashboard)/dashboard/events/new/page.tsx',
} as const

describe('every gated step calls the contract', () => {
  for (const [id, path] of Object.entries(STEPS)) {
    it(`${id} · ${path} invokes validateStep('${id}', …)`, () => {
      const src = read(path)
      expect(src).toContain("from '@/lib/events/builder/stepValidation'")
      expect(src).toContain(`validateStep('${id}'`)
    })
  }

  it('every id in STEP_VALIDATORS has a migrated call site', () => {
    expect(Object.keys(STEP_VALIDATORS).sort()).toEqual(Object.keys(STEPS).sort())
  })
})

describe('no local copy of a rule survived', () => {
  const gone: [keyof typeof STEPS, string][] = [
    // The exact expressions RD-EVENT-05 replaced.
    ['eventType',  '!isFundraising || campaignType !== null'],
    ['visibility', 'canProceed         = selectedVisibility !== null'],
    ['access',     "selectedAccess !== 'approved_contacts' || approvedContacts.length > 0"],
    ['pricing',    'pricing.passes.length === 0'],
    ['form',       'form.template.length > 0 || form.fields.length > 0'],
    ['fundraising','isLinkedCampaignNavigationValid(draft)'],
    ['details',    'isCampaignDetailsValid(campaignDetails)'],
  ]

  for (const [id, expression] of gone) {
    it(`${id} no longer restates its rule inline`, () => {
      expect(read(STEPS[id])).not.toContain(expression)
    })
  }

  it('Step4 drives BOTH its footer and its warning from one boolean', () => {
    const src = read(STEPS.pricing)
    // Two sites previously counted passes independently. Exactly one does now.
    expect(src.match(/pricing\.passes\.length === 0/g)).toBeNull()
    expect(src).toContain('isNextDisabled={!canProceed}')
    expect(src).toContain('{!canProceed && (')
  })
})

describe('deferred UX is preserved, not normalised away', () => {
  it('details still defers to showDetailsErrors', () => {
    expect(read(STEPS.details)).toContain('isNextDisabled={showDetailsErrors && !detailsValid}')
  })

  it('fundraising still defers to showErrors', () => {
    expect(read(STEPS.fundraising))
      .toContain("isNextDisabled={showErrors && !validateStep('fundraising', { draft }).valid}")
  })
})

describe('deferred validators delegate — they do not restate the campaign rules', () => {
  it('details agrees with isCampaignDetailsValid', () => {
    const draft = makeBlankCampaignDetailsDraft()
    expect(validateDetails({ draft }).valid).toBe(isCampaignDetailsValid(draft))
  })

  it('fundraising agrees with isLinkedCampaignNavigationValid', () => {
    const draft = makeBlankLinkedCampaignDraft()
    expect(validateFundraising({ draft }).valid).toBe(isLinkedCampaignNavigationValid(draft))
  })
})

describe('review stays out of the contract', () => {
  it('the publish gate is untouched and names no validateStep call', () => {
    const src = read(STEPS.details)
    expect(src).toContain('!allTermsAccepted || !report.canPublish')
    expect(src).not.toContain("validateStep('review'")
  })
})
