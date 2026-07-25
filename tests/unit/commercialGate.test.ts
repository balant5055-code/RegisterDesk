// RD-PAYMENT-02 Phase 0.6 — CERT-D1 gate regression test.
//
// The commercial model is part of the dormant pricing engine. While
// `features.pricingEngineEnabled` is false, the EFFECTIVE model MUST resolve to
// production organizer_pays (`DEFAULT_COMMERCIAL_MODEL`) regardless of any stored
// attendee-pays value — otherwise the order-pricing snapshot (the only production
// consumer of the commercial model) would compute customer_pays while checkout still
// charges the bare ticket, silently over-crediting organizers and zeroing platform fees.

import { describe, it, expect } from 'vitest'
import { effectiveCommercialModel, DEFAULT_COMMERCIAL_MODEL } from '@/lib/platform/pricing/commercial'
import { cloneDefaultPlatformSettings } from '@/lib/platform/pricing/defaults'
import type { PlatformSettings, CommercialModel } from '@/lib/platform/pricing/types'

const settingsWith = (
  pricingEngineEnabled: boolean,
  commercial: Partial<CommercialModel>,
): PlatformSettings => {
  const s = cloneDefaultPlatformSettings()
  s.features.pricingEngineEnabled = pricingEngineEnabled
  s.commercial = { ...s.commercial, ...commercial }
  return s
}

describe('effectiveCommercialModel — CERT-D1 gate', () => {
  it('forces organizer_pays default when the engine is DORMANT, even if attendee is stored', () => {
    const s = settingsWith(false, { platformFeePaidBy: 'attendee', gatewayFeePaidBy: 'attendee' })
    expect(effectiveCommercialModel(s)).toEqual(DEFAULT_COMMERCIAL_MODEL)
    expect(effectiveCommercialModel(s).platformFeePaidBy).toBe('organizer')
    expect(effectiveCommercialModel(s).gatewayFeePaidBy).toBe('organizer')
  })

  it('does NOT mutate the stored settings — admin read/write round-trip still sees the raw value', () => {
    const s = settingsWith(false, { platformFeePaidBy: 'attendee', gatewayFeePaidBy: 'attendee' })
    effectiveCommercialModel(s)
    expect(s.commercial.platformFeePaidBy).toBe('attendee')
    expect(s.commercial.gatewayFeePaidBy).toBe('attendee')
  })

  it('passes the stored model through unchanged when the engine is ENABLED', () => {
    const s = settingsWith(true, { platformFeePaidBy: 'attendee', gatewayFeePaidBy: 'attendee' })
    expect(effectiveCommercialModel(s)).toBe(s.commercial)
    expect(effectiveCommercialModel(s).platformFeePaidBy).toBe('attendee')
  })

  it('is organizer_pays for default (unconfigured) settings, whichever way the flag is set', () => {
    expect(effectiveCommercialModel(settingsWith(false, {}))).toEqual(DEFAULT_COMMERCIAL_MODEL)
    expect(effectiveCommercialModel(settingsWith(true, {})).platformFeePaidBy).toBe('organizer')
  })
})
