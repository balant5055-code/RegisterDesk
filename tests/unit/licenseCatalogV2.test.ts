// RD-LICENSE-01B Phase 3A — the client-safe V2 catalog helpers (revive + normalized view)
// that the provider/hook chain exposes. Pure — no Firebase, no fetch.

import { describe, it, expect } from 'vitest'
import {
  defaultLicenseCatalogV2, reviveCatalogV2, buildLicenseCatalogView,
  defaultLicenseCatalog,
} from '@/lib/licensing/licenseCatalogShared'
import { UNLIMITED } from '@/lib/licensing/eventLicense'

describe('defaultLicenseCatalogV2', () => {
  it('has the five approved tiers with regular/offer prices', () => {
    const c = defaultLicenseCatalogV2()
    expect(Object.keys(c)).toEqual(['free', 'starter', 'professional', 'business', 'enterprise'])
    expect(c.business.regularPricePaise).toBe(299_900)
    expect(c.business.offerPricePaise).toBe(249_900)
    expect(c.enterprise.limits.maxRegistrations).toBe(UNLIMITED)
  })
})

describe('reviveCatalogV2 — API payload → catalog', () => {
  it('revives a null limit to Infinity and preserves regular/offer', () => {
    const wire = { enterprise: { limits: { maxRegistrations: null }, regularPricePaise: 999_900, offerPricePaise: 799_900, licensePricePaise: 799_900 } }
    const c = reviveCatalogV2(wire)
    expect(c.enterprise.limits.maxRegistrations).toBe(UNLIMITED)
    expect(c.enterprise.offerPricePaise).toBe(799_900)
  })
  it('falls back per-tier to defaults for missing/garbage entries', () => {
    const c = reviveCatalogV2({ free: 'nonsense' })
    expect(c.free.limits.maxRegistrations).toBe(200)   // default
    expect(c.starter.regularPricePaise).toBe(129_900)  // untouched default
  })
  it('empty / non-object input → full defaults', () => {
    expect(reviveCatalogV2(null)).toEqual(defaultLicenseCatalogV2())
    expect(reviveCatalogV2(undefined)).toEqual(defaultLicenseCatalogV2())
  })
})

describe('buildLicenseCatalogView — normalized display view', () => {
  it('produces one ordered entry per tier with the required fields', () => {
    const view = buildLicenseCatalogView(defaultLicenseCatalogV2())
    expect(view.map(v => v.tier)).toEqual(['free', 'starter', 'professional', 'business', 'enterprise'])
    expect(view.map(v => v.order)).toEqual([0, 1, 2, 3, 4])
    for (const e of view) {
      expect(e.version).toBe(2)
      expect(typeof e.regularPricePaise).toBe('number')
      expect(typeof e.offerPricePaise).toBe('number')
      expect(e.licensePricePaise).toBe(e.offerPricePaise)   // charged === offer
    }
  })
  it('marks purchasable correctly (free is not purchasable)', () => {
    const view = buildLicenseCatalogView(defaultLicenseCatalogV2())
    expect(view.find(v => v.tier === 'free')!.purchasable).toBe(false)
    expect(view.find(v => v.tier === 'business')!.purchasable).toBe(true)
  })
})

describe('V1 catalog helpers remain unchanged (compatibility)', () => {
  it('defaultLicenseCatalog still exposes the 4 V1 tiers', () => {
    expect(Object.keys(defaultLicenseCatalog())).toEqual(['starter', 'growth', 'professional', 'enterprise'])
  })
})
