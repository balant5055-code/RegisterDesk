// RD-LICENSE-01B Phase 2 — version-aware resolution foundation. Proves the infra resolves
// V1 and V2 driven ONLY by the stored version, that historical V1 keeps working, that the
// new capacity buckets are exact, and that the schema/config validators accept both.

import { describe, it, expect } from 'vitest'
import {
  resolveVersionedLicenseDefinition, isValidTierForVersion,
} from '@/lib/licensing/eventLicense'
import {
  capacityPlanForRegistrationLimit, resolveTotalCapacity,
} from '@/lib/registrations/capacity'
import { validateEventLicense, validateLicenseOrder } from '@/lib/licensing/schema'
import { validateBusinessConfig, BUSINESS_CONFIG_DEFAULTS } from '@/lib/config/businessConfig'

describe('resolveVersionedLicenseDefinition — driven ONLY by version', () => {
  it('version 1 resolves the V1 catalog', () => {
    const d = resolveVersionedLicenseDefinition('growth', 1)!
    expect(d.version).toBe(1)
    expect(d.name).toBe('Growth')
    expect(d.licensePricePaise).toBe(99_900)
    expect(d.regularPricePaise).toBeUndefined()   // V1 has no regular/offer
  })

  it('version 2 resolves the V2 catalog with regular/offer', () => {
    const d = resolveVersionedLicenseDefinition('business', 2)!
    expect(d.version).toBe(2)
    expect(d.name).toBe('Business')
    expect(d.regularPricePaise).toBe(299_900)
    expect(d.offerPricePaise).toBe(249_900)
    expect(d.licensePricePaise).toBe(249_900)     // charged === offer
    expect(d.limits.maxRegistrations).toBe(5_000)
  })

  it('NEVER infers by tier name — a V2-only tier under v1 (or vice versa) is null', () => {
    expect(resolveVersionedLicenseDefinition('business', 1)).toBeNull()  // business not in V1
    expect(resolveVersionedLicenseDefinition('growth', 2)).toBeNull()    // growth not in V2
    expect(resolveVersionedLicenseDefinition('nonsense', 1)).toBeNull()
  })

  it('shared ids resolve to the version-appropriate table', () => {
    // 'professional' exists in BOTH, with DIFFERENT values per version.
    expect(resolveVersionedLicenseDefinition('professional', 1)!.limits.maxRegistrations).toBe(5_000)
    expect(resolveVersionedLicenseDefinition('professional', 2)!.limits.maxRegistrations).toBe(2_500)
  })

  it('isValidTierForVersion respects the version vocabulary', () => {
    expect(isValidTierForVersion('growth', 1)).toBe(true)
    expect(isValidTierForVersion('growth', 2)).toBe(false)
    expect(isValidTierForVersion('free', 2)).toBe(true)
    expect(isValidTierForVersion('free', 1)).toBe(false)
  })
})

describe('capacity buckets — V2 additive, V1 preserved', () => {
  it('maps V2 limits exactly (200 + 2,500 new buckets)', () => {
    expect(capacityPlanForRegistrationLimit(200)).toBe('pack_200')
    expect(capacityPlanForRegistrationLimit(2500)).toBe('pack_2500')
    expect(resolveTotalCapacity('pack_200')).toBe(200)
    expect(resolveTotalCapacity('pack_2500')).toBe(2500)
  })

  it('historical V1 limits map exactly as before', () => {
    expect(capacityPlanForRegistrationLimit(100)).toBe('free')
    expect(capacityPlanForRegistrationLimit(1000)).toBe('pack_1000')
    expect(capacityPlanForRegistrationLimit(5000)).toBe('pack_5000')
    expect(capacityPlanForRegistrationLimit(Infinity)).toBe('unlimited')
    expect(resolveTotalCapacity('free')).toBe(100)
    expect(resolveTotalCapacity('unlimited')).toBeNull()
  })

  it('the full V2 catalog ladder maps Free→200 … Enterprise→Unlimited', () => {
    expect(capacityPlanForRegistrationLimit(200)).toBe('pack_200')     // Free
    expect(capacityPlanForRegistrationLimit(1000)).toBe('pack_1000')   // Starter
    expect(capacityPlanForRegistrationLimit(2500)).toBe('pack_2500')   // Professional
    expect(capacityPlanForRegistrationLimit(5000)).toBe('pack_5000')   // Business
    expect(capacityPlanForRegistrationLimit(Infinity)).toBe('unlimited') // Enterprise
  })
})

describe('persisted schema validator — version-aware, accepts both', () => {
  const base = { organizerUid: 'u1', status: 'active' as const, amountPaise: 0 }
  it('version 1 accepts V1 tiers, rejects V2-only tiers', () => {
    expect(validateEventLicense({ ...base, tier: 'growth', version: 1 }).valid).toBe(true)
    expect(validateEventLicense({ ...base, tier: 'business', version: 1 }).valid).toBe(false)
  })
  it('version 2 accepts V2 tiers, rejects V1-only tiers', () => {
    expect(validateEventLicense({ ...base, tier: 'business', version: 2 }).valid).toBe(true)
    expect(validateEventLicense({ ...base, tier: 'free', version: 2 }).valid).toBe(true)
    expect(validateEventLicense({ ...base, tier: 'growth', version: 2 }).valid).toBe(false)
  })
  it('license order validator is version-aware too', () => {
    expect(validateLicenseOrder({ eventId: 'e', organizerUid: 'u', tier: 'growth', amountPaise: 0, currency: 'INR' }).valid).toBe(true)
    expect(validateLicenseOrder({ eventId: 'e', organizerUid: 'u', tier: 'business', amountPaise: 0, currency: 'INR', version: 2 } as never).valid).toBe(true)
  })
})

describe('business config — V2 overrides validate additively', () => {
  it('default config (with empty tierOverridesV2) is valid', () => {
    expect(validateBusinessConfig({ licensing: BUSINESS_CONFIG_DEFAULTS.licensing }).valid).toBe(true)
  })
  it('accepts a valid V2 override with regular/offer', () => {
    const r = validateBusinessConfig({
      licensing: { ...BUSINESS_CONFIG_DEFAULTS.licensing, tierOverridesV2: { business: { regularPricePaise: 299900, offerPricePaise: 249900 } } },
    })
    expect(r.valid).toBe(true)
  })
  it('rejects offer > regular and unknown V2 tiers', () => {
    expect(validateBusinessConfig({
      licensing: { ...BUSINESS_CONFIG_DEFAULTS.licensing, tierOverridesV2: { business: { regularPricePaise: 100, offerPricePaise: 200 } } },
    }).valid).toBe(false)
    expect(validateBusinessConfig({
      licensing: { ...BUSINESS_CONFIG_DEFAULTS.licensing, tierOverridesV2: { growth: { offerPricePaise: 1 } } as never },
    }).valid).toBe(false)
  })
})
