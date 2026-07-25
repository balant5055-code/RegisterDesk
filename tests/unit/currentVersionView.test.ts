// RD-LICENSE-GA-03 — the current-version catalog view (write-coupled selector primitive).
// At CURRENT_LICENSE_VERSION=1 it MUST render the V1 tiers (so a wizard/admin selection is
// valid for the write layer); it flips to V2 only when the version does.

import { describe, it, expect } from 'vitest'
import {
  buildCurrentLicenseCatalogView, defaultLicenseCatalog, defaultLicenseCatalogV2,
} from '@/lib/licensing/licenseCatalogShared'
import { currentLicenseTierIds, CURRENT_LICENSE_VERSION } from '@/lib/licensing/eventLicense'

const v1 = defaultLicenseCatalog()
const v2 = defaultLicenseCatalogV2()

describe('buildCurrentLicenseCatalogView', () => {
  it('version 1 → the 4 V1 tiers, regular === offer (no discount)', () => {
    const view = buildCurrentLicenseCatalogView(v1, v2, 1)
    expect(view.map(e => e.tier)).toEqual(['starter', 'growth', 'professional', 'enterprise'])
    for (const e of view) {
      expect(e.regularPricePaise).toBe(e.offerPricePaise)   // V1: no strike-through
      expect(e.licensePricePaise).toBe(e.offerPricePaise)
    }
  })

  it('version 2 → the 5 approved V2 tiers with regular/offer split', () => {
    const view = buildCurrentLicenseCatalogView(v1, v2, 2)
    expect(view.map(e => e.tier)).toEqual(['free', 'starter', 'professional', 'business', 'enterprise'])
    const biz = view.find(e => e.tier === 'business')!
    expect(biz.regularPricePaise).toBe(299_900)
    expect(biz.offerPricePaise).toBe(249_900)
  })

  it('currentLicenseTierIds reflects the ACTIVE version — V2 after the GA-04 cutover', () => {
    expect(CURRENT_LICENSE_VERSION).toBe(2)
    expect(currentLicenseTierIds()).toEqual(['free', 'starter', 'professional', 'business', 'enterprise'])
  })
})
