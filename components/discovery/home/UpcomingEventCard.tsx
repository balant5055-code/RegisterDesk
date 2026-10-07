// ─── The homepage event card ─────────────────────────────────────────────────
//
// A SERVER component: zero client JavaScript, the whole card is one real <a> to the existing
// /events/[slug] detail route.
//
// WHY THIS IS NOT components/discovery/cards/EventCard.tsx: that card is the staging /events
// grid unit — a client component with a banner-overlay date tile, a capacity bar and a status
// pill, sized for a dense 4-up grid. Editing it to serve both would change /events, which is
// out of scope. This is a narrowly-scoped variant that reuses the same pure helpers, so the
// two cannot disagree about how a date, a place or a price is rendered.
//
// EVERY FIELD IS REAL. The reference this was drawn from shows an avatar stack with "1.2K+
// going", a FEATURED ribbon and a bookmark control. RegisterDesk has no attendee avatars, no
// featured flag on the public projection and no save-for-later feature — so none of them are
// drawn. The card carries the event's real date, category, location and minimum price, and
// nothing else.
//
// ═══ TWO SHAPES, ONE DOM ═════════════════════════════════════════════════════
// Below `sm` this is an index ROW — a 120px image on the left, the text beside it — because a
// phone-width column of full-bleed 16:9 cards is 300px of card for ~60px of information, and a
// list of them scans like a slideshow rather than like a listing. From `sm` the same element
// turns the other way and becomes the familiar image-over-text card for the grid.
//
// It is one element and one set of classes, flipped by `flex-row` / `sm:flex-col`. There is no
// second markup path to keep in sync, and nothing is rendered twice and hidden.
//
// ═══ THE LUXURY PASS (2026-09-23) ════════════════════════════════════════════
// Same shape, same fields, same one link. The voice now matches the rest of the public
// site: the overline is small caps in --hero-eyebrow led by a bronze hairline, the NAME is
// set in the display face (Fraunces), the place carries a bronze pin, and the foot of the
// card is a ruled line with the price in the display face and a small-caps "View" that
// answers the hover. No pill, no badge, no new colour.
//
// ═══ TYPE + STATUS CHIPS (2026-09-23) ════════════════════════════════════════
// The category moved OUT of the overline into a type chip on the banner, with its icon from
// the discovery taxonomy, beside a status chip from the shared eventStatus() rule (see
// EventCardChips). The overline is now just WHEN: date · start time.
//
// ═══ TYPOGRAPHY DOES THE WORK PILLS USED TO ══════════════════════════════════
// (Historical — the category has since moved to the type chip; see above.)
// The date was a 36px day-over-month block and the category a grey stadium chip; between them
// they made a small card carry two boxed objects. Both are now one overline — "12 Sep ·
// Conferences" — set small, spaced and muted. The information is identical, it reads in one
// pass instead of three, and the card has one rounded rectangle in it rather than three.

import Image from 'next/image'
import Link from 'next/link'
import { ArrowRight, MapPin } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { isValidImageUrl } from '@/lib/utils/imageUrl'
import { eventLocation, priceLabel, shortDate, formatTime } from '@/components/discovery/lib/format'
import { EventCardHeader } from './EventCardChips'
import { eventLifecycleMeta } from '@/lib/ui/statusColors'
import type { PublicEventCard } from '@/lib/firebase/firestore/publicEvents'

/**
 * The card serves both homepage sections. The ONLY difference is the bottom-left slot:
 * an upcoming event shows what it costs to join, a finished one shows that it is over.
 * A price on a past event is an invitation to do something no longer possible.
 *
 * "Completed" reuses `eventLifecycleMeta` — the platform's existing lifecycle vocabulary,
 * already themed for light and dark — rather than inventing a second word or a second
 * colour for a state the system already names.
 */
export type EventCardVariant = 'upcoming' | 'completed'

