// RD-LICENSE-01B Phase 3B — public pricing builders render ONLY from the V2 catalog view,
// with the exact approved figures, correct strike-through logic, order, and "Unlimited".

import { describe, it, expect } from 'vitest'
import { buildPricingTiers } from '@/content/marketing/pricing'
import { buildPricingPreviewPlans } from '@/content/marketing/pricing-preview'
import { defaultLicenseCatalogV2 } from '@/lib/licensing/licenseCatalogShared'

const tiers = buildPricingTiers(defaultLicenseCatalogV2())
const byId = new Map(tiers.map(t => [t.id, t]))

describe('pricing page — 5 V2 tiers, approved figures, correct order', () => {
  it('renders exactly the 5 V2 tiers in catalog order (no Growth, no old count)', () => {
    expect(tiers.map(t => t.id)).toEqual(['free', 'starter', 'professional', 'business', 'enterprise'])
    expect(tiers.map(t => t.name)).toEqual(['Free', 'Starter', 'Professional', 'Business', 'Enterprise'])
    expect(tiers.some(t => /growth/i.test(t.id) || /growth/i.test(t.name))).toBe(false)
  })

  // [id, priceLabel(offer), regularPriceLabel(struck|null), limit-feature]
  const expected = [
    ['free',         'Free',   null,      '200 registrations'],
    ['starter',      '₹999',   '₹1,299',  '1,000 registrations'],
    ['professional', '₹1,499', '₹1,999',  '2,500 registrations'],
    ['business',     '₹2,499', '₹2,999',  '5,000 registrations'],
    ['enterprise',   '₹7,999', '₹9,999',  'Unlimited registrations'],
  ] as const

  it.each(expected)('%s shows offer + struck regular + limit exactly', (id, price, regular, limitFeature) => {
    const t = byId.get(id)!
    expect(t.priceLabel).toBe(price)
    expect(t.regularPriceLabel).toBe(regular)      // null for Free (never strike ₹0)
    expect(t.features[0]).toBe(limitFeature)
  })

  it('Free has no period and no strike; paid tiers have /event', () => {
    expect(byId.get('free')!.period).toBeNull()
    expect(byId.get('free')!.regularPriceLabel).toBeNull()
    expect(byId.get('business')!.period).toBe('/event')
  })

  it('exactly one highlighted tier', () => {
    expect(tiers.filter(t => t.highlighted)).toHaveLength(1)
  })
})

describe('homepage preview — curated V2 subset, same figures + strike logic', () => {
  const plans = buildPricingPreviewPlans(defaultLicenseCatalogV2())
  it('features 3 real V2 tiers with correct labels', () => {
    expect(plans.map(p => p.id)).toEqual(['free', 'business', 'enterprise'])
    expect(plans.find(p => p.id === 'free')!.priceLabel).toBe('Free')
    expect(plans.find(p => p.id === 'free')!.regularPriceLabel).toBeNull()
    const biz = plans.find(p => p.id === 'business')!
    expect(biz.priceLabel).toBe('₹2,499')
    expect(biz.regularPriceLabel).toBe('₹2,999')
    expect(plans.find(p => p.id === 'enterprise')!.highlights[0]).toBe('Unlimited registrations')
  })
})
