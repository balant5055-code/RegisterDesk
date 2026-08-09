// RD-MEDIA-10 · Gallery hero.
//
// ═══ NOT A SECOND HERO IMPLEMENTATION ═════════════════════════════════════════
// This composes the SAME primitives every Event Details hero is built from —
// `EVENT_CONTAINER` for the measure, `TYPE` for the type scale, `SECTION_PY` for vertical
// rhythm, `BRAND_GRADIENT` for the brand wash. It defines no spacing, no font size and no
// colour of its own.
//
// Every class comes from TYPE — there is no `h1` key in the scale, so a sub-page title uses
// `sectionTitle`, the same step an Event Details section heading uses. Adding a new token
// would be a change to the shared type scale for one page.
//
// It does not instantiate `EventHeroFramework`, and that is deliberate rather than lazy:
// that framework's contract is a countdown clock, ticket essentials, trust badges and a
// registration CTA. Feeding it placeholder values to render a photo gallery would put
// meaningless furniture on the page and couple the gallery to a registration model it has
// nothing to do with. Sharing the tokens is the reuse that matters; sharing the props would
// be a costume.
// ══════════════════════════════════════════════════════════════════════════════
//
// Server Component — no hooks, no state.

import Link from 'next/link'
import { Camera } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import {
  BRAND_GRADIENT, EVENT_CONTAINER, SECTION_PY, TYPE,
} from '@/components/event-templates/shared/ui/framework'

export interface GalleryHeroProps {
  eventName:  string
  eventSlug:  string
  /** Page title — "Event photos", or a gallery's own name. */
  title:      string
  /** One line under the title. Usually a count. */
  subtitle?:  string
  description?: string | null
  /** Full-bleed background, when the gallery has a cover photo. */
  coverUrl?:  string | null
}

export function GalleryHero({
  eventName, eventSlug, title, subtitle, description, coverUrl,
}: GalleryHeroProps) {
  return (
    <section
      className={cn(
        'relative isolate overflow-hidden border-b border-border/60',
        !coverUrl && BRAND_GRADIENT,
      )}
    >
      {coverUrl && (
        <>
          {/* A plain <img>: the source is a durable object-storage URL already sized by
              Media Studio, and next/image would re-optimise an optimised file. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={coverUrl}
            alt=""
            aria-hidden
            className="absolute inset-0 -z-10 size-full object-cover"
          />
          {/* The scrim is what keeps the type legible over an arbitrary photograph. */}
          <div className="absolute inset-0 -z-10 bg-slate-950/70" aria-hidden />
        </>
      )}

      <div className={cn(EVENT_CONTAINER, SECTION_PY)}>
        <p className={cn(TYPE.eyebrow, coverUrl ? 'text-white/70' : 'text-white/80')}>
          <Link
            href={`/events/${eventSlug}`}
            className="transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
          >
            {eventName}
          </Link>
        </p>

        <h1 className={cn(TYPE.sectionTitle, 'mt-2 flex items-center gap-2.5 text-white')}>
          <Camera className="size-7 shrink-0 opacity-80 sm:size-8" aria-hidden />
          {title}
        </h1>

        {subtitle && (
          <p className={cn(TYPE.sectionDesc, 'mt-2 text-white/80')}>{subtitle}</p>
        )}

        {description && (
          <p className={cn(TYPE.body, 'mt-3 max-w-2xl text-white/70')}>{description}</p>
        )}
      </div>
    </section>
  )
}
