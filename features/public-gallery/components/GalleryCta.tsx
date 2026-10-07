// RD-MEDIA-10 · Gallery CTA.
//
// ═══ ON "REUSE EXISTING CTA COMPONENTS" ═══════════════════════════════════════
// The audit found no generic CTA component to reuse. Every CTA in the public site is
// registration-specific and welded to a pass model — `StickyMobileCTA`,
// `StickyRegistrationCard`, `TicketsPreviewBar` all take passes, availability and a sale
// state. A photo gallery has none of those.
//
// So this composes the same PRIMITIVES those components are built from — `SectionShell` for
// the band, `CARD` for the surface, `TYPE` for the type scale, `buttonVariants` for the
// action — and introduces no spacing, size or colour of its own. It is a composition, not a
// fourth CTA system.
// ══════════════════════════════════════════════════════════════════════════════
//
// Server Component — no hooks, no state.

import Link from 'next/link'
import { ArrowRight } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { marketingButton } from '@/lib/marketing/theme'
import { SectionShell } from '@/components/event-templates/shared/ui/framework'

export interface GalleryCtaProps {
  eventName: string
  eventSlug: string
}

export function GalleryCta({ eventName, eventSlug }: GalleryCtaProps) {
  return (
    <SectionShell border={false} className="pb-10 pt-2 sm:pb-12 sm:pt-2 lg:pb-12 lg:pt-2">
      {/* 2026-09-23 luxury pass: a ruled editorial line rather than a boxed card. */}
      <div className="flex flex-wrap items-center justify-between gap-5 border-y border-border/60 py-5">
        <div className="min-w-0">
          <p className="flex items-center gap-2.5 text-fs-2xs font-semibold uppercase tracking-[0.22em] text-hero-eyebrow">
            <span aria-hidden className="h-px w-6 shrink-0 bg-hero-accent-rule" />
            The event
          </p>
          <p className="mt-2 font-display text-fs-xl font-light text-hero-ink">Looking for the event?</p>
          <p className="mt-1 text-fs-sm text-hero-ink-soft">
            Schedule, venue, passes and everything else about {eventName}.
          </p>
        </div>
        <Link
          href={`/events/${eventSlug}`}
          className={cn(marketingButton({ emphasis: 'gradient', variant: 'primary', size: 'md' }), 'shrink-0 rounded-[var(--radius-control)]')}
        >
          View event details
          <ArrowRight className="size-4" aria-hidden />
        </Link>
      </div>
    </SectionShell>
  )
}
