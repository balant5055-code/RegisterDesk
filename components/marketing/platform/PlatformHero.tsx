// Phase P.2 (UX redesign) — Platform hero. Server Component (zero client JS).
//
// Premium product-page hero: pill eyebrow, large display headline, the page's
// single <h1>, prominent CTAs, and a large framed product screenshot sitting on a
// soft brand backdrop. Reuses the CTA registry, button variants, display type,
// and ScreenshotFrame (placeholder — never a fake screenshot). No animation.

import Link from 'next/link'
import { ArrowRight } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { buttonVariants } from '@/components/ui/button'
import { getCta } from '@/lib/marketing/cta'
import { marketingType } from '@/lib/marketing/theme'
import { MARKETING_CONTAINER } from '@/lib/marketing/layout'
import { Eyebrow } from '@/components/marketing/Eyebrow'
import { MarketingBreadcrumb } from '@/components/marketing/MarketingBreadcrumb'
import { ScreenshotFrame } from '@/components/marketing/screenshots/ScreenshotFrame'
import { getScreenshot } from '@/content/marketing/screenshots'
import type { PlatformHeroConfig } from '@/lib/marketing/platform/types'

export function PlatformHero({ hero }: { hero: PlatformHeroConfig }) {
  const primary   = getCta(hero.primaryCta)
  const secondary = getCta(hero.secondaryCta)
  const shot      = hero.screenshotId ? getScreenshot(hero.screenshotId) : undefined

  return (
    <section aria-labelledby="platform-hero-heading" className="relative overflow-hidden bg-white pt-8 pb-4 sm:pt-10 lg:pt-14">
      {/* Soft brand backdrop */}
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[560px] bg-[radial-gradient(80%_60%_at_50%_0%,rgb(var(--primary-rgb)_/_0.10),transparent_70%)]" />

      <div className={MARKETING_CONTAINER.page}>
        <div className="mx-auto max-w-3xl text-center">
          <MarketingBreadcrumb className="mb-4 justify-center" />
          {hero.eyebrow && <Eyebrow>{hero.eyebrow}</Eyebrow>}
          <h1 id="platform-hero-heading" className={cn(marketingType.hero, 'mt-5 text-foreground')}>
            {hero.headline}
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-[var(--fs-lg)] leading-relaxed text-muted-foreground">
            {hero.subheadline}
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

        {shot && (
          <div className="relative mx-auto mt-10 max-w-5xl">
            <div aria-hidden className="pointer-events-none absolute -inset-x-6 -top-6 bottom-0 -z-10 rounded-[2.5rem] bg-gradient-to-b from-primary/[0.08] via-primary/[0.04] to-transparent" />
            <ScreenshotFrame screenshot={shot} variant="dashboard" className="shadow-lg ring-1 ring-border/70" />
          </div>
        )}
      </div>
    </section>
  )
}
