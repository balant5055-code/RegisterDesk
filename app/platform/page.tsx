// Phase P.2.1 / IA refactor — /platform overview. Server Component.
//
// Subpage rule: this page contains ONLY platform-specific content — it does NOT
// reuse homepage marketing sections (Platform Overview, Organizer Workspace,
// Integrations, Security, Final CTA). Those live ONLY on the homepage (/).
// Here: page-specific hero + philosophy + a module directory (driven by the
// navigation registry) + a small page CTA. SEO / metadata / routing unchanged.

import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowRight } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { MarketingPageLayout } from '@/components/marketing/layout/MarketingPageLayout'
import { PlatformHero, PlatformPhilosophy } from '@/components/marketing/sections/PlatformHero'
import { PlatformSection } from '@/components/marketing/platform/PlatformSection'
import { buttonVariants } from '@/components/ui/button'
import { PRIMARY_NAV } from '@/content/marketing/navigation'
import { MARKETING_ICONS } from '@/lib/marketing/icons'
import { getCta } from '@/lib/marketing/cta'
import { SECTION_SPACING, MARKETING_CONTAINER } from '@/lib/marketing/layout'
import { buildMetadata, organizationJsonLd, softwareAppJsonLd, breadcrumbJsonLd } from '@/lib/marketing/seo'

// Page-specific module directory, sourced from the navigation registry (the
// approved Platform IA) — not a homepage section.
const PLATFORM_MODULES = PRIMARY_NAV.find(m => m.id === 'platform')?.groups?.flatMap(g => g.items) ?? []

export const metadata: Metadata = buildMetadata({
  title:       'Platform | RegisterDesk',
  description: 'RegisterDesk is one integrated event operations platform — registration, payments, identifiers, check-in, certificates, and settlements, all connected.',
  path:        '/platform',
})

export default function PlatformPage() {
  const jsonLd = [
    organizationJsonLd(),
    softwareAppJsonLd(),
    breadcrumbJsonLd([{ name: 'Home', path: '/' }, { name: 'Platform', path: '/platform' }]),
  ]

  const startFree = getCta('startFree')
  const bookDemo  = getCta('bookDemo')

  return (
    <>
      <MarketingPageLayout>
        <PlatformHero />
        <PlatformPhilosophy />

        <PlatformSection
          id="modules"
          eyebrow="The platform"
          title="One connected operating system"
          subtitle="Every capability shares the same data — an event flows from registration through to certificates and settlement, with no exports or re-keying between steps."
          background="white"
        >
          <ol className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {PLATFORM_MODULES.map((item, idx) => {
              const Icon = item.iconKey ? MARKETING_ICONS[item.iconKey] : null
              return (
                <li key={item.id} className="flex">
                  <Link
                    href={item.href}
                    className="group flex h-full flex-col rounded-2xl border border-border/60 bg-white p-6 shadow-sm transition-colors hover:border-primary/40 hover:bg-muted/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                  >
                    <div className="flex items-center justify-between">
                      {Icon && (
                        <span className="flex size-11 items-center justify-center rounded-xl bg-primary/10 ring-1 ring-inset ring-primary/20">
                          <Icon className="size-5 text-primary" aria-hidden />
                        </span>
                      )}
                      <span className="text-[var(--fs-xs)] font-semibold tabular-nums text-muted-foreground/40">{String(idx + 1).padStart(2, '0')}</span>
                    </div>
                    <h3 className="mt-5 text-[var(--fs-md)] font-semibold text-foreground">{item.title}</h3>
                    {item.description && <p className="mt-2 flex-1 text-[var(--fs-base)] leading-relaxed text-muted-foreground">{item.description}</p>}
                    <span className="mt-4 inline-flex items-center gap-1 text-[var(--fs-sm)] font-medium text-primary">
                      Explore <ArrowRight className="size-3 transition-transform group-hover:translate-x-0.5" aria-hidden />
                    </span>
                  </Link>
                </li>
              )
            })}
          </ol>
        </PlatformSection>

        {/* Premium final conversion section — bespoke to /platform (does not alter the shared PlatformCTA). */}
        <section aria-labelledby="platform-cta-heading" className={cn('bg-white', SECTION_SPACING.default)}>
          <div className={cn(MARKETING_CONTAINER.page, 'rd-reveal')}>
            <div className="relative overflow-hidden rounded-3xl border border-border/60 bg-muted/30 px-6 py-14 text-center sm:px-12">
              <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-40 bg-[radial-gradient(60%_120%_at_50%_0%,rgb(var(--primary-rgb)_/_0.06),transparent)]" />
              <h2 id="platform-cta-heading" className="mx-auto max-w-2xl text-[var(--fs-2xl)] font-bold tracking-tight text-foreground sm:text-[var(--fs-3xl)]">
                Run every event from one platform
              </h2>
              <p className="mx-auto mt-4 max-w-xl text-[var(--fs-md)] leading-relaxed text-muted-foreground">
                Start free and explore the whole platform.
              </p>
              <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
                <Link
                  href={startFree.href}
                  className={buttonVariants({ variant: startFree.variant, size: 'lg' })}
                  style={startFree.variant === 'gradient' ? { backgroundImage: 'var(--primary-gradient)' } : undefined}
                >
                  {startFree.label}
                  <ArrowRight className="size-4" aria-hidden />
                </Link>
                <Link href={bookDemo.href} className={buttonVariants({ variant: bookDemo.variant, size: 'lg' })}>
                  {bookDemo.label}
                </Link>
              </div>
            </div>
          </div>
        </section>
      </MarketingPageLayout>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
    </>
  )
}
