// Phase P.1.6.9 — Homepage Pricing Preview. Server Component (zero client JS).
//
// A concise preview — NOT the pricing page, and no comparison table. All pricing
// is derived from lib/billing/plans.ts via the presentation-only registry
// (pricing-preview.ts) — no hardcoded prices, no duplication. White-first,
// static. Reusable parts (PricingPreview · PricingCard · PricingHighlights ·
// PricingFooter) are exported individually.

import Link from 'next/link'
import { ArrowRight, Check } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { buttonVariants } from '@/components/ui/button'
import { getCta } from '@/lib/marketing/cta'
import { SectionLayout } from '@/components/marketing/layout/SectionLayout'
import { SectionHeader } from '@/components/marketing/layout/SectionHeader'
import {
  buildPricingPreviewPlans, PRICING_PREVIEW_HEADING, PRICING_PREVIEW_FOOTER,
  type PreviewPlanView,
} from '@/content/marketing/pricing-preview'
import { getLicenseCatalog } from '@/lib/licensing/resolveCatalog'

export function PricingHighlights({ highlights }: { highlights: string[] }) {
  return (
    <ul className="mt-4 space-y-2">
      {highlights.map((h, i) => (
        <li key={i} className="flex items-start gap-2 text-[var(--fs-sm)] text-muted-foreground">
          <Check className="mt-0.5 size-3.5 shrink-0 text-primary" aria-hidden />
          {h}
        </li>
      ))}
    </ul>
  )
}

export function PricingCard({ plan }: { plan: PreviewPlanView }) {
  const cta = getCta(plan.ctaKey)
  return (
    <div className={cn(
      'flex h-full flex-col rounded-2xl border bg-white p-6',
      plan.highlighted ? 'border-primary/40 ring-1 ring-primary/20' : 'border-border/60',
    )}>
      <div className="flex items-center justify-between">
        <h3 className="text-fs-lg font-semibold text-foreground">{plan.name}</h3>
        {plan.highlighted && (
          <span className="rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-primary-foreground" style={{ backgroundImage: 'var(--primary-gradient)' }}>
            Popular
          </span>
        )}
      </div>

      <div className="mt-3 flex items-baseline gap-1">
        <span className="text-[var(--fs-3xl)] font-bold text-foreground">{plan.priceLabel}</span>
        {plan.period && <span className="text-[var(--fs-base)] text-muted-foreground">{plan.period}</span>}
      </div>
      <p className="mt-1 text-[var(--fs-sm)] text-muted-foreground">{plan.tagline}</p>

      <PricingHighlights highlights={plan.highlights} />

      <div className="mt-auto space-y-3 pt-6">
        <Link
          href={cta.href}
          className={buttonVariants({ variant: cta.variant, size: 'md', className: 'w-full justify-center' })}
          style={cta.variant === 'gradient' ? { backgroundImage: 'var(--primary-gradient)' } : undefined}
        >
          {cta.label}
        </Link>
        <Link
          href={plan.href}
          className="block rounded text-center text-[var(--fs-sm)] font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          Learn more
        </Link>
      </div>
    </div>
  )
}

export function PricingFooter() {
  const cta = getCta(PRICING_PREVIEW_FOOTER.ctaKey)
  return (
    <div className="mt-10 flex flex-col items-center justify-center gap-2 text-center sm:flex-row">
      <span className="text-[var(--fs-base)] text-muted-foreground">{PRICING_PREVIEW_FOOTER.text}</span>
      <Link
        href={cta.href}
        className="inline-flex items-center gap-1 rounded text-[var(--fs-base)] font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        {PRICING_PREVIEW_FOOTER.linkLabel} <ArrowRight className="size-4" aria-hidden />
      </Link>
    </div>
  )
}

export async function PricingPreview() {
  // Resolve the effective license catalog (defaults + config overrides) server-side.
  const plans = buildPricingPreviewPlans(await getLicenseCatalog())
  return (
    <SectionLayout background="white" labelledBy="pricing-heading">
      <SectionHeader
        id="pricing-heading"
        eyebrow={PRICING_PREVIEW_HEADING.eyebrow}
        title={PRICING_PREVIEW_HEADING.title}
        subtitle={PRICING_PREVIEW_HEADING.subtitle}
        align="center"
      />
      <ul className="mt-12 grid gap-6 md:grid-cols-3">
        {plans.map(plan => (
          <li key={plan.id} className="flex"><PricingCard plan={plan} /></li>
        ))}
      </ul>
      <PricingFooter />
    </SectionLayout>
  )
}
