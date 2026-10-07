// ─── Recently Completed — the archive card ───────────────────────────────────
//
// A SERVER component: zero client JavaScript, every action is a real <a>.
//
// ═══ WHY THIS IS NOT UpcomingEventCard ═══════════════════════════════════════
// It used to be. `UpcomingEventCard variant="completed"` swapped the price for the word
// "Completed" and changed nothing else, so a finished event was rendered as a shopping card
// with the price removed: no date beyond a day-and-month tile, no description, and — the
// thing an archive card exists for — no way to reach what the event LEFT BEHIND.
//
// What it got RIGHT was leading with the event's photograph, and this card keeps that.
//
// UpcomingEventCard is untouched and still owns the upcoming rail. This is a different
// object for a different job, in the same design family: the same border, radius, surface,
// hover and type scale, so the two sections read as one page.
//
// ═══ THE BANNER IS THE EVENT, NOT A GALLERY PREVIEW ══════════════════════════
// An earlier revision of this card removed the banner outright, reasoning that "photos are a
// destination, not content". That conflated two different things and made the section worse:
// the banner is the EVENT's own image, the same one the upcoming rail and the detail page
// use, and "Photos" is a link to the gallery. One is identity, the other is navigation, and
// dropping the first to justify the second left an archive section with no visual memory in
// it at all.
//
// So the banner is back, and it is the card's anchor. What stays absent is anything that
// would make this a gallery preview: no thumbnail strip, no photo grid, no cover-image
// carousel, no "+N photos" overlay, no count of any kind.
//
// ═══ EVERY ACTION IS PROVEN, BUT THE TEST IS "DOES THE PAGE EXIST" ═══════════
// Not "does it have content". An earlier revision asked the stricter question and hid
// "Photos" for any gallery holding zero images — but that page answers 200 with its own empty
// state, so the reader simply lost the way there. `/results/<slug>` genuinely did 404 for an
// event with no published snapshot; that was fixed at the route, which now says "Results
// aren't published yet" for a public event.
//
// So both are offered whenever their page renders, and `resolveCompletedDestinations` still
// CHECKS rather than assumes: an event whose gallery bridge is missing really does 404, and
// that link stays hidden.
//
// ═══ THE LUXURY PASS (2026-09-23) ════════════════════════════════════════════
// Structure, destinations and the action rail are unchanged. The voice now matches the
// upcoming card and the rest of the public site: the title is set in the display face in
// --hero-ink, the place carries a bronze pin, the organizer's line is in --hero-ink-soft,
// and the rail's quiet cells use the same editorial ink.
//
// ═══ NO NESTED ANCHORS ═══════════════════════════════════════════════════════
// The card is NOT one big link. The title is the link to the event, and each action is its
// own link beside it — an <a> inside an <a> is invalid markup and browsers recover from it
// unpredictably. The whole card still responds to hover, through `group`, so it reads as one
// object without pretending to be one control.

import Image from 'next/image'
import Link from 'next/link'
import { MapPin, Images, Trophy, Award, ArrowRight } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { isValidImageUrl } from '@/lib/utils/imageUrl'
import { eventLocation, shortDate } from '@/components/discovery/lib/format'
import { EventCardHeader } from './EventCardChips'
import { eventLifecycleMeta } from '@/lib/ui/statusColors'
import { detailsOnly, type CompletedEventDestinations } from '@/lib/discovery/completedDestinations'
import type { PublicEventCard } from '@/lib/firebase/firestore/publicEvents'

/**
 * One cell of the action rail.
 *
 * ═══ WHY THESE ARE NOT BUTTONS ═══════════════════════════════════════════════
 * Three filled controls at the foot of an archive card would outweigh the event above them
 * and turn a memory into a control panel. These are navigation: a mark and a word. The whole
 * cell is the target, the hover state is the action colour, and the rail's hairlines do the
 * separating that borders would otherwise have to.
 *
 * ═══ THE MARK SITS ABOVE THE WORD, AND THAT IS ARITHMETIC ════════════════════
 * Stacking means a cell needs only max(icon, label) rather than their sum, which is what
 * lets the rail survive the narrowest card the grid produces — 226px in the three-column
 * tablet layout at 768.
 *
 * It also buys the target height for free — 56px, well past the 32px minimum — without
 * shrinking a single point of type.
 *
 * ═══ SHORT WORD, FULL ACCESSIBLE NAME ════════════════════════════════════════
 * "View Photos" does not fit at any honest size, so the visible word is the noun. The
 * accessible name carries the whole phrase AND the event's title, which is what stops four
 * cards reading as "Photos, Results, Certificates, Details" sixteen times over to a screen
 * reader.
 */
