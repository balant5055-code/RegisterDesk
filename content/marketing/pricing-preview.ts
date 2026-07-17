// Homepage Pricing Preview registry (PRESENTATION ONLY) — RD-LIC-01 freeze.
//
// This is a homepage preview — NOT the pricing page. It never duplicates figures:
// every price, period, limit, and feature is derived live from the single source
// of truth `lib/licensing/eventLicense.ts` (one-time per-event licenses). The
// registry below only chooses WHICH tiers to feature and supplies presentation
// (tagline, highlight, CTA key).

import {
  isUnlimited,
  type EventLicenseTier,
  type EventLicenseDefinition,
} from '@/lib/licensing/eventLicense'
import type { CtaKey } from '@/lib/marketing/cta'

// Formatters (presentation only — the NUMBERS come from the license definition).
const inr = (paise: number): string => `₹${Math.round(paise / 100).toLocaleString('en-IN')}`
const lim = (n: number): string => (isUnlimited(n) ? 'Unlimited' : n.toLocaleString('en-IN'))

function priceLabel(def: EventLicenseDefinition): string {
  return def.licensePricePaise === 0 ? 'Free' : inr(def.licensePricePaise)
}

// One-time, per published event — never a recurring period.
function period(def: EventLicenseDefinition): string | null {
  return def.licensePricePaise === 0 ? null : '/event'
}

// Key highlights, derived from the license's real limit + feature matrix.
function highlights(def: EventLicenseDefinition): string[] {
  return [
    `${lim(def.limits.maxRegistrations)} registrations`,
    ...def.featureList.slice(0, 2),
    `${def.transactionFeePercent}% transaction fee`,
  ]
}

export interface PreviewPlanView {
  id:          EventLicenseTier
  name:        string
  priceLabel:  string
  period:      string | null
  tagline:     string
  highlighted: boolean
  ctaKey:      CtaKey
  highlights:  string[]
  href:        string
}

// Presentation selection only — which real license tiers the homepage features.
interface PreviewConfig { id: EventLicenseTier; tagline: string; highlighted: boolean; ctaKey: CtaKey }

const PREVIEW_CONFIG: PreviewConfig[] = [
  { id: 'starter',      tagline: 'For your first events.',      highlighted: false, ctaKey: 'startFree' },
  { id: 'professional', tagline: 'For growing teams.',          highlighted: true,  ctaKey: 'startFree' },
  { id: 'enterprise',   tagline: 'For large-scale operations.', highlighted: false, ctaKey: 'startFree' },
]

// Build the homepage preview plans from the EFFECTIVE license catalog (code
// defaults + config overrides). The caller resolves the catalog.
export function buildPricingPreviewPlans(catalog: Record<EventLicenseTier, EventLicenseDefinition>): PreviewPlanView[] {
  return PREVIEW_CONFIG.map(c => {
    const def = catalog[c.id]
    return {
      id: c.id,
      name: def.name,
      priceLabel: priceLabel(def),
      period: period(def),
      tagline: c.tagline,
      highlighted: c.highlighted,
      ctaKey: c.ctaKey,
      highlights: highlights(def),
      href: '/pricing',
    }
  })
}

export const PRICING_PREVIEW_HEADING = {
  eyebrow:  'Pricing',
  title:    'One license per event — no subscriptions',
  subtitle: 'Pay once per event and upgrade the tier as you grow — see the full breakdown on the pricing page.',
}

export const PRICING_PREVIEW_FOOTER = {
  text:      'Need advanced workflows?',
  linkLabel: 'See complete pricing',
  ctaKey:    'viewPricing' as CtaKey,
}
