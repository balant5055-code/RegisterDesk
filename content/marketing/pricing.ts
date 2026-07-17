// Pricing content — RD-LIC-01 production freeze.
//
// ONE EVENT = ONE LICENSE. No subscriptions, no monthly plans. Every figure is
// derived from the single source of truth `lib/licensing/eventLicense.ts` (price,
// registration limit, feature matrix). Only marketing taglines are added here;
// no price, limit, or feature string is hardcoded or fabricated.

import type { PricingTier } from '@/lib/marketing/types'
import {
  EVENT_LICENSE_TIERS,
  isUnlimited,
  type EventLicenseTier,
  type EventLicenseDefinition,
} from '@/lib/licensing/eventLicense'

const inr = (paise: number): string => `₹${Math.round(paise / 100).toLocaleString('en-IN')}`
const lim = (n: number): string => (isUnlimited(n) ? 'Unlimited' : n.toLocaleString('en-IN'))

// Presentation only (tagline + which card is highlighted) — never figures.
const TIER_PRESENTATION: Record<EventLicenseTier, { tagline: string; highlighted: boolean }> = {
  starter:      { tagline: 'Everything you need to run your first event.',        highlighted: false },
  growth:       { tagline: 'For growing organizers and teams.',                   highlighted: true  },
  professional: { tagline: 'Advanced tooling, API access, and white-label.',      highlighted: false },
  enterprise:   { tagline: 'Unlimited scale, white-label, and dedicated support.', highlighted: false },
}

// Build the pricing-page tiers from the EFFECTIVE license catalog (code defaults +
// config overrides). The caller resolves the catalog (server: getLicenseCatalog).
export function buildPricingTiers(catalog: Record<EventLicenseTier, EventLicenseDefinition>): PricingTier[] {
  return EVENT_LICENSE_TIERS.map(tier => {
    const def = catalog[tier]
    const p   = TIER_PRESENTATION[tier]
    return {
      id:          tier,
      name:        def.name,
      priceLabel:  def.licensePricePaise === 0 ? 'Free' : inr(def.licensePricePaise),
      // One-time, per published event — never a recurring period.
      period:      def.licensePricePaise === 0 ? null : '/event',
      tagline:     p.tagline,
      highlighted: p.highlighted,
      ctaKey:      'startFree',
      features: [
        `${lim(def.limits.maxRegistrations)} registrations`,
        ...def.featureList,
        `${def.transactionFeePercent}% transaction fee`,
      ],
    }
  })
}
