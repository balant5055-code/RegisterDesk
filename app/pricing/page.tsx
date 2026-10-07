// /pricing — Server Component (zero client JS).
//
// RD-CAPACITY-02 · rebuilt for the capacity-based commercial model. There are TWO commercial
// states — Free up to the configured free capacity, and Pay as you go above it — and every
// organizer gets every feature. The five tier cards this page used to render (Starter /
// Professional / Business / Enterprise) described a product RegisterDesk no longer sells, and a
// prospect who read a tier price here then met a capacity slider in the builder.
//
// Presentation only: every figure comes from the effective commercial terms the server resolves,
// and the worked example is computed by the real pricing engine — so this page cannot quote a
// number the checkout would not charge.
//
// 2026-09-25 LUXURY PASS (owner): a centred editorial masthead with the three facts as a
// ledger; the two plans as a hairline card beside ONE dark card on the hero ink (the
// highlighted plan); the worked example set as an invoice with dotted leaders; a quiet
// closing band. Every figure still comes from the effective terms and the real engine.

import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowRight, Check, Layers3, ReceiptText, ShieldCheck, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { marketingButton } from '@/lib/marketing/theme'
import { getCta } from '@/lib/marketing/cta'
import { MarketingPageLayout } from '@/components/marketing/layout/MarketingPageLayout'
import { EditorialOverline } from '@/components/marketing/EditorialOverline'
import { buildPricingPlans, buildPricingExample } from '@/content/marketing/pricing'
import { getDisplayCommercialTerms } from '@/lib/licensing/resolveCommercialTerms'
import { formatPaise } from '@/lib/licensing/capacityPricing'
import { MARKETING_CONTAINER } from '@/lib/marketing/layout'
import type { PricingTier } from '@/lib/marketing/types'
import { buildMetadata, organizationJsonLd, softwareAppJsonLd, breadcrumbJsonLd } from '@/lib/marketing/seo'
import { PAGE_TITLE } from '@/lib/marketing/pageTitle'

export const metadata: Metadata = buildMetadata({
  title:       'Pricing | RegisterDesk',
  description: 'Start free up to 100 registrations. Above that, pay once per event for the capacity you need — no feature plans, no subscriptions.',
  path:        '/pricing',
})

/** Squared, a touch taller than the default lg — the editorial action size. */
const ACTION = 'h-12 rounded-[var(--radius-control)] px-6'
const OUTLINED = 'border-hero-ink/25 bg-transparent text-hero-ink shadow-none hover:border-action hover:bg-transparent hover:text-action'

function heroFacts(freeCapacity: string, rate: string): { icon: LucideIcon; label: string; value: string }[] {
  return [
    { icon: Layers3,     label: 'Model',    value: 'Pay once per event, for capacity' },
    { icon: ShieldCheck, label: 'Included', value: 'Same features on every event' },
    { icon: ReceiptText, label: 'Free',     value: `First ${freeCapacity} registrations, then ${rate} each` },
  ]
}

function splitTierFeatures(features: string[]) {
  const registrationFeature = features[0]
  const transactionFeature = features.find(feature => /transaction fee/i.test(feature)) ?? features[features.length - 1]
  const capabilityFeatures = features.filter(feature => feature !== registrationFeature && feature !== transactionFeature)
  return { registrationFeature, transactionFeature, capabilityFeatures }
}

/**
 * One plan. The highlighted plan is set on the hero ink — the page's one dark object — with
 * the bronze accent and the gradient action; the other is a hairline card on the page ground.
 * Same data either way: name, tagline, price, capacity, what is included, the fee, the CTA.
 */
