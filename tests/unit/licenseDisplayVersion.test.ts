// RD-LICENSE-01B Phase 3C — version-aware DISPLAY of owned licenses. Proves a screen can
// render a V1 license (historical) AND a V2 license correctly, driven by stored version,
// without crashing on a tier absent from the other version's catalog.

import { describe, it, expect } from 'vitest'
import {
  resolveLicenseEntryForVersion, pickVersionedDefinition,
  defaultLicenseCatalog, defaultLicenseCatalogV2,
} from '@/lib/licensing/licenseCatalogShared'
import { UNLIMITED } from '@/lib/licensing/eventLicense'

const v1 = defaultLicenseCatalog()
const v2 = defaultLicenseCatalogV2()

describe('resolveLicenseEntryForVersion — driven by stored version', () => {
  it('a V1 license (version 1) resolves the V1 catalog (incl. V1-only "growth")', () => {
    const e = resolveLicenseEntryForVersion(v1, v2, 'growth', 1)
    expect(e.version).toBe(1)
    expect(e.name).toBe('Growth')
    expect(e.registrationLimit).toBe(1000)
    expect(e.regularPricePaise).toBe(e.offerPricePaise)   // V1: no discount split
    expect(e.nextTierName).toBe('Professional')
  })

  it('a V2 license (version 2) resolves the V2 catalog with regular/offer', () => {
    const e = resolveLicenseEntryForVersion(v1, v2, 'business', 2)
    expect(e.version).toBe(2)
    expect(e.name).toBe('Business')
    expect(e.registrationLimit).toBe(5000)
    expect(e.regularPricePaise).toBe(299_900)
    expect(e.offerPricePaise).toBe(249_900)
    expect(e.nextTierName).toBe('Enterprise')
  })

  it('a V2 unlimited tier reports Infinity (rendered as "Unlimited")', () => {
    expect(resolveLicenseEntryForVersion(v1, v2, 'enterprise', 2).registrationLimit).toBe(UNLIMITED)
  })

  it('NEVER resolves against the wrong version — a mismatched tier falls back safely', () => {
    // 'growth' is V1-only; stamped version 2 (corrupt) → safe fallback, no crash.
    const e = resolveLicenseEntryForVersion(v1, v2, 'growth', 2)
    expect(e.tier).toBe('starter')
    expect(e.name).toBeTruthy()
    // 'business' is V2-only; stamped version 1 → safe fallback.
    expect(resolveLicenseEntryForVersion(v1, v2, 'business', 1).tier).toBe('starter')
  })

  it('enterprise (top tier) has no next tier on either version', () => {
    expect(resolveLicenseEntryForVersion(v1, v2, 'enterprise', 1).nextTierName).toBeNull()
    expect(resolveLicenseEntryForVersion(v1, v2, 'enterprise', 2).nextTierName).toBeNull()
  })
})

describe('pickVersionedDefinition — full def for the admin overlay (Phase 3C.1)', () => {
  it('picks the V1 def for a V1 license and the V2 def for a V2 license', () => {
    expect(pickVersionedDefinition(v1, v2, 'growth', 1).name).toBe('Growth')
    expect(pickVersionedDefinition(v1, v2, 'growth', 1).limits.maxRegistrations).toBe(1000)
    expect(pickVersionedDefinition(v1, v2, 'business', 2).name).toBe('Business')
    expect(pickVersionedDefinition(v1, v2, 'business', 2).limits.maxRegistrations).toBe(5000)
  })
  it('falls back to V1 Starter when the tier is invalid for the version (no crash)', () => {
    expect(pickVersionedDefinition(v1, v2, 'business', 1).name).toBe('Starter')  // business not in V1
    expect(pickVersionedDefinition(v1, v2, 'growth', 2).name).toBe('Starter')    // growth not in V2
  })
})
