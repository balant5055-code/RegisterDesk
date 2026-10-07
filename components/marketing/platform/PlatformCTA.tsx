// Phase P.2 — the closing call to action. Server Component.
//
// 2026-09-23 LUXURY PASS (owner): the page closes on the same quiet band it opened with —
// a bronze-ruled label, the headline in the display face set light, soft ink, and the two
// CTA-registry actions squared to the control radius.

import Link from 'next/link'
import { ArrowRight } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { SECTION_SPACING } from '@/lib/marketing/layout'
import { marketingButton } from '@/lib/marketing/theme'
import { getCta } from '@/lib/marketing/cta'
import { EditorialOverline } from '@/components/marketing/EditorialOverline'
import type { PlatformCtaConfig } from '@/lib/marketing/platform/types'

const ACTION = 'h-12 rounded-[var(--radius-control)] px-6'

export function PlatformCTA({ cta }: { cta: PlatformCtaConfig }) {
  const primary   = getCta(cta.primaryCta)
  const secondary = getCta(cta.secondaryCta)
  return (
    <section aria-labelledby="platform-cta-heading" className="border-t border-border/60 bg-surface-3/40">
      <div className={cn('mx-auto w-full max-w-3xl px-4 text-center sm:px-6 lg:px-8', SECTION_SPACING.default, 'lg:py-16')}>
        <EditorialOverline>Get started</EditorialOverline>
        <h2 id="platform-cta-heading" className="mt-4 text-balance font-display text-fs-2xl font-light tracking-[-0.015em] text-hero-ink leading-[1.15] sm:text-fs-3xl">
          {cta.headline}
        </h2>
        {cta.subheadline && (
          <p className="mx-auto mt-3 max-w-xl text-fs-base leading-relaxed text-hero-ink-soft">{cta.subheadline}</p>
        )}
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
    </section>
  )
}
