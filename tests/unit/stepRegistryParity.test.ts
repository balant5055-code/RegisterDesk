// RD-EVENT-03 — parity between the registry and the positional chains it replaced.
//
// The reference implementations below are the `if (step === N)` chains copied VERBATIM from
// `app/(dashboard)/dashboard/events/new/page.tsx` as they stood before the migration
// (goNext 3871–3884, saveDraft 3933–3952, autosave 3967–3969).
//
// The test asserts the registry produces a byte-identical payload for EVERY step of BOTH
// flows. If a future edit changes what a step writes, this fails — rather than an
// organizer's draft silently losing a field.
//
// `step0` is expanded into four top-level fields by the caller, so the reference does the
// same; that expansion is the one key that is not a straight assignment.

import { describe, it, expect } from 'vitest'
import { draftKeyFor, stepsFor, type WizardFlow } from '@/lib/events/builder/stepRegistry'

type Payload = Record<string, unknown>

/** The exact shape `applyStepPayload` produces, driven by the registry. */
function viaRegistry(flow: WizardFlow, step: number, data: unknown, site: 'next' | 'saveDraft' | 'autosave'): Payload {
  const payload: Payload = {}
  const key = draftKeyFor(flow, step, site)
  if (!key) return payload
  if (key === 'step0') {
    const d = data as { eventType?: string; subtype?: string; customSubtype?: string; campaignType?: string } | null
    payload.eventType          = d?.eventType     ?? null
    payload.eventSubtype       = d?.subtype       ?? null
    payload.customEventSubtype = d?.customSubtype ?? null
    payload.campaignType       = d?.campaignType  ?? null
    return payload
  }
  payload[key] = data
  return payload
}

// ─── Reference: the ORIGINAL chains ──────────────────────────────────────────

function legacyGoNext(step: number, data: unknown, isEventPlusDonation: boolean): Payload {
  const payload: Payload = {}
  if (step === 0) {
    const d = data as { eventType?: string; subtype?: string; customSubtype?: string; campaignType?: string } | null
    payload.eventType          = d?.eventType     ?? null
    payload.eventSubtype       = d?.subtype       ?? null
    payload.customEventSubtype = d?.customSubtype ?? null
    payload.campaignType       = d?.campaignType  ?? null
  }
  if (step === 1) payload.visibility       = data
  if (step === 2) payload.accessControl    = data
  if (step === 3) payload.pricing          = data
  if (step === 4) payload.registrationForm = data
  if (step === 5) payload.eventDetails     = data
  if (step === 6 && isEventPlusDonation) payload.linkedCampaign = data
  return payload
}

function legacySaveDraft(step: number, data: unknown, isEventPlusDonation: boolean): Payload {
  const payload: Payload = {}
  if (step === 0) {
    const d = data as { eventType?: string; subtype?: string; customSubtype?: string; campaignType?: string } | null
    payload.eventType          = d?.eventType     ?? null
    payload.eventSubtype       = d?.subtype       ?? null
    payload.customEventSubtype = d?.customSubtype ?? null
    payload.campaignType       = d?.campaignType  ?? null
  }
  if (step === 1) payload.visibility        = data
  if (step === 2) payload.accessControl     = data
  if (step === 3) payload.pricing           = data
  if (step === 4) payload.registrationForm  = data
  if (step === 5) payload.eventDetails      = data
  if (step === 6 && isEventPlusDonation)  payload.linkedCampaign = data
  if (step === 6 && !isEventPlusDonation) payload.licenseTier    = data
  if (step === 7 && isEventPlusDonation)  payload.licenseTier    = data
  if (step === 7 && !isEventPlusDonation) payload.pricing        = data
  if (step === 8 && isEventPlusDonation)  payload.pricing        = data
  return payload
}

function legacyAutosave(step: number, data: unknown): Payload {
  const payload: Payload = {}
  if (step === 3) payload.pricing          = data
  if (step === 4) payload.registrationForm = data
  if (step === 5) payload.eventDetails     = data
  return payload
}

// ─── Parity ──────────────────────────────────────────────────────────────────

const STEP1 = { eventType: 'marathon', subtype: '10k', customSubtype: null, campaignType: 'event_only' }
const SAMPLE = { some: 'payload' }

describe('registry parity with the replaced positional chains', () => {
  const flows: { flow: WizardFlow; fundraising: boolean }[] = [
    { flow: 'standard',    fundraising: false },
    { flow: 'fundraising', fundraising: true  },
  ]

  for (const { flow, fundraising } of flows) {
    const last = stepsFor(flow).length - 1

    it(`${flow} · goNext produces the identical payload at every step`, () => {
      for (let step = 0; step <= last; step++) {
        const data = step === 0 ? STEP1 : SAMPLE
        expect(viaRegistry(flow, step, data, 'next'), `step ${step}`)
          .toEqual(legacyGoNext(step, data, fundraising))
      }
    })

    it(`${flow} · saveDraft produces the identical payload at every step`, () => {
      for (let step = 0; step <= last; step++) {
        const data = step === 0 ? STEP1 : SAMPLE
        expect(viaRegistry(flow, step, data, 'saveDraft'), `step ${step}`)
          .toEqual(legacySaveDraft(step, data, fundraising))
      }
    })

    it(`${flow} · autosave produces the identical payload at every step`, () => {
      for (let step = 0; step <= last; step++) {
        expect(viaRegistry(flow, step, SAMPLE, 'autosave'), `step ${step}`)
          .toEqual(legacyAutosave(step, SAMPLE))
      }
    })
  }

  it('the asymmetry survives: goNext writes nothing where saveDraft writes a tier', () => {
    // Standard License is index 6. This is the single most important parity case — it is
    // where the three call sites genuinely disagree, and where a "tidy-up" would regress.
    expect(viaRegistry('standard', 6, SAMPLE, 'next')).toEqual({})
    expect(viaRegistry('standard', 6, SAMPLE, 'saveDraft')).toEqual({ licenseTier: SAMPLE })
    expect(legacyGoNext(6, SAMPLE, false)).toEqual({})
    expect(legacySaveDraft(6, SAMPLE, false)).toEqual({ licenseTier: SAMPLE })
  })

  it('out-of-range steps write nothing, as the chains did', () => {
    for (const site of ['next', 'saveDraft', 'autosave'] as const) {
      expect(viaRegistry('standard', 99, SAMPLE, site)).toEqual({})
    }
  })
})
