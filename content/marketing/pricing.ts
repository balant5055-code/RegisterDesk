// Pricing content — RD-CAPACITY-02.
//
// ═══ WHAT CHANGED AND WHY ════════════════════════════════════════════════════
// This module used to build FIVE tier cards (Free / Starter / Professional / Business /
// Enterprise) from the V2 licence catalog, each with its own price, registration limit,
// feature list and transaction fee. RegisterDesk no longer sells any of that: there are two
// commercial states, no feature is held back by plan, and the cost is a function of
// registration capacity.
//
// The old builder was not merely out of date — it was actively misleading. A prospect read
// "Professional · ₹1,499 · 2,500 registrations · API access" and then met a capacity slider.
//
// ═══ EVERY FIGURE IS DERIVED ═════════════════════════════════════════════════
// Nothing here is hardcoded. The free allowance, the per-registration rate, the GST rate and the
// maximum come from the effective commercial terms; the RegisterDesk platform fee is the one the ticket
// checkout resolves (RD-PRICING-CALC: percent + fixed part + GST on the fee, via resolveFeeConfig —
// not the bare commercial percentage, which omitted the fixed part). Both arrive in the public
// pricing the server assembles (lib/licensing/publicPricingServer), so the page cannot drift from
// what the checkout actually charges. The only things this file adds are taglines and which card
// is highlighted.

import type { PricingTier } from '@/lib/marketing/types'
import type { CommercialTerms } from '@/lib/licensing/capacityCommercial'
import { formatPaise } from '@/lib/licensing/capacityPricing'
import { formatTicketFee, type PublicTicketFee } from '@/lib/licensing/publicPricing'

const count = (n: number): string => n.toLocaleString('en-IN')

/** A percentage for display: 2.5 → "2.5", 18 → "18" (no trailing ".0"). */
const pct = (n: number): string => String(Number(n.toFixed(2)))

/**
 * The platform-fee line's prefix — the card layout finds the line by it, and shows the text after it.
 * RD-FEE-02: "RegisterDesk platform fee", never "transaction fee" — the payment gateway's charge is a
 * separate charge by the payment provider and is not part of it.
 */
export const PLATFORM_FEE_PREFIX = 'RegisterDesk platform fee: '

/**
 * The two commercial states, built from the EFFECTIVE terms and the resolved ticket fee.
 *
 * `features[0]` is always the capacity line and one entry always starts with PLATFORM_FEE_PREFIX —
 * the page's card layout pulls those two out into their own blocks, so the ordering is part of
 * the contract rather than incidental.
 */
export function buildPricingPlans(terms: CommercialTerms, ticketFee: PublicTicketFee): PricingTier[] {
  const free = terms.freeRegistrationCapacity
  const rate = formatPaise(terms.activationRatePaise)
  const fee  = `${PLATFORM_FEE_PREFIX}${formatTicketFee(ticketFee)}`

  return [
    {
      id:          'free',
      name:        'Free',
      priceLabel:  'Free',
      period:      null,
      tagline:     `Run a real event at no cost, up to ${count(free)} registrations.`,
      highlighted: false,
      ctaKey:      'startFree',
      features: [
        `Up to ${count(free)} registrations`,
        'All available features — no feature plans',
        'No activation fee',
        'Unlimited email',
        fee,
      ],
    },
    {
      id:          'payg',
      name:        'Pay as you go',
      priceLabel:  rate,
      period:      '/registration',
      tagline:     `Only for capacity beyond the first ${count(free)}. Pay once, per event.`,
      highlighted: true,
      ctaKey:      'startFree',
      features: [
        `${count(free + 1)} – ${count(terms.maximumEventCapacity)} registrations`,
        'All available features — no feature plans',
        `${rate} per registration above the free ${count(free)}`,
        `GST ${pct(terms.gstRatePercent)}% applies to the activation fee`,
        'One-time activation — no subscription',
        fee,
      ],
    },
  ]
}
