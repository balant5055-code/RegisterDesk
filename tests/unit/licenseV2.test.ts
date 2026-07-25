// RD-LICENSE-01A — Licensing V2 foundation. Locks the approved 5-tier catalog values
// AND proves V1 is untouched (backward-compatibility guard). V2 is not consumed anywhere;
// these tests assert the model only.

import { describe, it, expect } from 'vitest'
import {
  // V2 (new)
  EVENT_LICENSE_TIERS_V2, LICENSE_VERSION_V2, EVENT_LICENSE_DEFINITIONS_V2,
  getEventLicenseDefinitionV2, isEventLicenseTierV2, nextEventLicenseTierV2,
  PURCHASABLE_LICENSE_TIERS_V2, DEFAULT_EVENT_LICENSE_TIER_V2,
  // V1 (must be unchanged)
  EVENT_LICENSE_TIERS, CURRENT_LICENSE_VERSION, getEventLicenseDefinition,
  UNLIMITED, type EventLicenseTierV2,
} from '@/lib/licensing/eventLicense'

describe('Licensing V2 — approved 5-tier catalog', () => {
  it('has exactly the five approved tiers in order', () => {
    expect(EVENT_LICENSE_TIERS_V2).toEqual(['free', 'starter', 'professional', 'business', 'enterprise'])
  })

  it('is schema version 2, default free', () => {
    expect(LICENSE_VERSION_V2).toBe(2)
    expect(DEFAULT_EVENT_LICENSE_TIER_V2).toBe('free')
  })

  // [tier, limit, regularPaise, offerPaise]
  const expected: Array<[EventLicenseTierV2, number, number, number]> = [
    ['free',          200,       0,       0],
    ['starter',       1_000, 129_900,  99_900],
    ['professional',  2_500, 199_900, 149_900],
    ['business',      5_000, 299_900, 249_900],
    ['enterprise', UNLIMITED, 999_900, 799_900],
  ]

  it.each(expected)('%s: limit + regular/offer prices match the approved model', (tier, limit, regular, offer) => {
    const def = getEventLicenseDefinitionV2(tier)
    expect(def.limits.maxRegistrations).toBe(limit)
    expect(def.regularPricePaise).toBe(regular)
    expect(def.offerPricePaise).toBe(offer)
    // offer is the charged price → must equal licensePricePaise (V1-compatible semantics)
    expect(def.licensePricePaise).toBe(offer)
    // offer never exceeds regular
    expect(def.offerPricePaise).toBeLessThanOrEqual(def.regularPricePaise)
  })

  it('purchasable V2 tiers exclude free', () => {
    expect(PURCHASABLE_LICENSE_TIERS_V2).toEqual(['starter', 'professional', 'business', 'enterprise'])
  })

  it('guards + next-tier accessor work', () => {
    expect(isEventLicenseTierV2('business')).toBe(true)
    expect(isEventLicenseTierV2('growth')).toBe(false)   // V1-only id
    expect(nextEventLicenseTierV2('free')).toBe('starter')
    expect(nextEventLicenseTierV2('enterprise')).toBeNull()
  })

  it('every V2 tier has a complete definition', () => {
    for (const t of EVENT_LICENSE_TIERS_V2) {
      const d = EVENT_LICENSE_DEFINITIONS_V2[t]
      expect(d.name).toBeTruthy()
      expect(Object.keys(d.features)).toHaveLength(7)
      expect(d.featureList.length).toBeGreaterThan(0)
    }
  })
})

describe('Licensing V1 — frozen table intact (historical compatibility)', () => {
  it('the V1 vocabulary + table are unchanged; current version is now V2 (GA-04 cutover)', () => {
    expect(CURRENT_LICENSE_VERSION).toBe(2)   // new licenses are V2 after the cutover
    expect(EVENT_LICENSE_TIERS).toEqual(['starter', 'growth', 'professional', 'enterprise'])   // V1 vocab frozen for historical licenses
  })

  it('V1 definitions retain their original single-price values', () => {
    expect(getEventLicenseDefinition('starter').licensePricePaise).toBe(0)
    expect(getEventLicenseDefinition('growth').licensePricePaise).toBe(99_900)
    expect(getEventLicenseDefinition('professional').licensePricePaise).toBe(249_900)
    expect(getEventLicenseDefinition('enterprise').licensePricePaise).toBe(499_900)
    // V1 defs must NOT carry the V2 regular/offer fields
    expect((getEventLicenseDefinition('growth') as Record<string, unknown>).offerPricePaise).toBeUndefined()
  })
})
