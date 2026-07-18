// Phase P.1.6.11 — Homepage Final CTA. Server Component (zero client JS).
//
// The conversion close: headline, subheadline, two CTAs, a support line, and an
// organizer-type trust line. Reuses the marketing layout, the CTA registry,
// design-system button variants, and typography/spacing tokens. White-first,
// premium, centered, generous whitespace, subtle background — no heavy gradients,
// illustrations, dashboards, or screenshots. No urgency/counts/testimonials.
// Static. Reusable parts (FinalCTA · CTAActions · CTATrust · CTABackground) are
// exported individually.

import Link from 'next/link'
import { typography } from '@/lib/ds/typography'
import { ArrowRight } from 'lucide-react'
import { buttonVariants } from '@/components/ui/button'
import { getCta, type CtaKey } from '@/lib/marketing/cta'
import { SectionLayout } from '@/components/marketing/layout/SectionLayout'
import { FINAL_CTA } from '@/content/marketing/final-cta'

export function CTABackground() {
  // Subtle, CSS-only brand glow — white-first, no heavy gradient.
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute left-1/2 top-1/2 -z-10 h-72 w-full max-w-2xl -translate-x-1/2 -translate-y-1/2 rounded-full bg-[radial-gradient(closest-side,rgb(var(--primary-rgb)_/_0.08),transparent)]"
    />
  )
}

export function CTAActions({ primaryCta, secondaryCta }: { primaryCta: CtaKey; secondaryCta: CtaKey }) {
  const primary   = getCta(primaryCta)
  const secondary = getCta(secondaryCta)
  return (
    <div className="flex flex-wrap items-center justify-center gap-3">
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
  )
}

export function CTATrust({ labels }: { labels: string[] }) {
  if (labels.length === 0) return null
  return (
    <div>
      <p className="text-[var(--fs-2xs)] font-semibold uppercase tracking-[0.12em] text-muted-foreground/50">Built for</p>
      <ul className="mt-2 flex flex-wrap items-center justify-center gap-x-5 gap-y-1" aria-label="Organizer types">
        {labels.map(label => (
          <li key={label} className="text-[var(--fs-sm)] text-muted-foreground">{label}</li>
        ))}
      </ul>
    </div>
  )
}

export function FinalCTA() {
  return (
    <SectionLayout background={FINAL_CTA.background} labelledBy="final-cta-heading" className="relative overflow-hidden">
      <CTABackground />
      <div className="mx-auto max-w-3xl text-center">
        <h2 id="final-cta-heading" className="text-fs-3xl font-bold tracking-tight text-foreground sm:text-fs-4xl">
          {FINAL_CTA.headline}
        </h2>
        <p className={`${typography.body} mx-auto mt-4 max-w-xl text-muted-foreground`}>
          {FINAL_CTA.subheadline}
        </p>

        <div className="mt-8">
          <CTAActions primaryCta={FINAL_CTA.primaryCta} secondaryCta={FINAL_CTA.secondaryCta} />
        </div>

        {FINAL_CTA.supportText && (
          <p className="mt-3 text-[var(--fs-sm)] text-muted-foreground">{FINAL_CTA.supportText}</p>
        )}

        <div className="mt-10">
          <CTATrust labels={FINAL_CTA.trustLabels} />
        </div>
      </div>
    </SectionLayout>
  )
}
