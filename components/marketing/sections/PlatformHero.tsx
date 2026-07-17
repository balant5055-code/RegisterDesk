// Phase P.2.1 — /platform hero + philosophy. Server Components (zero client JS).
//
// Page-specific intro for the Platform landing page (distinct from the homepage
// Hero). Reuses the CTA registry, design-system button, marketing display type,
// section spacing, eyebrow token, and the ScreenshotFrame (placeholder — no fake
// screenshot). One <h1> (the platform hero). White-first, static.

import Link from 'next/link'
import { ArrowRight } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { buttonVariants } from '@/components/ui/button'
import { getCta } from '@/lib/marketing/cta'
import { marketingType } from '@/lib/marketing/theme'
import { Eyebrow } from '@/components/marketing/Eyebrow'
import { MarketingBreadcrumb } from '@/components/marketing/MarketingBreadcrumb'
import { SectionLayout } from '@/components/marketing/layout/SectionLayout'
import { SectionHeader } from '@/components/marketing/layout/SectionHeader'
import { ScreenshotFrame } from '@/components/marketing/screenshots/ScreenshotFrame'
import { getScreenshot } from '@/content/marketing/screenshots'
import { PLATFORM_HERO, PLATFORM_PHILOSOPHY } from '@/content/marketing/platform-page'

export function PlatformHero() {
  const primary   = getCta(PLATFORM_HERO.primaryCta)
  const secondary = getCta(PLATFORM_HERO.secondaryCta)
  const shot      = getScreenshot(PLATFORM_HERO.screenshotId)

  return (
    <section aria-labelledby="platform-hero-heading" className="relative overflow-hidden bg-white pt-8 pb-4 sm:pt-10 lg:pt-14">
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[420px] bg-[radial-gradient(60%_60%_at_50%_0%,rgba(229,39,126,0.07),transparent)]" />

      <div className="mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-3xl text-center">
          <MarketingBreadcrumb className="mb-4 justify-center" />
          <Eyebrow>{PLATFORM_HERO.eyebrow}</Eyebrow>
          <h1 id="platform-hero-heading" className={cn(marketingType.hero, 'mt-5 text-foreground')}>
            {PLATFORM_HERO.headline}
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-[var(--fs-lg)] leading-relaxed text-muted-foreground">
            {PLATFORM_HERO.subheadline}
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Link
              href={primary.href}
              className={buttonVariants({ variant: primary.variant, size: 'lg' })}
              style={primary.variant === 'gradient' ? { backgroundImage: 'var(--primary-gradient)' } : undefined}
            >
              {primary.label}
              <ArrowRight className="size-4" aria-hidden />
            </Link>
            <Link href={secondary.href} className={buttonVariants({ variant: secondary.variant, size: 'lg' })}>
              {secondary.label}
            </Link>
          </div>
        </div>

        {/* Product-focused composition — large framed dashboard floated on a soft brand backdrop. */}
        <div className="relative mx-auto mt-10 max-w-5xl">
          <div aria-hidden className="pointer-events-none absolute -inset-x-8 -top-8 bottom-0 -z-10 rounded-[2.5rem] bg-gradient-to-b from-primary/[0.06] to-transparent" />
          <ScreenshotFrame screenshot={shot} variant="dashboard" className="shadow-lg ring-1 ring-border/70" />
        </div>
      </div>
    </section>
  )
}

export function PlatformPhilosophy() {
  return (
    <SectionLayout background="muted" labelledBy="platform-philosophy-heading">
      <SectionHeader
        id="platform-philosophy-heading"
        eyebrow={PLATFORM_PHILOSOPHY.eyebrow}
        title={PLATFORM_PHILOSOPHY.title}
        align="center"
      />
      <div className="mx-auto mt-6 max-w-2xl space-y-4 text-center">
        {PLATFORM_PHILOSOPHY.body.map((para, i) => (
          <p key={i} className="text-[var(--fs-md)] leading-relaxed text-muted-foreground">{para}</p>
        ))}
      </div>
    </SectionLayout>
  )
}
