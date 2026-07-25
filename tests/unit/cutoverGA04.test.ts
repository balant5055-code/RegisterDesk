// RD-LICENSE-GA-04 — production cutover verification. Asserts the single production
// licensing system: NEW licenses resolve/validate as Licensing V2, while historical
// version-1 licenses keep resolving through the frozen V1 table.

import { describe, it, expect } from 'vitest'
import {
  CURRENT_LICENSE_VERSION, LICENSE_VERSION_V2,
  currentLicenseTierIds, defaultLicenseTierForVersion, isValidTierForVersion,
  resolveVersionedLicenseDefinition, getEventLicenseDefinition,
} from '@/lib/licensing/eventLicense'
import {
  buildCurrentLicenseCatalogView, defaultLicenseCatalog, defaultLicenseCatalogV2,
  resolveLicenseEntryForVersion, pickVersionedDefinition,
} from '@/lib/licensing/licenseCatalogShared'

const v1 = defaultLicenseCatalog()
const v2 = defaultLicenseCatalogV2()

describe('GA-04 — the current production version is V2', () => {
  it('CURRENT_LICENSE_VERSION === 2', () => {
    expect(CURRENT_LICENSE_VERSION).toBe(LICENSE_VERSION_V2)
    expect(CURRENT_LICENSE_VERSION).toBe(2)
  })

  it('write/admin selectors offer the V2 vocabulary', () => {
    expect(currentLicenseTierIds()).toEqual(['free', 'starter', 'professional', 'business', 'enterprise'])
    expect(defaultLicenseTierForVersion(CURRENT_LICENSE_VERSION)).toBe('free')
  })

  it('validation now accepts V2 tiers and rejects V1-only tiers', () => {
    expect(isValidTierForVersion('business', CURRENT_LICENSE_VERSION)).toBe(true)
    expect(isValidTierForVersion('free', CURRENT_LICENSE_VERSION)).toBe(true)
    expect(isValidTierForVersion('growth', CURRENT_LICENSE_VERSION)).toBe(false)   // V1-only
  })

  it('the current-version catalog view is the 5 approved V2 tiers with regular/offer', () => {
    const view = buildCurrentLicenseCatalogView(v1, v2, CURRENT_LICENSE_VERSION)
    expect(view.map(e => e.tier)).toEqual(['free', 'starter', 'professional', 'business', 'enterprise'])
    const biz = view.find(e => e.tier === 'business')!
    expect(biz.regularPricePaise).toBe(299_900)
    expect(biz.offerPricePaise).toBe(249_900)
    expect(biz.registrationLimit).toBe(5000)
  })

  it('a NEW license resolves as V2 (Business → 5,000, ₹2,499 charged)', () => {
    const d = resolveVersionedLicenseDefinition('business', CURRENT_LICENSE_VERSION)!
    expect(d.name).toBe('Business')
    expect(d.limits.maxRegistrations).toBe(5000)
    expect(d.licensePricePaise).toBe(249_900)
  })
})

describe('GA-04 — historical V1 licenses still resolve (never regress)', () => {
  it('the frozen V1 table is intact', () => {
    expect(getEventLicenseDefinition('growth').licensePricePaise).toBe(99_900)
    expect(getEventLicenseDefinition('professional').limits.maxRegistrations).toBe(5000)
  })

  it('a stored version-1 "growth" license resolves through V1 (name + limit)', () => {
    const d = resolveVersionedLicenseDefinition('growth', 1)!
    expect(d.version).toBe(1)
    expect(d.name).toBe('Growth')
    expect(d.limits.maxRegistrations).toBe(1000)
  })

  it('version-aware display resolves a V1 license by its stored version, a V2 by its own', () => {
    expect(resolveLicenseEntryForVersion(v1, v2, 'growth', 1).name).toBe('Growth')
    expect(resolveLicenseEntryForVersion(v1, v2, 'business', 2).name).toBe('Business')
    expect(pickVersionedDefinition(v1, v2, 'growth', 1).limits.maxRegistrations).toBe(1000)
    expect(pickVersionedDefinition(v1, v2, 'business', 2).limits.maxRegistrations).toBe(5000)
  })
})
