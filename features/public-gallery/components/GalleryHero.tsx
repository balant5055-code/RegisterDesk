// RD-MEDIA-10 · Gallery hero.
//
// ═══ NOT A SECOND HERO IMPLEMENTATION ═════════════════════════════════════════
// This composes the SAME primitives every Event Details hero is built from —
// `EVENT_CONTAINER` for the measure, `TYPE` for the type scale, `SECTION_PY` for vertical
// rhythm. It defines no spacing, no font size and no colour of its own. (It used to take
// `BRAND_GRADIENT` as the no-cover backdrop; that band is gone — see the note in the body.)
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
import { cn } from '@/lib/utils/cn'
import {
  EVENT_CONTAINER, TYPE,
} from '@/components/event-templates/shared/ui/framework'
import { PAGE_TITLE } from '@/lib/marketing/pageTitle'

export interface GalleryHeroProps {
  eventName:  string
  eventSlug:  string
  /** Page title — "Event images", or a gallery's own name. */
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
  // With a cover photograph the header is white type over a dark scrim. Without one it
  // used to be a full-bleed brand gradient band — the only large gradient surface on the
  // public site. It is now the same editorial header every other event page opens with:
  // page ground, indigo eyebrow, ink title. The ramp is for actions, not backdrops.
  const onPhoto = !!coverUrl
  return (
    <section className="relative isolate overflow-hidden border-b border-border/60 bg-background">
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

      {/* A compact band (owner, 2026-09-23): the header is a label, not a stage. */}
      <div className={cn(EVENT_CONTAINER, 'py-7 sm:py-9')}>
        {/* 2026-09-23 luxury pass: bronze-ruled small caps over a light serif title — the
            public site's editorial voice. The scrim-over-a-real-photograph rule is unchanged. */}
        <p className={cn('flex items-center gap-2.5 text-fs-2xs font-semibold uppercase tracking-[0.22em]', onPhoto ? 'text-white/75' : 'text-hero-eyebrow')}>
          <span aria-hidden className={cn('h-px w-6 shrink-0', onPhoto ? 'bg-white/50' : 'bg-hero-accent-rule')} />
          <Link
            href={`/events/${eventSlug}`}
            className={cn('transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2', onPhoto ? 'focus-visible:ring-white/60' : 'focus-visible:ring-action')}
          >
            {eventName}
          </Link>
        </p>

        <h1 className={cn('mt-3', PAGE_TITLE, onPhoto ? 'text-white' : 'text-hero-ink')}>
          {title}
        </h1>

        {subtitle && (
          <p className={cn('mt-2 text-fs-2xs font-semibold uppercase tracking-[0.16em]', onPhoto ? 'text-white/80' : 'text-hero-eyebrow')}>{subtitle}</p>
        )}

        {description && (
          <p className={cn(TYPE.body, 'mt-4 max-w-2xl', onPhoto ? 'text-white/75' : 'text-hero-ink-soft')}>{description}</p>
        )}
      </div>
    </section>
  )
}
