// Homepage Pricing Preview registry (PRESENTATION ONLY) — RD-LIC-01 freeze.
//
// This is a homepage preview — NOT the pricing page. It never duplicates figures:
// every price, period, limit, and feature is derived live from the single source
// of truth `lib/licensing/eventLicense.ts` (one-time per-event licenses). The
// registry below only chooses WHICH tiers to feature and supplies presentation
// (tagline, highlight, CTA key).

import { isUnlimited, type EventLicenseTierV2 } from '@/lib/licensing/eventLicense'
import {
  buildLicenseCatalogView, type LicenseCatalogV2, type LicenseCatalogEntryView,
} from '@/lib/licensing/licenseCatalogShared'
import type { CtaKey } from '@/lib/marketing/cta'

// Formatters (presentation only — the NUMBERS come from the V2 catalog view).
const inr = (paise: number): string => `₹${Math.round(paise / 100).toLocaleString('en-IN')}`
const lim = (n: number): string => (isUnlimited(n) ? 'Unlimited' : n.toLocaleString('en-IN'))

// Key highlights, derived from the view's real limit + feature matrix.
function highlights(v: LicenseCatalogEntryView): string[] {
  return [
    `${lim(v.registrationLimit)} registrations`,
    ...v.featureList.slice(0, 2),
    `${v.transactionFeePercent}% transaction fee`,
  ]
}

export interface PreviewPlanView {
  id:          EventLicenseTierV2
  name:        string
  priceLabel:  string          // charged / offer price
  regularPriceLabel: string | null   // struck; null for ₹0 / no discount
  period:      string | null
  tagline:     string
  highlighted: boolean
  ctaKey:      CtaKey
  highlights:  string[]
  href:        string
}

// Presentation selection only — which real V2 tiers the homepage features (a curated
// low / popular / high spread). Figures come from the catalog view, never from here.
interface PreviewConfig { id: EventLicenseTierV2; tagline: string; highlighted: boolean; ctaKey: CtaKey }

const PREVIEW_CONFIG: PreviewConfig[] = [
  { id: 'free',       tagline: 'For your first events.',      highlighted: false, ctaKey: 'startFree' },
  { id: 'business',   tagline: 'For growing teams.',          highlighted: true,  ctaKey: 'startFree' },
  { id: 'enterprise', tagline: 'For large-scale operations.', highlighted: false, ctaKey: 'startFree' },
]

// Build the homepage preview plans from the EFFECTIVE V2 catalog (code defaults + config
// overrides). The caller resolves the catalog (server: getLicenseCatalogV2).
export function buildPricingPreviewPlans(catalog: LicenseCatalogV2): PreviewPlanView[] {
  const byTier = new Map(buildLicenseCatalogView(catalog).map(v => [v.tier, v]))
  return PREVIEW_CONFIG.map(c => {
    const v       = byTier.get(c.id)!
    const isFree  = v.offerPricePaise === 0
    const hasDiscount = !isFree && v.regularPricePaise > v.offerPricePaise
    return {
      id: c.id,
      name: v.name,
      priceLabel: isFree ? 'Free' : inr(v.offerPricePaise),
      regularPriceLabel: hasDiscount ? inr(v.regularPricePaise) : null,
      period: isFree ? null : '/event',
      tagline: c.tagline,
      highlighted: c.highlighted,
      ctaKey: c.ctaKey,
      highlights: highlights(v),
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
