// Pricing content — RD-LICENSE-01B Phase 3B (Licensing V2).
//
// ONE EVENT = ONE LICENSE. Every figure is derived from the V2 catalog VIEW
// (buildLicenseCatalogView) — the single source of truth for tier, registration limit,
// regular/offer price, features, and display order. No price, limit, tier name, or order
// is hardcoded here; only marketing taglines + which card is highlighted are added.

import type { PricingTier } from '@/lib/marketing/types'
import { isUnlimited, EVENT_LICENSE_TIERS_V2, type EventLicenseTierV2 } from '@/lib/licensing/eventLicense'

const isV2Tier = (t: string): t is EventLicenseTierV2 => (EVENT_LICENSE_TIERS_V2 as readonly string[]).includes(t)
import { buildLicenseCatalogView, type LicenseCatalogV2 } from '@/lib/licensing/licenseCatalogShared'

const inr = (paise: number): string => `₹${Math.round(paise / 100).toLocaleString('en-IN')}`
const lim = (n: number): string => (isUnlimited(n) ? 'Unlimited' : n.toLocaleString('en-IN'))

// Presentation only (tagline + which card is highlighted) — never figures. Keyed by the
// V2 tiers; the display order comes from the catalog view, not this map.
const TIER_PRESENTATION: Record<EventLicenseTierV2, { tagline: string; highlighted: boolean }> = {
  free:         { tagline: 'Everything you need to launch your first event.',      highlighted: false },
  starter:      { tagline: 'For growing organizers getting started.',              highlighted: false },
  professional: { tagline: 'Advanced tooling, API access, and white-label.',       highlighted: true  },
  business:     { tagline: 'For established organizers running large events.',      highlighted: false },
  enterprise:   { tagline: 'Unlimited scale, white-label, and dedicated support.',  highlighted: false },
}

// Build the pricing-page tiers from the EFFECTIVE V2 catalog (code defaults + config
// overrides). The caller resolves the catalog (server: getLicenseCatalogV2).
export function buildPricingTiers(catalog: LicenseCatalogV2): PricingTier[] {
  return buildLicenseCatalogView(catalog).map(v => {
    const p       = isV2Tier(v.tier) ? TIER_PRESENTATION[v.tier] : { tagline: '', highlighted: false }
    const isFree  = v.offerPricePaise === 0
    const hasDiscount = !isFree && v.regularPricePaise > v.offerPricePaise
    return {
      id:          v.tier,
      name:        v.name,
      priceLabel:  isFree ? 'Free' : inr(v.offerPricePaise),          // charged/offer price
      regularPriceLabel: hasDiscount ? inr(v.regularPricePaise) : null, // struck; null for ₹0 / no discount
      // One-time, per published event — never a recurring period.
      period:      isFree ? null : '/event',
      tagline:     p.tagline,
      highlighted: p.highlighted,
      ctaKey:      'startFree',
      features: [
        `${lim(v.registrationLimit)} registrations`,
        ...v.featureList,
        `${v.transactionFeePercent}% transaction fee`,
      ],
    }
  })
}