function PricingCard({ tier, index }: { tier: PricingTier; index: number }) {
  const cta = getCta(tier.ctaKey)
  const { registrationFeature, transactionFeature, capabilityFeatures } = splitTierFeatures(tier.features)
  const dark = !!tier.highlighted

  const ink      = dark ? 'text-ink-on-media' : 'text-hero-ink'
  const soft     = dark ? 'text-ink-on-media-muted' : 'text-hero-ink-soft'
  const label    = cn('text-fs-2xs font-semibold uppercase tracking-[0.14em]', dark ? 'text-ink-on-media-muted' : 'text-hero-eyebrow')
  const hairline = dark ? 'border-ink-on-media/15' : 'border-border/70'

  // 2026-09-25 compact pass (owner: "looks bulky"): the name and the price share one row,
  // capacity and fee are a two-cell fact strip, and the inclusions are a two-column list.
  return (
    <li className="flex min-w-0">
      <article
        className={cn(
          'relative flex h-full w-full flex-col overflow-hidden rounded-[var(--radius-panel)] border p-5 sm:p-6',
          dark ? 'border-hero-ink bg-hero-ink' : 'border-border/70 bg-card',
        )}
      >
        {/* index · plan label, and the badge */}
        <div className="flex items-center justify-between gap-3">
          <p className={cn('flex items-center gap-2.5 text-fs-2xs font-semibold uppercase tracking-[0.22em]', dark ? 'text-hero-accent-rule' : 'text-hero-eyebrow')}>
            <span aria-hidden className="h-px w-5 bg-hero-accent-rule" />
            {String(index + 1).padStart(2, '0')} · {index === 0 ? 'Free' : 'Pay as you go'}
          </p>
          {tier.highlighted && (
            <span className="shrink-0 border border-hero-accent-rule/60 px-2 py-0.5 text-fs-2xs font-semibold uppercase tracking-[0.16em] text-hero-accent-rule">
              Popular
            </span>
          )}
        </div>

        {/* the name and the price, on one row */}
        <div className="mt-3 flex items-end justify-between gap-4">
          <div className="min-w-0">
            <h3 className={cn('font-display text-fs-2xl font-light tracking-[-0.01em]', ink)}>{tier.name}</h3>
            <p className={cn('mt-1 text-fs-sm leading-snug', soft)}>{tier.tagline}</p>
          </div>
          <div className="shrink-0 text-right">
            {tier.regularPriceLabel && (
              <span className={cn('block text-fs-sm font-semibold line-through', soft)}>{tier.regularPriceLabel}</span>
            )}
            <span className={cn('block text-fs-3xl font-semibold leading-none tabular-nums tracking-[-0.04em]', ink)}>
              {tier.priceLabel}
            </span>
            {tier.period && <span className={cn('mt-1 block text-fs-xs font-semibold', soft)}>{tier.period}</span>}
          </div>
        </div>

        {/* capacity · fee */}
        <dl className={cn('mt-4 grid grid-cols-2 border-y', hairline, dark ? 'divide-x divide-ink-on-media/15' : 'divide-x divide-border/70')}>
          <div className="py-3 pr-3">
            <dt className={label}>Capacity</dt>
            <dd className={cn('mt-1 text-fs-sm font-semibold leading-snug', ink)}>{registrationFeature}</dd>
          </div>
          <div className="py-3 pl-3">
            <dt className={label}>Transaction fee</dt>
            <dd className={cn('mt-1 text-fs-sm font-semibold leading-snug', ink)}>{transactionFeature}</dd>
          </div>
        </dl>

        {/* what is included — two columns from sm */}
        <div className="mt-4 flex-1">
          <p className={label}>Included</p>
          <ul className="mt-2.5 grid gap-x-4 gap-y-2 sm:grid-cols-2">
            {capabilityFeatures.map((feature, featureIndex) => (
              <li key={featureIndex} className={cn('flex items-start gap-2 text-fs-sm leading-snug', soft)}>
                <Check className="mt-0.5 size-3.5 shrink-0 text-hero-accent-rule" strokeWidth={2.25} aria-hidden />
                <span>{feature}</span>
              </li>
            ))}
          </ul>
        </div>

        <Link
          href={cta.href}
          className={cn(
            marketingButton({ variant: tier.highlighted ? 'primary' : cta.variant, size: 'md' }),
            'mt-5 h-11 w-full justify-center gap-2 rounded-[var(--radius-control)]',
            !dark && cn('border', OUTLINED),
          )}
          style={tier.highlighted || cta.variant === 'gradient' ? { backgroundImage: 'var(--action-gradient)' } : undefined}
        >
          {cta.label}
          <ArrowRight className="size-4" aria-hidden />
        </Link>
      </article>
    </li>
  )
}

/** One line of the worked example, set as an invoice line with a dotted leader. */
function ExampleRow({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline gap-3 py-2.5">
      <dt className={cn('shrink-0', strong ? 'text-fs-md font-semibold text-hero-ink' : 'text-fs-sm text-hero-ink-soft')}>{label}</dt>
      <span aria-hidden className="mb-1 min-w-4 flex-1 border-b border-dotted border-border-strong" />
      <dd className={cn('shrink-0 tabular-nums', strong ? 'text-fs-xl font-semibold text-hero-ink' : 'text-fs-md font-semibold text-hero-ink')}>{value}</dd>
    </div>
  )
}

