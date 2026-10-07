// ─── Recently Completed ──────────────────────────────────────────────────────
//
// A SERVER component. Zero client JavaScript: every card is a plain link.
//
// ═══ WHY THIS SECTION EXISTS, AND WHY IT NEEDED ITS OWN QUERY ════════════════
// A finished event is usually NOT in `lifecycleStatus: 'published'` any more. Closing
// registrations moves it to 'registration_closed'; the organizer's "Complete" action moves it
// to 'completed'. `listPublishedEvents` filters `lifecycleStatus == 'published'`, so it can
// never return either — which is exactly why a real, genuinely finished public event was
// invisible on the homepage. This section is fed by `listRecentlyCompletedEvents`, which
// queries the three public lifecycle states and applies the identical moderation, visibility
// and archive gates.
//
// ═══ IT CANNOT OVERLAP UPCOMING ══════════════════════════════════════════════
// Both sections test the same boundary — `endDate ?? startDate` — from the one module
// (components/discovery/lib/collection.ts). Upcoming is `>= today`, completed is `< today`.
// An event ending TODAY is upcoming, because it may still be running.
//
// ═══ SECONDARY, AND BUILT TO SAY SO ══════════════════════════════════════════
// Upcoming Events is the primary discovery section and keeps the larger masthead, the
// larger card count and the top position. This one is separated by a hairline, headed one
// scale step down (SectionHead level='secondary'), and holds at most four cards. It is the
// epilogue to the page, not a rival to it.
//
// ═══ NO CTA ══════════════════════════════════════════════════════════════════
// No "see all completed events" link, because no such page exists and inventing a route to
// fill a slot is worse than leaving the slot empty. /events is a 307 back to `/`, so a link
// there would return the reader to the page they are already on.

import { cn } from '@/lib/utils/cn'
import { container } from '@/lib/ds/containers'
import type { PublicEventCard } from '@/lib/firebase/firestore/publicEvents'
import type { CompletedDestinationMap } from '@/lib/discovery/completedDestinations'
import { CompletedEventCard } from './CompletedEventCard'
import { SectionHead } from './SectionHead'

/**
 * ═══ ONE GRID, ONE CARD SIZE, EVERY COUNT ════════════════════════════════════
 * Phone 1 → tablet 3 → laptop 4, on `md` (768) and `xl` (1280), whatever the section holds.
 * `lg` (1024) deliberately stays at three: a 1024 viewport is an iPad, and four across there
 * would give each card 226px.
 *
 * ═══ WHY THE PER-COUNT WIDTH CAPS ARE GONE ═══════════════════════════════════
 * They existed to stop a lone card looking orphaned, and they worked by making it BIGGER —
 * 416px at count 1, 422px at count 2, against 289px in the four-up grid. That solved the
 * orphan by introducing a worse problem: the completed card was half again the size of an
 * Upcoming card on the same page, so the archive read as the heavier of the two sections.
 *
 * One track width for every count means a completed card is always the same object as an
 * upcoming one — 289px at 1280 — and a single event is simply one compact card with
 * whitespace beside it, which is what a one-item archive honestly looks like.
 *
 * It costs no fake content to get any of this: the layout adapts, never the data.
 *
 * ═══ A GRID, WHERE UPCOMING USES A SCROLL RAIL ═══════════════════════════════
 * Deliberate, not an inconsistency. Upcoming holds up to EIGHT cards and needs the rail to
 * carry them; this section holds at most four, which fit a row at every breakpoint from `lg`.
 * A one-item scroll rail also advertises a scroll that does not exist.
 *
 * ═══ WHY A LITERAL CLASS STRING ══════════════════════════════════════════════
 * Tailwind scans source statically, so `md:grid-cols-${n}` compiles to nothing. Every class
 * below is a literal the scanner can see.
 */
const GRID = 'grid-cols-1 md:grid-cols-3 xl:grid-cols-4'

export function RecentlyCompleted({
  events, destinations,
}: {
  events: PublicEventCard[]
  /**
   * Slug → the destinations that ACTUALLY exist for that event, resolved on the server by
   * app/page.tsx. It is a prop rather than something this component fetches because
   * resolving it is async, and an async server component cannot be rendered by
   * renderToStaticMarkup — which is how this section is tested. Omitting it is safe: each
   * card then offers the event-details link alone, which always resolves.
   */
  destinations?: CompletedDestinationMap
}) {
  // Omitted entirely when there is nothing to show, rather than rendering a bordered box that
  // says so. Upcoming Events already carries an honest empty state directly above; a second
  // "nothing here" panel on the same screen is noise, and an empty band this size would be the
  // largest thing between the search and the footer.
  if (events.length === 0) return null



  return (
    <section
      aria-labelledby="recently-completed-heading"
      // The hairline is the section break. It is the same rule weight the footer uses, and it
      // does the work a heavier heading would otherwise have to do — which is what keeps this
      // section legible as secondary without shrinking its type into a caption.
      className="pb-16 lg:pb-20"
    >
      <div className={container.page}>
        <div className="border-t border-border/60 pt-10 lg:pt-12">
          <SectionHead
            id="recently-completed-heading"
            eyebrow="The archive"
            title="Recently Completed"
            lede="Events that just happened."
            level="secondary"
          />

          <ul className={cn('mt-8 grid gap-4 sm:gap-5 lg:mt-10', GRID)}>
            {events.map(event => (
              <li key={event.slug} className="min-w-0">
                <CompletedEventCard event={event} destinations={destinations?.[event.slug]} />
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  )
}
