// Phase P.2 (UX redesign) — Platform hero. Server Component (zero client JS).
//
// The page's single <h1>, its CTAs and (when one exists) a framed product screenshot.
// Reuses the CTA registry, button variants and ScreenshotFrame (placeholder — never a
// fake screenshot). No animation.
//
// 2026-09-23 LUXURY PASS (owner): a centred editorial masthead on a quiet band — the
// breadcrumb, a bronze-ruled small-caps label in place of the pill, the headline in the
// display face set LIGHT, soft editorial ink, and squared (6px) actions. The radial brand
// wash went: the band's tint and the type carry the page now.

import Link from 'next/link'
import { ArrowRight } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { marketingButton } from '@/lib/marketing/theme'
import { getCta } from '@/lib/marketing/cta'
import { MARKETING_CONTAINER } from '@/lib/marketing/layout'
import { EditorialOverline } from '@/components/marketing/EditorialOverline'
import { MarketingBreadcrumb } from '@/components/marketing/MarketingBreadcrumb'
import { ScreenshotFrame } from '@/components/marketing/screenshots/ScreenshotFrame'
import { getScreenshot, hasScreenshot } from '@/content/marketing/screenshots'
import type { PlatformHeroConfig } from '@/lib/marketing/platform/types'
import { PAGE_TITLE } from '@/lib/marketing/pageTitle'

/** Squared, a touch taller than the default lg — the editorial action size. */
const ACTION = 'h-12 rounded-[var(--radius-control)] px-6'

export function PlatformHero({ hero }: { hero: PlatformHeroConfig }) {
  const primary   = getCta(hero.primaryCta)
  const secondary = getCta(hero.secondaryCta)
  const shot      = hero.screenshotId && hasScreenshot(hero.screenshotId)
    ? getScreenshot(hero.screenshotId)
    : undefined

  return (
    <section aria-labelledby="platform-hero-heading" className="border-b border-border/60 bg-surface-3/40">
      <div className={cn(MARKETING_CONTAINER.page, 'py-10 sm:py-14 lg:py-16')}>
        <div className="mx-auto max-w-3xl text-center">
          <MarketingBreadcrumb className="mb-7 justify-center" />
          {hero.eyebrow && <EditorialOverline>{hero.eyebrow}</EditorialOverline>}
          <h1
            id="platform-hero-heading"
            className={`mt-5 ${PAGE_TITLE}`}
          >
            {hero.headline}
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-fs-md leading-relaxed text-hero-ink-soft sm:text-fs-lg">
            {hero.subheadline}
          </p>
          <div className="mt-8 flex flex-col items-stretch justify-center gap-3 sm:flex-row sm:items-center">
            <Link
              href={primary.href}
              className={cn(marketingButton({ variant: primary.variant, size: 'lg' }), ACTION)}
              style={primary.variant === 'gradient' ? { backgroundImage: 'var(--action-gradient)' } : undefined}
            >
              {primary.label}
              <ArrowRight className="size-4" aria-hidden />
            </Link>
            <Link
              href={secondary.href}
              className={cn(marketingButton({ variant: secondary.variant, size: 'lg' }), ACTION, 'border-hero-ink/25 bg-transparent text-hero-ink shadow-none hover:border-action hover:bg-transparent hover:text-action')}
            >
              {secondary.label}
            </Link>
          </div>
        </div>

        {shot && (
          <div className="mx-auto mt-12 max-w-5xl">
            <ScreenshotFrame screenshot={shot} variant="dashboard" className="shadow-elevation-1 ring-1 ring-border/70" />
          </div>
        )}
      </div>
    </section>
  )
}
