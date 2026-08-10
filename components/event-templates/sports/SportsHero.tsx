'use client'

// SportsHero — the premium Sports event hero (RD-ST5.0).
//
// Rebuilt to the ST5.0 mock. It no longer delegates to EventHeroFramework: the mock's
// composition (cinematic background, four metadata tiles, a full-width countdown card,
// an organiser block and a self-contained registration card) is sports-specific, and the
// brief scopes this sprint to the Sports hero only. EventHeroFramework stays exactly as
// it is for the generic templates (Meetup / Team Sports); the two share ONE clock via
// useEventClock so the countdown can never drift between them.
//
// What the previous hero got wrong, and what this fixes:
//   • the poster set the hero height (unbounded aspect) → it now lives INSIDE the
//     registration card at a fixed aspect, and the hero height is set by content;
//   • the left column ended early and left a tall gap beside the poster → the left column
//     now carries metadata → countdown → organiser, so both columns end together;
//   • the registration summary was scattered (price in a footer strip, CTA mid-column)
//     → one card owns price, deadline, scarcity, CTA, secondary actions and trust.
//
// EVERY value is event data. Nothing is invented; anything without a source is omitted
// rather than faked (see the sprint's Data Audit).

import { useState } from 'react'
import Link from 'next/link'
import { HashScrollLink } from '@/components/event-templates/shared/ui/HashScrollLink'
import { motion, useReducedMotion } from 'framer-motion'
import {
  Calendar, MapPin, Globe, Flag, Users, CalendarClock, ArrowRight, Share2,
  ShieldCheck, Zap, RotateCcw, BadgeCheck, Check,
} from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import {
  EVENT_CONTAINER, TYPE, CARD, EASE,
  GLASS_DARK, BRAND_GRADIENT, benefitIcon,
} from '@/components/event-templates/shared/ui/framework'
import { useEventClock, pad2 } from '@/components/event-templates/shared/hero/useEventClock'
import { HeroBackground, HeroCardGlow } from '@/components/event-templates/shared/hero/HeroBackground'
import { AddToCalendarButton } from '@/components/event-templates/shared/ui/AddToCalendarButton'
import { ImageLightbox } from '@/components/event-templates/shared/ui/ImageLightbox'
import {
  formatDate, formatDateShort, formatTime, formatINR, passDisplayPrice,
} from '@/components/event-templates/shared/utils/format'
import { buildEventBreadcrumbs } from '@/lib/events/breadcrumbs'
import { getTemplate } from '@/lib/events/templateRegistry'
import { Breadcrumbs } from '@/components/ui/Breadcrumbs'
import type { PassPublic } from '@/components/event-templates/types'
import type { PassAvailability } from '@/lib/registrations/types'
import type { OrganizerInfo, PhysicalVenueConfig } from '@/components/wizard/eventDetailsConfig'
import { Dialog } from '@/components/ui/Dialog'
import { HeroClampedText } from '@/components/event-templates/shared/hero/HeroClampedText'
import { rankPassBenefits, benefitCoverage } from '@/components/event-templates/shared/registration/passBenefits'

export interface SportsHeroProps {
  title:              string
  tagline?:           string
  /** info.shortDesc — the hero blurb, distinct from the About body. */
  shortDesc?:         string
  discipline?:        string
  edition?:           string
  /** media.coverBanner — the collectible poster, shown inside the registration card. */
  bannerUrl?:         string
  slug:               string
  startDate:          string
  startTime?:         string
  endDate?:           string
  endTime?:           string
  venueType:          'physical' | 'online' | 'hybrid'
  venueName:          string
  lifecycleStatus?:   string
  registrationOpen:   boolean
  isFreeEvent:        boolean
  passes:             PassPublic[]
  availability?:      Record<string, PassAvailability>
  organizer?:         OrganizerInfo | null
  hasRefundPolicy?:   boolean
  ctaLabel?:          string
  countdownLabel?:    string
  /** typeDetails.raceCategories[].distance */
  distances?:         string[]
  /** publicPage.showAttendeeCount — gates the registered-count stat. */
  showAttendeeCount?: boolean
  /** publicPage.showSocialLinks — gates the organiser link fallback. */
  showSocial?:        boolean
  /** venue.physical — structured address, so the venue tile can wrap on real
   *  boundaries instead of re-joining a pre-formatted string. */
  physical?:          PhysicalVenueConfig
}

