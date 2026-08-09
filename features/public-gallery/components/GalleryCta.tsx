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
import { buttonVariants } from '@/components/ui'
import { CARD, CARD_PAD_LG, SectionShell, TYPE } from '@/components/event-templates/shared/ui/framework'

export interface GalleryCtaProps {
  eventName: string
  eventSlug: string
}

export function GalleryCta({ eventName, eventSlug }: GalleryCtaProps) {
  return (
    <SectionShell>
      <div className={cn(CARD, CARD_PAD_LG, 'flex flex-wrap items-center justify-between gap-4')}>
        <div className="min-w-0">
          <p className={TYPE.cardTitleLg}>Looking for the event?</p>
          <p className={cn(TYPE.cardBody, 'mt-1')}>
            Schedule, venue, passes and everything else about {eventName}.
          </p>
        </div>
        <Link
          href={`/events/${eventSlug}`}
          className={cn(buttonVariants({ variant: 'primary', size: 'md' }), 'shrink-0')}
        >
          View event details
          <ArrowRight className="size-4" aria-hidden />
        </Link>
      </div>
    </SectionShell>
  )
}