export default async function PricingPage() {
  const jsonLd = [
    organizationJsonLd(),
    softwareAppJsonLd(),
    breadcrumbJsonLd([{ name: 'Home', path: '/' }, { name: 'Pricing', path: '/pricing' }]),
  ]
  // The EFFECTIVE terms — global defaults overlaid with any admin configuration. The same
  // resolver the activation quote uses, so the page and the checkout cannot disagree.
  // RD-EVENT-COMMERCE-04A — display only; charging paths fail closed on a corrupt config.
  const terms = await getDisplayCommercialTerms()
  const PRICING_TIERS = buildPricingPlans(terms)
  // Priced by the real engine. `null` if the configured maximum ever fell below it, in which
  // case the example is simply omitted rather than invented.
  const example = buildPricingExample(terms, Math.min(500, terms.maximumEventCapacity))
  const freeCapacityLabel = terms.freeRegistrationCapacity.toLocaleString('en-IN')
  const rateLabel = formatPaise(terms.activationRatePaise)
  const HERO_FACTS = heroFacts(freeCapacityLabel, rateLabel)
  const startFree = getCta('startFree')
  const bookDemo = getCta('bookDemo')

  return (
    <>
      <MarketingPageLayout>
        {/* ══ 2 · THE PLANS — a hairline card beside the one dark card ══ */}
        <section id="plans" aria-labelledby="pricing-plans-heading" className="bg-background">
          <div className={cn(MARKETING_CONTAINER.page, 'pb-12 pt-10 sm:pb-16 sm:pt-14')}>
            {/* 2026-09-25 (owner): the separate hero is gone — the page opens on the plans.
                Their heading is the page's one <h1>, and the three facts sit directly under it
                as one ribbon: the terms first, then the two ways to buy them. */}
            <div className="mx-auto max-w-2xl text-center">
              <EditorialOverline>Pricing</EditorialOverline>
              <h1 id="pricing-plans-heading" className={`mt-4 ${PAGE_TITLE}`}>
                Two ways to run an event
              </h1>
              <span aria-hidden className="mx-auto mt-4 block h-px w-10 bg-hero-accent-rule" />
              <p className="mt-4 text-fs-base leading-relaxed text-hero-ink-soft sm:text-fs-md">
                There are no feature tiers. The only choice is how many registrations you want to accept.
              </p>
            </div>

            <dl className="mx-auto mt-8 grid max-w-5xl overflow-hidden rounded-[var(--radius-panel)] border border-hero-accent-rule/30 bg-hero-accent-rule/[0.04] sm:grid-cols-3 sm:divide-x sm:divide-hero-accent-rule/25 max-sm:divide-y max-sm:divide-hero-accent-rule/20">
              {HERO_FACTS.map(item => (
                <div key={item.label} className="flex items-center gap-4 px-5 py-4 sm:px-6 sm:py-5">
                  <span aria-hidden className="inline-flex size-11 shrink-0 items-center justify-center rounded-[var(--radius-control)] border border-hero-accent-rule/40 bg-card text-hero-accent-rule">
                    <item.icon className="size-5" strokeWidth={1.5} />
                  </span>
                  <div className="min-w-0">
                    <dt className="text-fs-2xs font-semibold uppercase tracking-[0.16em] text-hero-accent-rule">{item.label}</dt>
                    <dd className="mt-1 text-fs-sm font-semibold leading-snug text-hero-ink sm:text-fs-md">{item.value}</dd>
                  </div>
                </div>
              ))}
            </dl>

            <ul className="mx-auto mt-8 grid max-w-5xl gap-5 md:grid-cols-2">
              {PRICING_TIERS.map((tier, index) => (
                <PricingCard key={tier.id} tier={tier} index={index} />
              ))}
            </ul>

            {/* A worked example, priced by the real engine. A per-unit rate is harder to picture
                than a tier price, and any arithmetic this page invented could disagree with the
                invoice — so the figures below are the ones the organizer would actually pay.
                Set as an invoice: dotted leaders, the total ruled off. */}
            {example && (
              <div className="mx-auto mt-12 max-w-2xl rounded-[var(--radius-panel)] border border-border/70 bg-card p-6 sm:p-8">
                <div className="text-center">
                  <EditorialOverline>For example</EditorialOverline>
                  <p className="mt-3 font-display text-fs-xl font-light text-hero-ink sm:text-fs-2xl">
                    An event accepting {example.capacity} registrations
                  </p>
                </div>
                <dl className="mt-6">
                  <ExampleRow label="Free capacity" value={freeCapacityLabel} />
                  <ExampleRow label="Chargeable capacity" value={example.chargeable} />
                  <ExampleRow label="Activation fee" value={example.base} />
                  <ExampleRow label={example.gstLabel} value={example.gst} />
                  <div className="mt-2 border-t-2 border-hero-ink pt-2">
                    <ExampleRow label="Total, one-time" value={example.total} strong />
                  </div>
                </dl>
              </div>
            )}
          </div>
        </section>

        {/* ══ 3 · THE CLOSE — the same quiet band the page opened on ══ */}
        <section aria-labelledby="pricing-cta-heading" className="border-t border-border/60 bg-surface-3/40">
          <div className={cn(MARKETING_CONTAINER.page, 'py-12 text-center sm:py-16')}>
            <EditorialOverline>Get started</EditorialOverline>
            <h2 id="pricing-cta-heading" className="mt-4 font-display text-fs-3xl font-light tracking-[-0.015em] text-hero-ink sm:text-fs-display-sm">
              Start free today.
            </h2>
            <p className="mx-auto mt-3 max-w-xl text-fs-base leading-relaxed text-hero-ink-soft">
              No credit card required to launch your first event.
            </p>
            <div className="mt-8 flex flex-col items-stretch justify-center gap-3 sm:flex-row sm:items-center">
              <Link
                href={startFree.href}
                className={cn(marketingButton({ variant: startFree.variant, size: 'lg' }), ACTION)}
                style={startFree.variant === 'gradient' ? { backgroundImage: 'var(--action-gradient)' } : undefined}
              >
                {startFree.label}
                <ArrowRight className="size-4" aria-hidden />
              </Link>
              <Link href={bookDemo.href} className={cn(marketingButton({ variant: bookDemo.variant, size: 'lg' }), ACTION, OUTLINED)}>
                {bookDemo.label}
              </Link>
            </div>
          </div>
        </section>
      </MarketingPageLayout>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
    </>
  )
}