// ─── Component ───────────────────────────────────────────────────────────────────

export function SportsHero(props: SportsHeroProps) {
  const {
    title, tagline, shortDesc, discipline, edition, bannerUrl, slug,
    startDate, startTime = '', endDate = '', endTime = '',
    venueType, venueName,
    lifecycleStatus, registrationOpen, isFreeEvent, passes, availability,
    organizer, hasRefundPolicy, ctaLabel, countdownLabel,
    distances, showAttendeeCount, showSocial, physical,
  } = props

  const reduce = useReducedMotion()
  const [posterOpen, setPosterOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const [addressOpen, setAddressOpen] = useState(false)
  const headingId = 'event-hero-title'

  const activePasses = passes.filter(p => p.status !== 'inactive')
  const canRegister  = registrationOpen && activePasses.length > 0

  // The pass that sets the "from" price — also the one whose scarcity/early-bird the
  // registration card describes, so the two can never disagree.
  const leadPass = activePasses.length
    ? activePasses.reduce((a, b) => (passDisplayPrice(a) <= passDisplayPrice(b) ? a : b))
    : undefined
  const minPrice   = leadPass ? passDisplayPrice(leadPass) : 0
  const isFree     = isFreeEvent || minPrice === 0
  const isEarlyBird = !!(leadPass?.earlyBirdEnabled
    && leadPass.effectivePrice != null
    && leadPass.effectivePrice < leadPass.price)
  const leadRemaining = leadPass && availability ? availability[leadPass.id]?.remaining ?? null : null
  const leadCapacity  = leadPass && availability ? availability[leadPass.id]?.passCapacity ?? null : null

  const salesCloseDate = activePasses
    .map(p => p.salesEndDate?.trim())
    .filter(Boolean)
    .sort()[0] as string | undefined

  // Gate the deadline row on the FORMATTED label, not the raw value: formatDateShort
  // returns '' for anything it cannot read, so an unparseable stored date omits the whole
  // row instead of rendering "Registration closes on " with nothing after it. A missing
  // salesEndDate was already omitted (the field is optional) and still is.
  const salesCloseLabel = salesCloseDate ? formatDateShort(salesCloseDate) : ''

  const clock = useEventClock({
    startDate, startTime, endDate,
    registrationOpen, salesCloseDate, lifecycleStatus,
    startLabel: countdownLabel,
  })
  const { cd, showTimer, heading, statusWord, srLabel } = clock

  // ── Venue ──
  // Built from the STRUCTURED address, not by re-joining a pre-formatted label.
  // `venueName` already contains the city (canonical venueLabel), so the old
  // `[venueName, city].join(', ')` rendered it twice — "KVK Std, Erode, Erode".
  const isOnline    = venueType === 'online'
  const venueTitle  = physical?.name?.trim() || (isOnline ? 'Online event' : venueName)
  // Address components, in the order a postal address reads.
  const addressParts = isOnline ? [] : [
    physical?.addressLine1?.trim(),
    physical?.addressLine2?.trim(),
    [physical?.city?.trim(), physical?.state?.trim()].filter(Boolean).join(', '),
    physical?.pincode?.trim(),
    physical?.country?.trim() && !['india', 'in'].includes(physical.country.trim().toLowerCase())
      ? physical.country.trim() : '',
  ].filter(Boolean) as string[]
  const addressLine = addressParts.join(', ')
  // Single-line form for the calendar payload (unchanged contract for that consumer).
  const whereLine = isOnline ? 'Online event' : [venueTitle, addressLine].filter(Boolean).join(', ')

  // ST5.5 item 4 — the organiser block's right side shows REAL metrics when they
  // exist, and falls back to the organiser's own links when they do not. It never
  // invents a participant number: no such field exists in the schema.
  const orgLinks = (showSocial === false ? [] : [
    organizer?.website?.trim()          && { label: 'Website',   href: organizer.website.trim() },
    organizer?.social?.instagram?.trim() && { label: 'Instagram', href: organizer.social.instagram.trim() },
    organizer?.social?.facebook?.trim()  && { label: 'Facebook',  href: organizer.social.facebook.trim() },
  ]).filter(Boolean) as { label: string; href: string }[]

  const distanceLine = (distances ?? []).map(d => d.trim()).filter(Boolean).join(' | ')

  // ST5.4 — the metadata row is AUTO | 1FR | AUTO, not equal columns. Fixed-content
  // items (date, distances, slots) hug their content; the VENUE is the only flexible
  // cell and absorbs the remaining width, which is what stops a long address from
  // collapsing into one word per line and from dictating the row's height.
  // `flex` carries each item's track behaviour; it only applies from lg, where the row
  // is a single line — below that the two-column grid still reads better.
  const dateLines = [startDate && formatDate(startDate), startTime && formatTime(startTime)]
    .filter(Boolean) as string[]

  const meta = [
    dateLines.length > 0 && {
      icon: Calendar, label: 'Date', lines: dateLines, flex: 'lg:shrink-0 lg:pr-8',
    },
    venueTitle && {
      icon: isOnline ? Globe : MapPin, label: 'Venue', lines: [venueTitle],
      venue: true, flex: 'lg:min-w-0 lg:flex-1 lg:pr-10',
    },
    distanceLine && {
      icon: Flag, label: 'Distances', lines: [distanceLine], flex: 'lg:shrink-0',
    },
  ].filter(Boolean) as {
    icon: typeof Calendar; label: string; lines: string[]; venue?: boolean; flex: string
  }[]

  const kicker = [discipline, edition].filter(Boolean).join(' · ') || undefined

  // "What's included" — derived from the passes the organiser actually configured:
  // every benefit across every active pass, de-duplicated, ranked by how many passes
  // offer it, top 5. Nothing is hardcoded; no benefits ⇒ the strip does not render.
  const perks = rankPassBenefits(activePasses, 5)

  const registeredCount = showAttendeeCount && availability
    ? activePasses.map(p => availability[p.id]).find(Boolean)?.eventTotalCount ?? 0
    : 0

  const TypeIcon = getTemplate('sports')?.icon
  const crumbs = buildEventBreadcrumbs('sports', title)
  const posterName = `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'event'}-poster`

  const onShare = async () => {
    if (typeof window === 'undefined') return
    const url = window.location.href
    try {
      if (navigator.share) { await navigator.share({ title, url }); return }
      await navigator.clipboard.writeText(url)
      setCopied(true); setTimeout(() => setCopied(false), 1800)
    } catch { /* dismissed */ }
  }

  const rise = (delay: number) => reduce
    ? {}
    : { initial: { opacity: 0, y: 14 }, animate: { opacity: 1, y: 0 },
        transition: { duration: 0.5, ease: EASE, delay } }

  const GHOST_BTN =
    'inline-flex h-10 flex-1 items-center justify-center gap-2 rounded-xl border border-border bg-card px-3 text-fs-sm font-semibold text-foreground transition-colors hover:border-foreground/30 hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40'

  const cdSegments = [
    { v: cd?.d, l: 'Days' }, { v: cd?.h, l: 'Hours' },
    { v: cd?.m, l: 'Minutes' }, { v: cd?.s, l: 'Seconds' },
  ]

  const trust = [
    { icon: ShieldCheck, title: 'Secure',  sub: 'Registration' },
    { icon: Zap,         title: 'Instant', sub: 'Confirmation' },
    hasRefundPolicy && { icon: RotateCcw, title: 'Refund', sub: 'Policy' },
  ].filter(Boolean) as { icon: typeof ShieldCheck; title: string; sub: string }[]

  return (
    <>
      {/* RD-ST5.1 — the hero is VIEWPORT-sized, never content-sized.
          `lg:min-h-[var(--hero-h)]` targets ~86% of the space left under the navbar, and
          `flex` + `justify-center` on the inner container makes the content settle in the
          middle of that box — so a short event never leaves a trough of whitespace and a
          rich one never pushes the CTA past the fold. Below lg the constraint is
          deliberately dropped: the layout stacks there, and forcing a stacked hero into
          one screen would shrink it past readability.
          RD-ST5.3 — the breadcrumb now lives INSIDE this section, on the same backdrop,
          so navbar → breadcrumb → hero reads as one continuous band with no white seam. */}
      <section
        aria-labelledby={headingId}
        className="sports-hero relative isolate flex flex-col overflow-hidden border-b border-border/60 lg:min-h-[var(--hero-h)]"
      >

        {/* ── Backdrop — RD-ST5.6: pure-CSS gradient field, no imagery ── */}
        <HeroBackground className="-z-10" />

        {/* Breadcrumb — inside the hero, sharing its backdrop (ST5.3 item 6). */}
        <div className={cn(EVENT_CONTAINER, 'pt-3')}>
          <Breadcrumbs items={crumbs} />
        </div>

        <div className={cn(EVENT_CONTAINER, 'flex flex-1 flex-col justify-center py-[var(--hero-py)]')}>
          {/* items-stretch + the left column's justify-between is what makes both
              columns finish on ONE baseline (ST5.3 item 1). */}
          <div className="grid items-stretch gap-[var(--hero-gap)] lg:grid-cols-12 lg:gap-10">

            {/* ══════════ LEFT · the story ══════════
                 justify-between distributes the blocks across whatever height the row
                 resolves to, so the last left row lands on the card's baseline instead
                 of finishing early or overshooting it (ST5.3 item 1). */}
            <div className="flex flex-col justify-between gap-[var(--hero-gap)] lg:col-span-7">

              {/* Status · discipline */}
              {(registrationOpen || kicker) && (
                <motion.div {...rise(0.04)} className="flex flex-wrap items-center gap-2.5">
                  {registrationOpen && (
                    <span className={cn('inline-flex items-center gap-2 rounded-full px-4 py-1.5 text-fs-sm font-bold text-white shadow-sm', BRAND_GRADIENT)}>
                      <span className="size-1.5 rounded-full bg-white" aria-hidden />
                      Registration Open
                    </span>
                  )}
                  {kicker && (
                    <span className="inline-flex items-center gap-2 rounded-full border border-border/70 bg-card px-4 py-1.5 text-fs-sm font-bold uppercase tracking-[0.14em] text-foreground shadow-sm">
                      {TypeIcon && <TypeIcon className="size-4 text-primary" aria-hidden />}
                      {kicker}
                    </span>
                  )}
                </motion.div>
              )}

              {/* Title · tagline */}
              <motion.div {...rise(0.1)} className="flex flex-col gap-1">
                <h1 id={headingId} className="text-[length:var(--hero-title)] font-extrabold leading-[0.98] tracking-[-0.03em] text-foreground">
                  {title}
                </h1>
                {tagline && (
                  <p className="text-[length:var(--hero-tagline)] font-semibold italic leading-tight tracking-[-0.01em] text-primary">
                    {tagline}
                  </p>
                )}
              </motion.div>

              {/* ST5.3 item 4 — the standalone "Verified Event / Official Organizer"
                  row is gone. Both signals now sit inline on the Hosted-by row, which
                  is where they belong and reclaims a whole block of vertical space. */}

              {/* Short description — clamped 4/3/2 lines (mobile/tablet/desktop) with a
                  reserved block height, so a 20-line description occupies exactly the
                  same space as a 2-line one and the ST5.1 viewport contract holds.
                  Overflow moves into a dialog; the same `shortDesc` string is used —
                  no second field, no duplicated data. */}
              {shortDesc?.trim() && (
                <motion.div {...rise(0.18)} className="max-w-xl">
                  <HeroClampedText
                    text={shortDesc}
                    clampClassName="line-clamp-4 md:line-clamp-3 lg:[-webkit-line-clamp:var(--hero-desc-lines)]"
                    className="whitespace-pre-line text-fs-md leading-relaxed text-foreground/80"
                    reserveClassName="lg:min-h-[var(--hero-desc-h)]"
                    triggerLabel="Read More"
                    dialogTitle={title}
                  />
                </motion.div>
              )}

              {/* ST5.4 — AUTO | 1FR | AUTO metadata row.
                  Equal columns were the bug: every cell got 1/4 of the width, so the
                  venue was starved into one-word-per-line AND, being the tallest cell,
                  it set the height of the whole row. Flex gives each cell the track it
                  needs — content-width for date/distances/slots, `flex-1 min-w-0` for
                  the venue — and because the venue absorbs the slack, Slots is pinned to
                  the far right regardless of address length. (No self-end/justify-self-end
                  needed; the 1fr cell does the anchoring.) Below lg the two-column grid
                  is kept — a single row cannot hold four cells on a phone. */}
              {meta.length > 0 && (
                <motion.div {...rise(0.22)}>
                  <dl className="grid grid-cols-2 gap-x-5 gap-y-[var(--hero-gap-tight)] lg:flex lg:items-start lg:gap-x-0">
                    {meta.map(m => (
                      <div key={m.label} className={cn('flex max-h-[72px] items-start gap-2.5', m.flex)}>
                        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                          <m.icon className="size-4" aria-hidden />
                        </span>
                        <div className="min-w-0">
                          <dt className={TYPE.label}>{m.label}</dt>
                          {m.venue ? (
                            <dd className="mt-0.5">
                              {/* Name ≤2 lines, wrapping on word boundaries (text-pretty)
                                  instead of one word per row. */}
                              <span className="line-clamp-2 text-pretty text-fs-sm font-bold leading-snug text-foreground">
                                {m.lines[0]}
                              </span>
                              {addressLine && (
                                <span className="flex min-w-0 items-baseline gap-1.5">
                                  <span className="min-w-0 truncate text-fs-2xs leading-snug text-muted-foreground">
                                    {addressLine}
                                  </span>
                                  <button
                                    type="button"
                                    onClick={() => setAddressOpen(true)}
                                    className="inline-flex shrink-0 items-center gap-0.5 text-fs-2xs font-semibold text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                                  >
                                    View Full Address
                                    <ArrowRight className="size-3" aria-hidden />
                                  </button>
                                </span>
                              )}
                            </dd>
                          ) : (
                            // Date renders as two compact lines (date over time); every
                            // other cell is a single clamped line.
                            <dd className="mt-0.5 text-fs-sm font-bold leading-snug text-foreground">
                              {m.lines.map(line => (
                                <span key={line} className="block truncate whitespace-nowrap">{line}</span>
                              ))}
                            </dd>
                          )}
                        </div>
                      </div>
                    ))}
                  </dl>
                </motion.div>
              )}

              {/* ST5.3 item 2 — compact countdown. The stacked "STARTS IN" header
                  (label + 12px gap ≈ 26px) moved INLINE to the left of the digits, the
                  card padding dropped and the digit token shrank: ~103px → ~62px, a 40%
                  reduction, with the digits still the loudest thing in the block. */}
              {(showTimer || statusWord) && (
                <motion.div
                  {...rise(0.26)}
                  className={cn('rounded-xl px-4 py-2 shadow-md lg:w-fit', GLASS_DARK)}
                  {...(showTimer ? { role: 'timer', 'aria-label': srLabel } : {})}
                >
                  {showTimer ? (
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
                      <p className="text-fs-2xs font-bold uppercase tracking-[0.14em] text-white/60">{heading}</p>
                      <div aria-hidden className="flex items-center gap-2 tabular-nums sm:gap-3">
                        {cdSegments.map(({ v, l }, i) => (
                          <div key={l} className="flex items-center gap-2 sm:gap-3">
                            {i > 0 && <span className="text-fs-md font-bold leading-none text-white/25">:</span>}
                            <div className="text-center">
                              <div className="text-[length:var(--hero-digit)] font-extrabold leading-none tracking-tight text-white">
                                {v == null ? '––' : pad2(v)}
                              </div>
                              <div className="mt-0.5 text-[9px] font-semibold uppercase tracking-[0.14em] text-white/50">{l}</div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <span className="inline-flex items-center gap-2 text-fs-md font-bold text-white">
                      {clock.phase === 'live' && !reduce && <span className="size-2 rounded-full bg-primary motion-safe:animate-pulse" aria-hidden />}
                      {statusWord}
                    </span>
                  )}
                </motion.div>
              )}

              {/* Hosted by — logo · "Hosted by" · name · Verified · Official Organizer
                  all on ONE inline row, the organiser's tagline on a single truncating
                  line beneath, and the stats block centred on the right. Everything is
                  vertically centred against the logo so nothing floats. */}
              {organizer?.name?.trim() && (
                <motion.div {...rise(0.3)} className="flex flex-wrap items-center justify-between gap-x-8 gap-y-[var(--hero-gap-tight)]">
                  <div className="flex min-w-0 items-center gap-3">
                    {organizer.logoUrl?.trim() ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={organizer.logoUrl}
                        alt={organizer.name}
                        loading="lazy"
                        decoding="async"
                        className="size-11 shrink-0 rounded-full border border-border/60 bg-white object-contain p-1 shadow-sm"
                      />
                    ) : (
                      <span className={cn('flex size-11 shrink-0 items-center justify-center rounded-full text-fs-md font-extrabold text-white shadow-sm', BRAND_GRADIENT)} aria-hidden>
                        {organizer.name.charAt(0).toUpperCase()}
                      </span>
                    )}
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-fs-sm leading-tight text-muted-foreground">
                        <span className="shrink-0">Hosted by</span>
                        <span className="truncate text-fs-md font-bold text-foreground">{organizer.name}</span>
                        {organizer.verified && (
                          <span className="inline-flex shrink-0 items-center gap-1 text-fs-2xs font-bold text-primary">
                            <BadgeCheck className="size-3.5" aria-hidden />Verified
                          </span>
                        )}
                        <span className="inline-flex shrink-0 items-center gap-1 text-fs-2xs font-bold text-primary">
                          <ShieldCheck className="size-3.5" aria-hidden />Official Organizer
                        </span>
                      </p>
                      {organizer.tagline?.trim() && (
                        <p className="mt-0.5 truncate text-fs-2xs leading-snug text-muted-foreground">{organizer.tagline}</p>
                      )}
                    </div>
                  </div>

                  {/* Right-hand stat block, vertically centred against the logo.
                      REAL figures only: the live registered count and the organiser's
                      hosted-event count. The mock's participant avatars and "10K+ last
                      season" have no field anywhere in the schema — reported in the ST5.0
                      Data Audit — so they are omitted rather than fabricated. */}
                  {(registeredCount > 0 || (organizer.eventsHosted ?? 0) > 0) ? (
                    <div className="flex shrink-0 items-center gap-6">
                      {registeredCount > 0 && (
                        <div className="text-right">
                          <p className="text-fs-lg font-extrabold leading-none text-foreground">
                            {registeredCount.toLocaleString('en-IN')}
                          </p>
                          <p className={cn('mt-0.5', TYPE.label)}>Registered</p>
                        </div>
                      )}
                      {(organizer.eventsHosted ?? 0) > 0 && (
                        <div className="text-right">
                          <p className="text-fs-lg font-extrabold leading-none text-foreground">
                            {organizer.eventsHosted!.toLocaleString('en-IN')}+
                          </p>
                          <p className={cn('mt-0.5', TYPE.label)}>Events hosted</p>
                        </div>
                      )}
                    </div>
                  ) : orgLinks.length > 0 ? (
                    // No real metric to show ⇒ the organiser's own links, not a made-up
                    // number. Renders nothing at all when neither exists.
                    <div className="flex shrink-0 items-center gap-4">
                      {orgLinks.map(l => (
                        <a
                          key={l.label}
                          href={l.href}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-fs-sm font-semibold text-foreground underline-offset-2 transition-colors hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                        >
                          {l.label}
                        </a>
                      ))}
                    </div>
                  ) : null}
                </motion.div>
              )}
            </div>

            {/* ══════════ RIGHT · registration card ══════════ */}
            <motion.div {...rise(0.16)} className="relative lg:col-span-5">
              {/* One soft brand radial behind the card — the only directional cue in
                  the background layer. The card's own surface paints over it, so only
                  a halo reads at the edges. */}
              <HeroCardGlow className="-z-10" />
              <div className={cn(CARD, 'relative flex h-full flex-col overflow-hidden shadow-xl shadow-slate-900/10')}>

                {/* Poster — fixed aspect, so it can never drive the hero's height */}
                <div className="p-2.5">
                  {bannerUrl?.trim() ? (
                    <button
                      type="button"
                      onClick={() => setPosterOpen(true)}
                      aria-label={`View ${title} poster full screen`}
                      className="group block w-full overflow-hidden rounded-xl bg-muted/40 outline-none focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-offset-2"
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={bannerUrl}
                        alt={`${title} event poster`}
                        fetchPriority="high"
                        decoding="async"
                        className="h-[var(--hero-poster-h)] w-full object-cover transition-transform duration-500 ease-out group-hover:scale-[1.03] motion-reduce:transform-none"
                      />
                    </button>
                  ) : (
                    <div className={cn('h-[var(--hero-poster-h)] w-full rounded-xl', BRAND_GRADIENT)} aria-hidden />
                  )}
                </div>

                <div className="flex flex-col gap-[var(--hero-gap-tight)] px-5 pb-[var(--hero-card-pad)] pt-3">

                  {/* Price */}
                  {canRegister && (
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className={TYPE.label}>{isFree ? 'Entry' : 'From'}</p>
                        <p className="mt-0.5 text-[length:var(--hero-price)] font-extrabold leading-none tracking-tight text-foreground">
                          {isFree ? 'Free' : formatINR(minPrice)}
                        </p>
                      </div>
                      {isEarlyBird && (
                        <span className="shrink-0 rounded-full bg-primary/10 px-3 py-1 text-fs-2xs font-bold text-primary">
                          Early Bird Offer
                        </span>
                      )}
                    </div>
                  )}

                  {/* Registration deadline */}
                  {canRegister && salesCloseLabel && (
                    <div className="flex items-center justify-between gap-3 border-t border-border/50 pt-4">
                      <span className="inline-flex items-center gap-2 text-fs-sm font-medium text-foreground">
                        <CalendarClock className="size-4 shrink-0 text-primary" aria-hidden />
                        Registration closes on {salesCloseLabel}
                      </span>
                      {clock.phase === 'closing' && (
                        <span className="shrink-0 rounded-full bg-amber-100 px-2.5 py-1 text-fs-2xs font-bold text-amber-800">
                          Hurry up!
                        </span>
                      )}
                    </div>
                  )}

                  {/* Scarcity for the lead pass */}
                  {canRegister && leadRemaining != null && leadCapacity != null && leadCapacity > 0 && (
                    <div className="rounded-xl bg-primary/5 px-4 py-3">
                      <p className="inline-flex items-center gap-2 text-fs-sm font-semibold text-foreground">
                        <Users className="size-4 shrink-0 text-primary" aria-hidden />
                        {leadRemaining.toLocaleString('en-IN')} spots left at this price
                      </p>
                      <div
                        className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-border"
                        role="progressbar"
                        aria-label="Spots remaining at this price"
                        aria-valuenow={leadRemaining}
                        aria-valuemin={0}
                        aria-valuemax={leadCapacity}
                      >
                        <div
                          className={cn('h-full rounded-full', BRAND_GRADIENT)}
                          style={{ width: `${Math.min(100, Math.round((leadRemaining / leadCapacity) * 100))}%` }}
                        />
                      </div>
                    </div>
                  )}

                  {/* Primary CTA */}
                  {canRegister ? (
                    <HashScrollLink
                      targetId="register"
                      className={cn(
                        'group inline-flex h-14 w-full items-center justify-center gap-2 rounded-xl text-fs-lg font-bold text-white shadow-md transition-transform duration-200 hover:-translate-y-0.5 active:translate-y-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-offset-2 motion-reduce:transform-none',
                        BRAND_GRADIENT,
                      )}
                    >
                      {ctaLabel ?? (isFreeEvent ? 'Register Free' : 'Register Now')}
                      <ArrowRight className="size-5 transition-transform group-hover:translate-x-1 motion-reduce:transform-none" aria-hidden />
                    </HashScrollLink>
                  ) : (
                    <span className="flex w-full items-center justify-center rounded-xl bg-muted py-3.5 text-fs-md font-semibold text-muted-foreground">
                      {statusWord || 'Registrations closed'}
                    </span>
                  )}

                  {/* Secondary actions */}
                  <div className="flex items-center gap-3">
                    {startDate && (
                      <AddToCalendarButton
                        title={title}
                        startDate={startDate}
                        endDate={endDate || startDate}
                        startTime={startTime}
                        endTime={endTime}
                        location={whereLine}
                        description={tagline ?? ''}
                        slug={slug}
                        label="Add to Calendar"
                        className={GHOST_BTN}
                      />
                    )}
                    <button type="button" onClick={onShare} className={GHOST_BTN}>
                      {copied ? <Check className="size-4 text-primary" aria-hidden /> : <Share2 className="size-4" aria-hidden />}
                      {copied ? 'Link copied' : 'Share Event'}
                    </button>
                  </div>
                </div>

                {/* Trust row */}
                {trust.length > 0 && (
                  <ul className="mt-auto grid grid-cols-3 gap-2 border-t border-border/50 bg-muted/30 px-5 py-3">
                    {trust.map(t => (
                      <li key={t.title} className="flex items-center gap-2">
                        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                          <t.icon className="size-4" aria-hidden />
                        </span>
                        <span className="min-w-0">
                          <span className="block truncate text-fs-2xs font-bold text-foreground">{t.title}</span>
                          <span className="block truncate text-fs-2xs text-muted-foreground">{t.sub}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </motion.div>
          </div>

          {/* ══════════ What's included — ranked from the passes' own benefits ══════
               Icon comes from the framework's benefitIcon() label matcher; the sub-line
               states real coverage (how many passes include it). No static list. */}
          {perks.length > 0 && (
            <motion.div {...rise(0.34)} className={cn(CARD, 'mt-[var(--hero-gap)] grid gap-x-5 gap-y-2.5 px-3.5 py-2.5 sm:grid-cols-2 lg:grid-cols-5')}>
              {perks.map(p => {
                const Icon = benefitIcon(p.label)
                return (
                  <div key={p.label} className="flex items-center gap-3.5">
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                      <Icon className="size-4" aria-hidden />
                    </span>
                    <div className="min-w-0">
                      <p className="truncate text-fs-sm font-semibold leading-snug text-foreground">{p.label}</p>
                      <p className="truncate text-fs-2xs leading-snug text-muted-foreground">{benefitCoverage(p)}</p>
                    </div>
                  </div>
                )
              })}
            </motion.div>
          )}
        </div>

        <Dialog open={addressOpen} onClose={() => setAddressOpen(false)} title="Venue address" size="sm">
          <address className="not-italic">
            <p className="text-fs-md font-bold text-foreground">{venueTitle}</p>
            <div className="mt-2 space-y-0.5 text-fs-base leading-relaxed text-muted-foreground">
              {addressParts.map(part => <p key={part}>{part}</p>)}
            </div>
          </address>
        </Dialog>

        {bannerUrl?.trim() && (
          <ImageLightbox
            open={posterOpen}
            src={bannerUrl}
            alt={`${title} event poster`}
            onClose={() => setPosterOpen(false)}
            downloadHref={bannerUrl}
            downloadName={posterName}
          />
        )}
      </section>
    </>
  )
}
