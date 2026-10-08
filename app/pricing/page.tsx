// /pricing — Server Component, with ONE client island: the pricing calculator (RD-PRICING-CALC).
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
// highlighted plan); a quiet closing band. Every figure still comes from the effective terms and
// the real engine.
//
// RD-PRICING-CALC: the static "An event accepting 500 registrations" example is replaced by an
// interactive calculator, and EVERY figure on the page — the facts ribbon, both plan cards, the
// metadata description and the calculator — now comes from ONE call, getPublicPricing()
// (lib/licensing/publicPricingServer), over the same resolvers License & Services and the ticket
// checkout charge with. The page regenerates about once a minute (`revalidate`), so a Super Admin
// price change appears without a deploy. If pricing cannot be resolved the page shows an
// "unavailable" state — never the code defaults or an older figure.

import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowRight, Check, Layers3, ReceiptText, ShieldCheck, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { marketingButton } from '@/lib/marketing/theme'
import { getCta } from '@/lib/marketing/cta'
import { MarketingPageLayout } from '@/components/marketing/layout/MarketingPageLayout'
import { EditorialOverline } from '@/components/marketing/EditorialOverline'
import { buildPricingPlans, PLATFORM_FEE_PREFIX } from '@/content/marketing/pricing'
import { PricingCalculator, PRICING_UNAVAILABLE_MESSAGE } from '@/components/marketing/pricing/PricingCalculator'
import { getPublicPricing } from '@/lib/licensing/publicPricingServer'
import type { PublicPricingConfig } from '@/lib/licensing/publicPricing'
import { formatPaise } from '@/lib/licensing/capacityPricing'
import { MARKETING_CONTAINER } from '@/lib/marketing/layout'
import type { PricingTier } from '@/lib/marketing/types'
import { buildMetadata, organizationJsonLd, softwareAppJsonLd, breadcrumbJsonLd } from '@/lib/marketing/seo'
import { PAGE_TITLE } from '@/lib/marketing/pageTitle'

/**
 * Regenerate the page about once a minute — the same freshness as the public pricing endpoint's
 * shared cache — so a configuration change reaches the plan cards and facts without a deploy,
 * while visitors are still served a static page (no Firestore read per view).
 */
export const revalidate = 60

/** The description names the CONFIGURED free allowance — or no number at all if pricing is unavailable. */
export async function generateMetadata(): Promise<Metadata> {
  const pricing = await getPublicPricing()
  const lead = pricing
    ? `Start free up to ${pricing.terms.freeRegistrationCapacity.toLocaleString('en-IN')} registrations. Above that, pay once per event`
    : 'Pay once per event'
  return buildMetadata({
    title:       'Pricing | RegisterDesk',
    description: `${lead} for the capacity you need — no feature plans, no subscriptions.`,
    path:        '/pricing',
  })
}

/** Squared, a touch taller than the default lg — the editorial action size. */
const ACTION = 'h-12 rounded-[var(--radius-control)] px-6'
const OUTLINED = 'border-hero-ink/25 bg-transparent text-hero-ink shadow-none hover:border-action hover:bg-transparent hover:text-action'

/**
 * The ribbon under the title. The first two are fixed product statements (no figure); the third
 * is configuration and is built from the live pricing, or says it is unavailable — never a default.
 */
function heroFacts(pricing: PublicPricingConfig | null): { icon: LucideIcon; label: string; value: string }[] {
  const t = pricing?.terms
  return [
    { icon: Layers3,     label: 'Model',    value: 'Pay once per event, for capacity' },
    { icon: ShieldCheck, label: 'Included', value: 'Same features on every event' },
    { icon: ReceiptText, label: 'Free',     value: t
        ? `First ${t.freeRegistrationCapacity.toLocaleString('en-IN')} registrations, then ${formatPaise(t.activationRatePaise)} each`
        : 'Current pricing is temporarily unavailable' },
  ]
}

function splitTierFeatures(features: string[]) {
  const registrationFeature = features[0]
  const platformFeeFeature = features.find(feature => feature.startsWith(PLATFORM_FEE_PREFIX)) ?? features[features.length - 1]
  const capabilityFeatures = features.filter(feature => feature !== registrationFeature && feature !== platformFeeFeature)
  return { registrationFeature, platformFeeFeature, capabilityFeatures }
}

/**
 * One plan. The highlighted plan is set on the hero ink — the page's one dark object — with
 * the bronze accent and the gradient action; the other is a hairline card on the page ground.
 * Same data either way: name, tagline, price, capacity, what is included, the fee, the CTA.
 */
function PricingCard({ tier, index }: { tier: PricingTier; index: number }) {
  const cta = getCta(tier.ctaKey)
  const { registrationFeature, platformFeeFeature, capabilityFeatures } = splitTierFeatures(tier.features)
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
            {/* RD-FEE-02 — RegisterDesk's fee only; the payment gateway charges separately. */}
            <dt className={label}>RegisterDesk platform fee</dt>
            <dd className={cn('mt-1 text-fs-sm font-semibold leading-snug', ink)}>{platformFeeFeature.replace(PLATFORM_FEE_PREFIX, '')}</dd>
            <dd className={cn('mt-1 text-fs-2xs leading-snug', soft)}>Payment gateway charges are separate.</dd>
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

export default async function PricingPage() {
  const jsonLd = [
    organizationJsonLd(),
    softwareAppJsonLd(),
    breadcrumbJsonLd([{ name: 'Home', path: '/' }, { name: 'Pricing', path: '/pricing' }]),
  ]
  // RD-PRICING-CALC · ONE snapshot of the public pricing for the whole render — facts, cards and
  // calculator all read it, so they cannot disagree. Null ⇒ the configuration could not be
  // resolved: every figure is withheld (fail closed), never replaced by a default.
  const pricing = await getPublicPricing()
  const PRICING_TIERS = pricing ? buildPricingPlans(pricing.terms, pricing.ticketFee) : []
  const HERO_FACTS = heroFacts(pricing)
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

            {pricing ? (
              <ul className="mx-auto mt-8 grid max-w-5xl gap-5 md:grid-cols-2">
                {PRICING_TIERS.map((tier, index) => (
                  <PricingCard key={tier.id} tier={tier} index={index} />
                ))}
              </ul>
            ) : (
              <div role="status" className="mx-auto mt-8 max-w-5xl rounded-[var(--radius-panel)] border border-border/70 bg-card px-6 py-10 text-center text-fs-sm text-hero-ink">
                {PRICING_UNAVAILABLE_MESSAGE}
              </div>
            )}

            {/* RD-PRICING-CALC · the interactive estimate. Every figure is computed in the browser
                from the server's pricing configuration by the License & Services pricing
                functions; this page passes only the call to action. */}
            <section aria-labelledby="pricing-calculator-heading" className="mx-auto mt-12 max-w-2xl rounded-[var(--radius-panel)] border border-border/70 bg-card p-6 sm:p-8">
              <div className="text-center">
                <EditorialOverline>Plan your event</EditorialOverline>
                <h2 id="pricing-calculator-heading" className="mt-3 font-display text-fs-xl font-light text-hero-ink sm:text-fs-2xl">
                  Estimate what your event will cost
                </h2>
                <p className="mt-2 text-fs-sm text-hero-ink-soft">Adjust the services you expect to use.</p>
              </div>
              <div className="mt-4">
                <PricingCalculator ctaHref={startFree.href} ctaLabel="Start your event" initialPricing={pricing} />
              </div>
            </section>
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