export function UpcomingEventCard({
  event, variant = 'upcoming',
}: {
  event: PublicEventCard
  variant?: EventCardVariant
}) {
  const src = isValidImageUrl(event.bannerUrl) ? event.bannerUrl : null
  const place = eventLocation(event)
  const price = priceLabel(event)
  const completed = variant === 'completed'

  // The category now lives in the type chip (with its registry icon), so the overline is
  // WHEN: the date and, where the organizer set one, the start time. Undated events are
  // excluded from Upcoming, but a dangling separator would be the only thing marking an
  // absent value, so empty parts are dropped before joining.
  const meta = [event.startDate ? shortDate(event.startDate) : '', formatTime(event.startTime)]
    .filter(Boolean)
    .join(' · ')

  return (
    <article className="flex h-full flex-col">
      {/* Type + status, ABOVE the card on the page — never over the organiser's poster. */}
      <EventCardHeader event={event} withStatus={!completed} />
      <Link
        href={`/events/${event.slug}`}
        className={cn(
          'group flex flex-1 overflow-hidden rounded-lg border border-border/70 bg-card outline-none',
          'flex-row sm:flex-col',
          'transition-colors duration-200 hover:border-border-strong',
          // The lift belongs to a card, not to a list row: a row that rises on hover reads as
          // the list itself shifting. Elevation is the design system's own token, unchanged.
          'sm:transition-all sm:hover:-translate-y-0.5 sm:hover:shadow-elevation-2',
          'focus-visible:ring-2 focus-visible:ring-action focus-visible:ring-offset-2',
        )}
      >
        {/* Phone: a fixed 120px column stretched to the row's height, so a one-line and a
            two-line title still produce a flush left edge. From `sm`: the full-width 16:9
            banner, which is the card's anchor. */}
        <div className="relative w-[7.5rem] shrink-0 self-stretch overflow-hidden bg-muted sm:aspect-video sm:w-full sm:self-auto">
          {src ? (
            <Image
              src={src}
              /* Decorative: the heading below is inside this same link, so it already supplies
                 the link's accessible name. Repeating the event name here would make a screen
                 reader announce it twice. */
              alt=""
              fill
              sizes="(min-width: 1024px) 23vw, (min-width: 640px) 45vw, 120px"
              className="object-cover transition-transform duration-500 ease-out group-hover:scale-[1.03]"
            />
          ) : (
            /* The no-image placeholder — the public ramp's two stops at 14%, so it stays a
               tint rather than becoming a second brand statement beside the CTA. */
            <span
              aria-hidden
              className="absolute inset-0 bg-gradient-to-br from-action/[0.14] via-muted to-action-end/[0.14]"
            />
          )}

        </div>

        <div className="flex min-w-0 flex-1 flex-col p-3.5 sm:p-4">
          <p className="flex min-w-0 items-center gap-2 text-fs-2xs font-semibold uppercase tracking-[0.16em] text-hero-eyebrow">
            <span aria-hidden className="h-px w-4 shrink-0 bg-hero-accent-rule" />
            <span className="truncate">{meta}</span>
          </p>

          <h3 className="mt-2 line-clamp-2 font-display text-fs-lg font-normal tracking-[-0.01em] text-hero-ink transition-colors leading-snug group-hover:text-action">
            {event.name}
          </h3>

          {place && (
            <p className="mt-1.5 flex min-w-0 items-center gap-1.5 text-fs-sm text-hero-ink-soft">
              <MapPin aria-hidden strokeWidth={1.75} className="-mt-px size-3.5 shrink-0 text-hero-accent-rule" />
              <span className="truncate">{place}</span>
            </p>
          )}

          {/* `mt-auto` pins this row to the bottom, so a one-line title and a two-line title
              still produce cards whose metadata sits on the same baseline. */}
          <div className="mt-auto pt-3.5">
            <div className="flex items-center justify-between gap-2 border-t border-border/60 pt-3">
              {completed ? (
                // Occupies the price slot exactly — same position, same size, same rhythm — so a
                // completed card is the same object as an upcoming one, differing in one word.
                // Deliberately not muted grey, which would read as disabled or failed: it carries
                // the platform's own 'completed' accent, so it states a fact in a confident colour.
                <span className="min-w-0 truncate text-fs-2xs font-semibold uppercase tracking-[0.16em] text-accent-people-fg">
                  {eventLifecycleMeta.completed.label}
                </span>
              ) : (
                <span className={cn(
                  'min-w-0 truncate font-display text-fs-lg font-normal tabular-nums leading-none',
                  price.free ? 'text-success' : 'text-hero-ink',
                )}>
                  {price.text}
                </span>
              )}

              {/* The action affordance. A button here would be a second target inside a link and
                  a third rounded box inside a card; an arrow that answers the hover says the
                  same thing and costs nothing. The whole card is already the control. */}
              <span aria-hidden className="inline-flex shrink-0 items-center gap-1.5 text-fs-2xs font-semibold uppercase tracking-[0.16em] text-hero-eyebrow transition-colors duration-200 group-hover:text-action">
                View
                <ArrowRight className="size-3.5 transition-transform duration-200 group-hover:translate-x-0.5 motion-reduce:transition-none" />
              </span>
            </div>
          </div>
        </div>
      </Link>
    </article>
  )
}
