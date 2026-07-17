// Phase P.2 (product-page redesign) — small, page-specific Platform CTA.
// Server Component (zero client JS). Compact closing band — the product-page
// context of the ONE shared CTA language: same buttons (CTAActions) and content
// structure as the homepage FinalCTA, but with a compact heading and no trust
// line (product-oriented, not emotional). One <h2>.

import { cn } from '@/lib/utils/cn'
import { typography } from '@/lib/ds/typography'
import { SECTION_SPACING } from '@/lib/marketing/layout'
import { CTAActions } from '@/components/marketing/sections/FinalCTA'
import type { PlatformCtaConfig } from '@/lib/marketing/platform/types'

export function PlatformCTA({ cta }: { cta: PlatformCtaConfig }) {
  return (
    <section aria-labelledby="platform-cta-heading" className="border-t border-border/40 bg-white">
      <div className={cn('mx-auto w-full max-w-3xl px-4 text-center sm:px-6 lg:px-8', SECTION_SPACING.default)}>
        <h2 id="platform-cta-heading" className="text-fs-2xl font-bold tracking-tight text-foreground sm:text-fs-3xl">
          {cta.headline}
        </h2>
        {cta.subheadline && (
          <p className={`${typography.body} mx-auto mt-4 max-w-xl text-muted-foreground`}>{cta.subheadline}</p>
        )}
        <div className="mt-8">
          <CTAActions primaryCta={cta.primaryCta} secondaryCta={cta.secondaryCta} />
        </div>
      </div>
    </section>
  )
}
