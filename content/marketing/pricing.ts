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
// Nothing here is hardcoded. The free allowance, the per-registration rate, the GST rate, the
// attendee transaction fee and the maximum all come from the effective commercial terms the
// server resolves, so the page cannot drift from what the checkout actually charges. The only
// things this file adds are taglines and which card is highlighted.

import type { PricingTier } from '@/lib/marketing/types'
import type { CommercialTerms } from '@/lib/licensing/capacityCommercial'
import { calculateActivationQuote, formatPaise } from '@/lib/licensing/capacityPricing'

const count = (n: number): string => n.toLocaleString('en-IN')

/** A percentage for display: 2.5 → "2.5", 18 → "18" (no trailing ".0"). */
const pct = (n: number): string => String(Number(n.toFixed(2)))

/**
 * The two commercial states, built from the EFFECTIVE terms.
 *
 * `features[0]` is always the capacity line and one entry always matches /transaction fee/ —
 * the page's card layout pulls those two out into their own blocks, so the ordering is part of
 * the contract rather than incidental.
 */
export function buildPricingPlans(terms: CommercialTerms): PricingTier[] {
  const free = terms.freeRegistrationCapacity
  const rate = formatPaise(terms.activationRatePaise)
  const fee  = `${pct(terms.attendeeTransactionFeePercent)}% transaction fee`

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

/**
 * A worked example, computed by the REAL pricing engine from the REAL terms.
 *
 * Included because a per-unit rate is genuinely harder to picture than a tier price: "₹1.50 per
 * registration" leaves a prospect doing arithmetic, and any arithmetic a marketing page invents
 * is arithmetic that can disagree with the invoice. Running the actual engine means this example
 * is the amount the organizer would really be charged, or it is nothing at all.
 */
export interface PricingExample {
  capacity:   string
  chargeable: string
  base:       string
  gstLabel:   string
  gst:        string
  total:      string
}

export function buildPricingExample(terms: CommercialTerms, capacity: number): PricingExample | null {
  const r = calculateActivationQuote({ capacity, terms })
  if (!r.ok) return null
  const q = r.quote
  return {
    capacity:   count(q.capacity),
    chargeable: count(q.chargeableCapacity),
    base:       formatPaise(q.basePaise),
    gstLabel:   `GST ${pct(q.gstRatePercent)}%`,
    gst:        formatPaise(q.gstPaise),
    total:      formatPaise(q.totalPaise),
  }
}