function Action({
  href, icon: Icon, label, name, moves = false,
}: {
  href: string
  /** Every cell has one, including Details, whose mark is the arrow itself. */
  icon: typeof Images
  /** The visible word — a noun, because the cell is 72px at its narrowest. */
  label: string
  /** The accessible name: the full phrase plus the event (WCAG 2.5.3 contains the label). */
  name: string
  /** True for Details, whose arrow travels a little on hover. */
  moves?: boolean
}) {
  return (
    <Link
      href={href}
      aria-label={name}
      className={cn(
        // px-0.5, not px-1: the longest label is 62px inside a 72px track, and 4px of padding
        // a side left 0.8px of headroom — close enough that a font-loading race truncated
        // "Certificates" to an ellipsis in a production screenshot. 2px a side gives ~6px of
        // real margin. The cells still read as separated because the rules do that, not padding.
        'group/act flex min-h-[3.25rem] flex-col items-center justify-center gap-1 px-0.5 py-2',
        'text-center transition-colors',
        'hover:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-action',
      )}
    >
      {/* Three quiet cells and ONE that carries the accent: Details is the card's primary
          destination — the other three are conveniences that exist only for some events —
          so it alone is set in the action colour. Four equally loud cells read as a tab
          bar, which is what made the old rail feel like an app control, not a footer. */}
      <Icon
        aria-hidden
        strokeWidth={1.5}
        className={cn(
          'size-[18px] shrink-0 transition-all duration-200',
          moves ? 'text-action' : 'text-hero-accent-rule group-hover/act:text-hero-ink',
          moves && 'group-hover/act:translate-x-0.5 motion-reduce:transition-none motion-reduce:group-hover/act:translate-x-0',
        )}
      />
      <span className={cn(
        'min-w-0 max-w-full truncate text-fs-2xs transition-colors',
        moves ? 'font-semibold text-action' : 'font-medium text-hero-ink-soft group-hover/act:text-hero-ink',
      )}>
        {label}
      </span>
    </Link>
  )
}

/**
 * === THE RAIL IS ONE ROW, AND THAT IS ARITHMETIC ============================
 * It used to be a 2x2 block, which cost the card a whole extra row - 120px of rail on a
 * 490px card. One row halves that to 60px, and it is the single largest reason the card
 * is now materially shorter.
 *
 * Whether four cells fit is a measurement, not a preference. "Certificates" is the longest
 * label; rendered in the browser it is 74px at the 13px token, 68px at 12px and 62px at
 * 11px. A cell needs the label plus its 8px of padding, so 70px. The card is 289px in the
 * four-up desktop grid, giving 72px a cell - so four across fits at 11px and at no larger
 * size. That is why the label sits on the overline token rather than the body one.
 *
 * The one width where it does not fit is the THREE-up tablet band: a 227px card at 768
 * gives 57px a cell. There the rail folds back to 2x2 and unfolds again at lg, where the
 * card is 307px. Measured at every target width, not inferred from the breakpoint name.
 *
 * Fewer than four actions always fit on one row: three cells of a 227px card are 75px.
 * Each count therefore gets its own literal class string - Tailwind scans statically, so a
 * class name built by interpolation compiles to nothing.
 */
const RAIL_LAYOUT: Record<number, string> = {
  1: 'grid-cols-1',
  2: 'grid-cols-2 [&>a+a]:border-l',
  3: 'grid-cols-3 [&>a+a]:border-l',
  // Four: one row, except across the 3-up tablet band. In the folded state the third cell
  // starts a row, so it drops the vertical rule and the bottom pair takes a horizontal one.
  4: 'grid-cols-4 [&>a+a]:border-l'
     + ' md:grid-cols-2 md:[&>a:nth-child(3)]:border-l-0 md:[&>a:nth-child(n+3)]:border-t'
     + ' lg:grid-cols-4 lg:[&>a:nth-child(3)]:border-l lg:[&>a:nth-child(n+3)]:border-t-0',
}

