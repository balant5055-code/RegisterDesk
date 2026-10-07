// ─── Upcoming Events ─────────────────────────────────────────────────────────
//
// A SERVER component. Zero client JavaScript: the rail scrolls natively with CSS scroll-snap
// and every card is a plain link, so nothing here adds to the homepage bundle.
//
// ═══ NO ADDITIONAL DATABASE READS ════════════════════════════════════════════
// This section takes the events the page has ALREADY fetched for the hero and narrows them.
// A second query would have cost another page of event documents plus another batch of
// registration-counter reads, on the site's highest-traffic URL, to render eight cards.
//
// The honest limitation of that choice: the pool is the most recently PUBLISHED events, so
// these are the soonest events within that pool rather than the soonest on the platform.
//
// ═══ THERE IS NO "VIEW ALL EVENTS" LINK, AND THAT IS DELIBERATE ══════════════
// There used to be two: one beside the heading and one in the empty state, both pointing at
// /events. /events is now a 307 to `/` (app/events/page.tsx), so both had become
// ` / → /events → / ` — a CTA that promised more events and returned the reader to the page
// they were already on. THIS page is the full listing; a link to it from inside itself is not
// navigation. They were removed rather than repointed, because no other destination exists
// and inventing a route to fill the slot would be worse than an empty slot.
//
// The persistent "Discover Events" entries in the header and footer still resolve to /events
// on purpose — see the note in HomeFooter.tsx. Those are navigation IDENTITY (a "you are
// here" entry present on every marketing route), not a section CTA promising more content,
// and /events must stay a live URL for existing links, bookmarks and index entries.
//
// ═══ A GRID, WHERE THIS USED TO BE A SCROLL RAIL ═════════════════════════════
// The rail showed 78% of one card on a phone and about four on a desktop, with the rest behind
// a horizontal swipe. On the page whose entire job is showing what is on, that hid most of the
// content behind a gesture — and a horizontally scrolling row inside a vertically scrolling
// page is the least reliable thing to hit on a touchscreen.
//
// It is a plain responsive grid now: one column on a phone (where the card is an index ROW,
// not a tall card — see UpcomingEventCard), two from `sm`, four from `lg`. Eight cards divide
// evenly into all three, so no breakpoint ends on a ragged half-row. Nothing is hidden and
// nothing scrolls sideways, which also removes the negative margins the bleed needed.
//
// ═══ "UPCOMING" IS NOT REDEFINED HERE ════════════════════════════════════════
// It uses `upcomingSoonest` from the shared discovery collection module, which is built on the
// same `isUpcoming` predicate the featured ranking uses. Past events cannot appear. Undated
// events are excluded from THIS section specifically, because a list ordered by date has
// nowhere meaningful to place an event with no date.

import { CalendarDays } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { container } from '@/lib/ds/containers'
import { upcomingSoonest } from '@/components/discovery/lib/collection'
import type { PublicEventCard } from '@/lib/firebase/firestore/publicEvents'
import { UpcomingEventCard } from './UpcomingEventCard'
import { SectionHead } from './SectionHead'

/** Two full rows at every breakpoint the grid has: 8 = 8×1 = 4×2 = 2×4. */
const MAX_CARDS = 8

/**
 * Shown when the catalog genuinely has nothing ahead of today. It says so plainly and offers
 * the one action that still makes sense — never a placeholder card, and never an invented event.
 */
function EmptyState() {
  return (
    <div className="flex flex-col items-center gap-4 rounded-lg border border-border/70 bg-card px-6 py-9 text-center sm:flex-row sm:gap-5 sm:py-7 sm:text-left">
      <span className="flex size-11 shrink-0 items-center justify-center rounded-md bg-muted/70">
        <CalendarDays className="size-5 text-muted-foreground" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <h3 className="text-fs-md font-semibold text-foreground">No upcoming events just yet</h3>
        <p className="mt-1 text-fs-sm text-muted-foreground leading-relaxed">
          Nothing is scheduled ahead of today right now. New events appear here as soon as
          organizers publish them.
        </p>
      </div>
    </div>
  )
}

export function UpcomingEvents({ events }: { events: PublicEventCard[] }) {
  const upcoming = upcomingSoonest(events, MAX_CARDS)

  return (
    <section aria-labelledby="upcoming-events-heading" className="pb-10 pt-5 lg:pb-14 lg:pt-8">
      <div className={container.page}>
        <SectionHead
          id="upcoming-events-heading"
          eyebrow="What's on"
          title="Upcoming Events"
          // Literally what `upcomingSoonest` returns — it states the ORDER, not a count.
          lede="Events ahead of today, soonest first."
        />

        <div className="mt-8 lg:mt-10">
          {upcoming.length === 0 ? (
            <EmptyState />
          ) : (
            <ul className={cn('grid gap-2.5 sm:gap-4', 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-4')}>
              {upcoming.map(event => (
                <li key={event.slug} className="min-w-0">
                  <UpcomingEventCard event={event} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  )
}
