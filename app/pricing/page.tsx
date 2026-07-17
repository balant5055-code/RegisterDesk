// Phase P.3 — /pricing page. Server Component (zero client JS).
//
// The full pricing page. Reads ONLY from the pricing registry (PRICING_TIERS,
// derived from lib/licensing/eventLicense.ts — the one source of truth) — no
// hardcoded prices. Reuses the platform hero/section/CTA components.

import type { Metadata } from 'next'
import Link from 'next/link'
import { Check } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { buttonVariants } from '@/components/ui/button'
import { getCta } from '@/lib/marketing/cta'
import { MarketingPageLayout } from '@/components/marketing/layout/MarketingPageLayout'
import { PlatformHero, PlatformSection, PlatformCTA } from '@/components/marketing/platform'
import { buildPricingTiers } from '@/content/marketing/pricing'
import { getLicenseCatalog } from '@/lib/licensing/resolveCatalog'
import { buildMetadata, organizationJsonLd, softwareAppJsonLd, breadcrumbJsonLd } from '@/lib/marketing/seo'

export const metadata: Metadata = buildMetadata({
  title:       'Pricing | RegisterDesk',
  description: 'One license per event — no subscriptions. Start free and pay once per event, with transparent transaction fees on every tier.',
  path:        '/pricing',
})

export default async function PricingPage() {
  const jsonLd = [
    organizationJsonLd(),
    softwareAppJsonLd(),
    breadcrumbJsonLd([{ name: 'Home', path: '/' }, { name: 'Pricing', path: '/pricing' }]),
  ]
  // Resolve the effective license catalog (defaults + config overrides) server-side.
  const PRICING_TIERS = buildPricingTiers(await getLicenseCatalog())

  return (
    <>
      <MarketingPageLayout>
        <PlatformHero
          hero={{
            eyebrow:      'Pricing',
            headline:     'One license per event — no subscriptions',
            subheadline:  'Start free, pay once per event, and pay transparent transaction fees on every tier.',
            primaryCta:   'startFree',
            secondaryCta: 'bookDemo',
          }}
        />

        <PlatformSection id="plans" eyebrow="Licenses" title="Choose your license" subtitle="Every license includes the core event platform and unlimited email." background="white">
          <ul className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">
            {PRICING_TIERS.map(tier => {
              const cta = getCta(tier.ctaKey)
              return (
                <li key={tier.id} className="flex">
                  <div className={cn(
                    'flex h-full flex-col rounded-2xl border bg-white p-6',
                    tier.highlighted ? 'border-primary/40 ring-1 ring-primary/20' : 'border-border/60',
                  )}>
                    <div className="flex items-center justify-between">
                      <h3 className="text-fs-lg font-semibold text-foreground">{tier.name}</h3>
                      {tier.highlighted && (
                        <span className="rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-primary-foreground" style={{ backgroundImage: 'var(--primary-gradient)' }}>
                          Popular
                        </span>
                      )}
                    </div>
                    <div className="mt-3 flex items-baseline gap-1">
                      <span className="text-[var(--fs-3xl)] font-bold text-foreground">{tier.priceLabel}</span>
                      {tier.period && <span className="text-[var(--fs-base)] text-muted-foreground">{tier.period}</span>}
                    </div>
                    <p className="mt-1 text-[var(--fs-sm)] text-muted-foreground">{tier.tagline}</p>
                    <ul className="mt-4 flex-1 space-y-2">
                      {tier.features.map((f, i) => (
                        <li key={i} className="flex items-start gap-2 text-[var(--fs-sm)] text-muted-foreground">
                          <Check className="mt-0.5 size-3.5 shrink-0 text-primary" aria-hidden />
                          {f}
                        </li>
                      ))}
                    </ul>
                    <Link
                      href={cta.href}
                      className={buttonVariants({ variant: cta.variant, size: 'md', className: 'mt-6 w-full justify-center' })}
                      style={cta.variant === 'gradient' ? { backgroundImage: 'var(--primary-gradient)' } : undefined}
                    >
                      {cta.label}
                    </Link>
                  </div>
                </li>
              )
            })}
          </ul>
        </PlatformSection>

        <PlatformCTA
          cta={{
            headline:     'Start free today.',
            subheadline:  'No credit card required to launch your first event.',
            primaryCta:   'startFree',
            secondaryCta: 'bookDemo',
          }}
        />
      </MarketingPageLayout>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
    </>
  )
}