export function CompletedEventCard({
  event, destinations,
}: {
  event: PublicEventCard
  /** Omitted only where a caller cannot resolve them; the card then offers details alone. */
  destinations?: CompletedEventDestinations
}) {
  const dest = destinations ?? detailsOnly(event.slug)
  // The event's real banner, or nothing. `isValidImageUrl` is the same guard the upcoming
  // card uses, so a malformed or missing URL falls to the tint rather than to a broken image.
  const src = isValidImageUrl(event.bannerUrl) ? event.bannerUrl : null
  /** The event's own logo, for the no-banner slot only. Same host guard as the banner. */
  const logo = !src && isValidImageUrl(event.logoUrl) ? event.logoUrl : null
  /** Up to two initials from the event's own name — derived, never invented. */
  const monogram = event.name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]!.toUpperCase()).join('')
  const place = eventLocation(event)
  // `endDate ?? startDate` is the day the event actually finished — the same field
  // `completionDate` uses to decide this event belongs in this section at all.
  const finished = event.endDate ?? event.startDate
  // The organizer's own one-line description. Never generated, never padded: an event
  // without one simply has no description line.
  const tagline = event.tagline?.trim() ?? ''

  // Built as a list so the rail can ask how many there are — an odd count needs its last
  // cell to span both tracks. Details is always last and always present; it is the one
  // destination that exists by construction.
  const actions = [
    dest.photos && {
      href: dest.photos, icon: Images, label: 'Images',
      name: `View photos from ${event.name}`,
    },
    dest.results && {
      href: dest.results, icon: Trophy, label: 'Results',
      name: `View results for ${event.name}`,
    },
    dest.certificates && {
      href: dest.certificates, icon: Award, label: 'Certificates',
      name: `Get your certificate for ${event.name}`,
    },
    {
      href: dest.details, icon: ArrowRight, label: 'Details',
      name: `Event details for ${event.name}`, moves: true,
    },
  ].filter((a): a is { href: string; icon: typeof Images; label: string; name: string; moves?: boolean } => Boolean(a))

  return (
    <div className="flex h-full flex-col">
      {/* The event's type, ABOVE the card on the page. Its status is the "Completed" line in
          the body, which is this section's whole premise, so it is not repeated here. */}
      <EventCardHeader event={event} withStatus={false} />
      <article
        className={cn(
          // ALWAYS vertical: banner, then body, then rail. A revision briefly turned the lone
          // card on its side to fill the row, and it stopped being the same object as the cards
          // beside it in every other count. The section fills the row with COLUMNS instead.
          'group/card flex flex-1 flex-col overflow-hidden rounded-lg border border-border/70 bg-card',
          'transition-colors duration-200 hover:border-border-strong',
        )}
      >
        {/* ── The event's own banner, and the card's visual anchor ──────────────
               16:9, the same ratio the upcoming card uses, so the two sections read as one
               family. `overflow-hidden` on the article is what rounds its top corners — the
               image needs no radius of its own, which is what keeps this to ONE rounded
               rectangle rather than a box inside a box.

               It is NOT wrapped in a link. The title below is the event's link and the actions
               are their own; an anchor around the image would be a third link to a destination
               already offered twice, and would put an <a> inside the card that a keyboard user
               has to tab past to reach anything.

               The lift on hover is a scale on the image alone, not on the card — a card that
               moves under the cursor in a four-up grid makes the whole row feel unstable. */}
        <div className={cn(
  'relative aspect-video w-full shrink-0 overflow-hidden border-b border-border/60 bg-muted',
        )}>
          {src ? (
            <Image
              src={src}
              /* Decorative: the heading below names the event, and this image sits inside the
                 same card. Repeating the name here would announce it twice. */
              alt=""
              fill
              sizes="(min-width: 1280px) 23vw, (min-width: 640px) 45vw, 100vw"
              className="object-cover transition-transform duration-500 ease-out group-hover/card:scale-[1.03]"
            />
          ) : (
            /* The no-banner case. The public ramp's two stops at 14% — a tint, not a second
               brand statement, and never a stock photograph standing in for one that does not
               exist. On the tint sits the event's OWN mark: its logo when it has one, and
               otherwise a monogram cut from its own name. A flat grey rectangle read as an
               image that had failed to load; this reads as the card it is. */
            <span
              aria-hidden
              className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-action/[0.14] via-muted to-action-end/[0.14]"
            >
              {logo ? (
                <Image
                  src={logo}
                  alt=""
                  width={96}
                  height={96}
                  className="size-16 rounded-md object-contain sm:size-20"
                />
              ) : (
                <span className="select-none text-fs-4xl font-bold tracking-[-0.04em] text-action/40">
                  {monogram}
                </span>
              )}
            </span>
          )}

        </div>

        {/* One body element, not a wrapper plus a body: `mt-auto` on the rail already pins it to
            the foot in both compositions, so the featured card needs no extra centring box. */}
        <div className="flex min-w-0 flex-1 flex-col p-4 sm:p-5">
        {/* ── Status and date, on one line ──────────────────────────────────────
               "Completed" is set as the smallest type on the card with a 12px accent rule in
               front of it, not as a badge. A filled pill here would be the loudest element in
               a section that is deliberately secondary to Upcoming Events. */}
        <div className="flex items-center justify-between gap-3">
          <span className="flex min-w-0 items-center gap-2">
            <span aria-hidden className="h-px w-3 shrink-0 bg-action" />
            <span className="truncate text-fs-2xs font-semibold uppercase tracking-[0.14em] text-accent-people-fg">
              {eventLifecycleMeta.completed.label}
            </span>
          </span>
          {finished && (
            <span className="shrink-0 text-fs-2xs font-semibold uppercase tracking-[0.14em] tabular-nums text-hero-ink">
              {shortDate(finished)}
            </span>
          )}
        </div>

        {/* ── The title: the strongest thing in the card, and the link to the event ──
               `line-clamp-2` rather than a longer clamp, because the four cards sit in one
               grid row and a three-line name on one of them drags the whole row taller. */}
        {/* mt-0.5 rather than mt-1 because the link below carries 2px of its own padding:
            together they keep the 4px optical gap the overline had, while the anchor itself
            clears the 24px minimum target size. A single-line title measured 21px without it. */}
        <h3 className="mt-3">
          <Link
            href={dest.details}
            className={cn(
              // 18px, except across the 3-up tablet band where the card is at its narrowest
              // (227px at 768) and an 18px name runs to two tall lines. The type tracks the
              // card's width, not the viewport's name for it.
              'line-clamp-2 rounded-sm py-0.5 text-fs-lg md:text-fs-md lg:text-fs-lg font-display font-normal tracking-[-0.01em] text-hero-ink',
              'transition-colors leading-snug hover:text-action',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-action focus-visible:ring-offset-2',
            )}
          >
            {event.name}
          </Link>
        </h3>

        {place && (
          <p className="mt-2.5 flex min-w-0 items-center gap-1.5 text-fs-sm text-hero-ink-soft">
            {/* -mt-px optically centres a 14px mark against a 13px cap-height. */}
            <MapPin className="-mt-px size-3.5 shrink-0 text-hero-accent-rule" strokeWidth={1.75} aria-hidden />
            <span className="truncate">{place}</span>
          </p>
        )}

        {/* ── The organizer's own words, clamped so one verbose event cannot set the height
               of the whole row. Absent entirely when the event has no tagline. ── */}
        {tagline && (
          <p className="mt-2 line-clamp-2 text-fs-sm leading-[1.5] text-hero-ink-soft">
            {tagline}
          </p>
        )}

        {/* ── The action rail ──────────────────────────────────────────────────
               `mt-auto` pins it to the foot, so cards of unequal copy length still share one
               rail baseline across a grid row. The negative inline margin pulls it out to the
               card's edges: the rail is a band across the bottom of the card, not a row inset
               inside the body's padding.

               ═══ ONE ROW NOW, WHERE IT USED TO BE TWO ════════════════════════
               This was a 2×2 block, on the reasoning that four across gives 72px a cell and
               "Certificates" needs ~80px at 13px — with shrinking the type ruled out.

               Re-measured in the browser rather than estimated, that label is 74px at 13px,
               68px at 12px and 62px at 11px. At the 11px overline token a cell needs 70px
               against the 72px available, so one row does fit — and the 11px token is one
               the card already uses for its status and category lines, not a size invented
               to squeeze this in. The layout table above carries the full arithmetic and the
               one band where it still folds.

               The prize is height: the second rail row was 60px of a 490px card, and losing
               it is most of why the card is now ~450px.

               The dividers are nth-child rules rather than `divide-x`: where the rail folds,
               `divide-x` puts a left border on the third cell, which starts a row. */}
        <div className="-mx-4 -mb-4 mt-auto pt-3.5 sm:-mx-5 sm:-mb-5">
          <div aria-hidden className="h-px w-full bg-border/70" />
          <nav
            aria-label={`Links for ${event.name}`}
            className={cn(
              // The rule colour lives on the container so each cell only declares WHICH
              // edges it draws, and the breakpoint overrides in RAIL_LAYOUT stay readable.
              // The band sits a shade below the card so it reads as the card's FOOTER; a
              // hovered cell lifts back to the card surface.
              'grid bg-muted/30 [&>a]:border-border/70',
              RAIL_LAYOUT[actions.length] ?? RAIL_LAYOUT[4],
            )}
          >
            {actions.map(a => (
              <Action key={a.label} {...a} />
            ))}
          </nav>
        </div>
        </div>
      </article>
    </div>
  )
}
