'use client'

// SportsHero — the premium Sports event hero (RD-ST6.0 · editorial rebuild).
//
// RD-ST6.0 is a VISUAL-ONLY pass over ST5.x. Every value, every data binding, every
// handler and every href is carried over verbatim; what changed is the composition.
//
// What ST5.x looked like, and why it read as generic:
//   • FIVE competing surfaces — registration card, dark glass countdown pill, tinted
//     scarcity box, perks card, and eight tinted icon tiles — so nothing outranked
//     anything else and the page read as a SaaS dashboard rather than a race.
//   • The poster was a 5rem–12rem letterbox inside the card: an event's single most
//     cinematic asset, rendered as a thumbnail.
//   • The organiser sat LAST in the left column, below the countdown, so the trust
//     signal a runner looks for first was the last thing they reached.
//
// ST6.0 composition — typography, image, whitespace and hairlines, ONE card:
//
//   Organiser  → identity first, at the top, at real scale.
//   Status     → a tracked line, not a filled pill.
//   Title      → the loudest object on the page; tagline as an editorial subtitle.
//   Image      → cinematic. Fills the right column's height on lg (flex-1, so it still
//                cannot drive the hero's height), 16:10 below it.
//   Rail       → date · venue · distances · closes, as labelled columns split by
//                hairlines. No tiles, no boxes.
//   Countdown  → bare digits on the backdrop at ~2× the old size. No glass pill.
//   Register   → the ONE elevated surface in the hero: price, CTA, calendar, share.
//   Included   → trust signals and the passes' own benefits as one horizontal strip
//                under a hairline, replacing the trust row + perks card.
//
// Ordering: the hero is a single grid whose two column wrappers are `display: contents`
// below lg, so every block is a direct grid item there and `order-*` can express the
// mobile reading order (organiser → status → title → image → info → countdown → price
// → benefits) without duplicating markup. From lg the wrappers become real flex columns
// and source order takes over.
//
// RD-ST6.1 / 6.2 are MOBILE-ONLY passes on top of ST6.0. ST6.2 rebuilt the phone
// composition for conversion: the CTA moved from ~1400px down to ~870px by reordering
// (price + Register Now now follow Date/Venue directly) and by compacting every block
// above it — one-line breadcrumb, 16:10 image, an inline label+value rail instead of
// stacked label-over-value cells, and a 16px block rhythm. The organiser left the top
// of the page and joined the countdown in ONE section below the CTA; see the section
// itself for why that needed three order tiers.
//
// Every change below is scoped to
// base (phone) classes with an `lg:` reset, or to the `max-width: 639.98px` token tier
// in styles/tokens.css — nothing at 1024 / 1280 / 1440 moves. See the mobile tier there
// for why the type scale is overridden by media query rather than by raising a clamp
// floor (1280×800 already resolves --hero-price below any floor worth setting).
//
// Unchanged by contract: the props interface, useEventClock, the lead-pass/price
// derivation, availability + scarcity, salesClose gating, rankPassBenefits, the share
// and calendar handlers, the poster lightbox, the address dialog and the HashScrollLink
// registration target. EVERY value is still event data; anything without a source is
// omitted rather than faked.

import { useState } from 'react'
import { HashScrollLink } from '@/components/event-templates/shared/ui/HashScrollLink'
import { motion, useReducedMotion } from 'framer-motion'
import {
  Calendar, MapPin, Globe, Flag, Users, CalendarClock, ArrowRight, Share2,
  ShieldCheck, Zap, RotateCcw, BadgeCheck, Check, Expand,
} from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import {
  EVENT_CONTAINER, TYPE, EASE, BRAND_GRADIENT, benefitIcon,
} from '@/components/event-templates/shared/ui/framework'
import { useEventClock, pad2 } from '@/components/event-templates/shared/hero/useEventClock'
import { HeroBackground, HeroCardGlow } from '@/components/event-templates/shared/hero/HeroBackground'
import { AddToCalendarButton } from '@/components/event-templates/shared/ui/AddToCalendarButton'
import Image from 'next/image'
import { isValidImageUrl } from '@/lib/utils/imageUrl'
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
  /** media.coverBanner — the event's cinematic image. */
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
  /** venue.physical — structured address, so the venue column can wrap on real
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
  // registration surface describes, so the two can never disagree.
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

  // Gate the deadline on the FORMATTED label, not the raw value: formatDateShort
  // returns '' for anything it cannot read, so an unparseable stored date omits the
  // whole column instead of rendering a label with nothing after it.
  const salesCloseLabel = salesCloseDate ? formatDateShort(salesCloseDate) : ''

  const clock = useEventClock({
    startDate, startTime, endDate,
    registrationOpen, salesCloseDate, lifecycleStatus,
    startLabel: countdownLabel,
  })
  const { cd, showTimer, heading, statusWord, srLabel } = clock

  // ── Venue ──
  // Built from the STRUCTURED address, not by re-joining a pre-formatted label.
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

  // The organiser block shows REAL metrics when they exist, and falls back to the
  // organiser's own links when they do not. It never invents a participant number:
  // no such field exists in the schema.
  const orgLinks = (showSocial === false ? [] : [
    organizer?.website?.trim()          && { label: 'Website',   href: organizer.website.trim() },
    organizer?.social?.instagram?.trim() && { label: 'Instagram', href: organizer.social.instagram.trim() },
    organizer?.social?.facebook?.trim()  && { label: 'Facebook',  href: organizer.social.facebook.trim() },
  ]).filter(Boolean) as { label: string; href: string }[]

  const distanceLine = (distances ?? []).map(d => d.trim()).filter(Boolean).join('  ·  ')

  const dateLines = [startDate && formatDate(startDate), startTime && formatTime(startTime)]
    .filter(Boolean) as string[]

  // ── The editorial rail ──
  // Four labelled columns split by hairlines rather than four cards.
  //
  // A SIX-track grid, not a flex row. A flex row where every cell but the venue hugged
  // its content starved the venue to one character per line at 1024 (the left column is
  // only ~590px there); equal tracks then truncated the date ("Thu, 15 October …") even
  // at 1440. Six tracks with the two long cells — date and venue — spanning two each
  // gives every value the width it actually needs at every breakpoint, and the values
  // wrap rather than truncate so a date is never cut off.
  //
  // RD-ST6.1 — below sm the six tracks collapse to TWO, and the two long cells go full
  // width with a hairline under each: Date & Time / Venue each own a row, then Distances
  // and Registration closes share one. A 2×2 grid of ~155px cells was the cramped
  // desktop-column look the mobile brief calls out; this is the stacked reading order it
  // asks for. Everything from sm up is untouched.
  const rail = [
    dateLines.length > 0 && {
      key: 'date', icon: Calendar, label: 'Date & Time', lines: dateLines,
      span: 'lg:col-span-2',
    },
    venueTitle && {
      key: 'venue', icon: isOnline ? Globe : MapPin, label: 'Venue', lines: [venueTitle],
      venue: true, span: 'lg:col-span-2',
    },
    distanceLine && {
      key: 'distances', icon: Flag, label: 'Distances', lines: [distanceLine], span: '',
    },
    canRegister && salesCloseLabel && {
      // `shortLabel` is a mobile-only rendering of the SAME label. "Registration closes"
      // needs ~165px of tracked caps and the half-width mobile cell is ~152px, so it
      // wrapped to two lines and pushed its date out of line with the Distances value
      // beside it. Presentational only — the desktop label is unchanged.
      key: 'closes', icon: CalendarClock, label: 'Registration closes', shortLabel: 'Closes',
      lines: [salesCloseLabel],
      closing: clock.phase === 'closing', span: '',
    },
  ].filter(Boolean) as {
    key: string; icon: typeof Calendar; label: string; shortLabel?: string; lines: string[]
    venue?: boolean; closing?: boolean; span: string
  }[]

  const kicker = [discipline, edition].filter(Boolean).join(' · ') || undefined

  // "What's included" — derived from the passes the organiser actually configured:
  // every benefit across every active pass, de-duplicated, ranked by how many passes
  // offer it, top 5. Nothing is hardcoded; no benefits ⇒ those entries do not render.
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
    'inline-flex h-11 flex-1 items-center justify-center gap-2 rounded-xl border border-border/80 bg-transparent px-3 text-fs-sm font-semibold text-foreground transition-colors hover:border-foreground/30 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40'

  // Gates for the combined organiser + countdown section. `hasClock` keeps the exact
  // condition the countdown already used — the terminal word only shows while
  // registration is open, because the CTA slot states it otherwise.
  const hasOrganizer = !!organizer?.name?.trim()
  const hasClock     = showTimer || !!(statusWord && canRegister)

  const cdSegments = [
    { v: cd?.d, l: 'Days' }, { v: cd?.h, l: 'Hours' },
    { v: cd?.m, l: 'Min' }, { v: cd?.s, l: 'Sec' },
  ]

  // The horizontal trust strip: platform guarantees first, then the passes' own
  // benefits. Both were separate surfaces before (a trust row inside the card and a
  // perks card below the grid) — one strip, one hairline.
  const included = [
    { key: 't-secure',  icon: ShieldCheck, label: 'Secure Registration',  note: '' },
    { key: 't-instant', icon: Zap,         label: 'Instant Confirmation', note: '' },
    ...(hasRefundPolicy ? [{ key: 't-refund', icon: RotateCcw, label: 'Refund Policy', note: '' }] : []),
    ...perks.map(p => ({ key: `p-${p.label}`, icon: benefitIcon(p.label), label: p.label, note: benefitCoverage(p) })),
  ]

  return (
    <>
      {/* The hero is VIEWPORT-sized, never content-sized: `lg:min-h-[var(--hero-h)]`
          targets ~86% of the space under the navbar and the inner container centres
          its content in that box. Below lg the constraint is dropped — the layout
          stacks there, and forcing a stacked hero into one screen would shrink it past
          readability. The breadcrumb lives INSIDE this section, on the same backdrop,
          so navbar → breadcrumb → hero reads as one continuous band. */}
      <section
        aria-labelledby={headingId}
        className="sports-hero relative isolate flex flex-col overflow-hidden border-b border-border/60 lg:min-h-[var(--hero-h)]"
      >

        {/* ── Backdrop — pure-CSS gradient field, no imagery ── */}
        <HeroBackground className="-z-10" />

        <div className={cn(EVENT_CONTAINER, 'pt-3', 'max-lg:[&_ol]:flex-nowrap max-lg:[&_ol]:overflow-hidden max-lg:[&_[aria-current]]:max-w-[8.5rem]')}>
          <Breadcrumbs items={crumbs} />
        </div>

        <div className={cn(EVENT_CONTAINER, 'flex flex-1 flex-col justify-center py-[var(--hero-py)]')}>

          {/* ONE grid. Below lg the two column wrappers are `display: contents`, so
              every block below is a direct grid item and `order-*` expresses the
              mobile reading order. From lg the wrappers become flex columns. */}
          <div className="grid grid-cols-1 gap-y-[var(--hero-gap)] lg:grid-cols-12 lg:items-stretch lg:gap-x-12 lg:gap-y-0">

            {/* ══════════ LEFT · the story ══════════ */}
            <div className="contents lg:col-span-7 lg:flex lg:flex-col lg:justify-between lg:gap-[var(--hero-gap)]">


              {/* ── 2 · STATUS — a tracked line, not a filled pill ────────────── */}
              {(registrationOpen || kicker) && (
                <motion.div {...rise(0.08)} className="order-1 flex flex-wrap items-center gap-x-3 gap-y-1.5">
                  {registrationOpen && (
                    <span className="inline-flex items-center gap-2 text-fs-xs font-bold uppercase tracking-[0.18em] text-primary lg:text-fs-2xs">
                      <span className="relative flex size-2 shrink-0" aria-hidden>
                        <span className="absolute inline-flex size-full rounded-full bg-primary/50 motion-safe:animate-ping" />
                        <span className="relative inline-flex size-2 rounded-full bg-primary" />
                      </span>
                      Registration Open
                    </span>
                  )}
                  {registrationOpen && kicker && (
                    <span className="size-1 rounded-full bg-border" aria-hidden />
                  )}
                  {kicker && (
                    <span className="inline-flex items-center gap-1.5 text-fs-xs font-bold uppercase tracking-[0.18em] text-muted-foreground lg:text-fs-2xs">
                      {TypeIcon && <TypeIcon className="size-3.5 shrink-0" aria-hidden />}
                      {kicker}
                    </span>
                  )}
                </motion.div>
              )}

              {/* ── 3 · TITLE — the loudest object in the hero ────────────────── */}
              <motion.div {...rise(0.12)} className="order-2 flex flex-col gap-1.5 lg:gap-2">
                {/* `break-words` is the mobile overflow guard: an unbroken 20-character
                    event name at 44px has no wrap opportunity on a 360px screen and
                    would push the page sideways. It only engages when a single word
                    cannot fit, so normal titles still wrap on spaces. */}
                <h1
                  id={headingId}
                  className="text-balance break-words text-[length:var(--hero-title)] font-extrabold leading-[0.95] tracking-[-0.035em] text-foreground"
                >
                  {title}
                </h1>
                {tagline && (
                  <p className="text-[length:var(--hero-tagline)] font-bold uppercase leading-tight tracking-[0.06em] text-primary">
                    {tagline}
                  </p>
                )}
              </motion.div>

              {/* ── 5 · SHORT DESCRIPTION ─────────────────────────────────────── */}
              {shortDesc?.trim() && (
                <motion.div {...rise(0.2)} className="order-7 max-w-xl lg:order-5">
                  <HeroClampedText
                    text={shortDesc}
                    clampClassName="line-clamp-3 lg:[-webkit-line-clamp:var(--hero-desc-lines)]"
                    className="whitespace-pre-line text-fs-md leading-relaxed text-foreground/75"
                    reserveClassName="lg:min-h-[var(--hero-desc-h)]"
                    triggerLabel="Read More"
                    dialogTitle={title}
                  />
                </motion.div>
              )}

              {/* ── 6 · THE RAIL — labelled columns split by hairlines ────────── */}
              {rail.length > 0 && (
                <motion.div {...rise(0.24)} className="order-4">
                  <dl className="grid grid-cols-1 divide-y divide-border/50 border-y border-border/60 lg:grid-cols-6 lg:gap-x-0 lg:gap-y-5 lg:divide-x lg:divide-y-0 lg:divide-border/60 lg:py-5">
                    {rail.map(item => (
                      <div key={item.key} className={cn('flex min-w-0 items-baseline gap-3 py-2 lg:block lg:py-0 lg:px-4 lg:first:pl-0 lg:last:pr-0', item.span)}>
                        <dt className={cn(TYPE.label, 'flex w-[6.5rem] shrink-0 items-center gap-1.5 lg:w-auto')}>
                          <item.icon className="size-3.5 shrink-0 text-primary" aria-hidden />
                          {item.shortLabel ? (
                            <>
                              <span className="lg:hidden">{item.shortLabel}</span>
                              <span className="hidden lg:inline">{item.label}</span>
                            </>
                          ) : item.label}
                        </dt>
                        {item.venue ? (
                          <dd className="min-w-0 lg:mt-1.5">
                            <span className="line-clamp-2 text-pretty text-fs-sm font-bold leading-snug text-foreground">
                              {item.lines[0]}
                            </span>
                            {addressLine && (
                              // `max-lg:flex-nowrap` — full width below sm, so the address
                              // truncates on ONE line beside its disclosure link instead of
                              // pushing the link to a second row. From sm the cell is narrow
                              // again and the original wrapping behaviour is kept.
                              <span className="mt-0.5 flex min-w-0 flex-wrap items-baseline gap-x-1.5 max-lg:flex-nowrap">
                                <span className="min-w-0 truncate text-fs-2xs leading-snug text-muted-foreground">
                                  {addressLine}
                                </span>
                                <button
                                  type="button"
                                  onClick={() => setAddressOpen(true)}
                                  className="inline-flex shrink-0 items-center gap-0.5 text-fs-2xs font-semibold text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                                >
                                  Full address
                                  <ArrowRight className="size-3" aria-hidden />
                                </button>
                              </span>
                            )}
                          </dd>
                        ) : (
                          <dd className="min-w-0 text-fs-sm font-bold leading-snug text-foreground lg:mt-1.5">
                            {item.lines.map(line => (
                              <span key={line} className="block text-pretty">{line}</span>
                            ))}
                            {item.closing && (
                              <span className="mt-0.5 block text-fs-2xs font-bold uppercase tracking-[0.14em] text-amber-700">
                                Closing soon
                              </span>
                            )}
                          </dd>
                        )}
                      </div>
                    ))}
                  </dl>
                </motion.div>
              )}

              {/* ══ RD-ST6.3 · ORGANISER + STARTS IN — ONE section, EVERY viewport ══
                   The organiser and the countdown share a single surface at every width:
                   organiser left, countdown right from 375px, stacked at ≤374px where the
                   organiser column would drop under ~125px and start clipping longer names.

                   RD-ST6.4 — it lives in the LEFT COLUMN and stays a real card at every
                   width, so its width is always the left column's width and it can never
                   cross into the poster/registration column.

                   The two orders it needs are not the same, and that is the whole trick:

                     base (≤1023) — one grid column, both wrappers are `contents`, so ALL
                       blocks are grid items and order sorts across them. `order-6` lands
                       the card between the registration surface (order-5, right wrapper)
                       and the description (order-7).
                     lg (1024+) — the left wrapper is a real flex column. The card keeps
                       order-6 and the description takes `lg:order-5`, which flips the two
                       so the column reads status → title → rail → description → card.

                   Two earlier attempts are worth not repeating: ST6.2 dissolved the card
                   at lg with `lg:contents` (which let an independent `lg:order-1` put the
                   organiser back at the top), and ST6.3 made it a grid child with
                   `lg:col-span-12` (which spanned it across BOTH columns). Neither is what
                   the design calls for. Throughout, there is exactly ONE organiser
                   rendering — this block has only ever moved, never been duplicated. */}
              {(hasOrganizer || hasClock) && (
                <div className="order-6 flex flex-col gap-4 rounded-2xl border border-border/60 bg-muted/25 p-4 min-[375px]:flex-row min-[375px]:items-center min-[375px]:justify-between min-[375px]:gap-5">

              {/* ── ORGANISER ─────────────────────────────────────────────────── */}
              {organizer?.name?.trim() && (
                <motion.div {...rise(0.04)} className="flex min-w-0 flex-wrap items-center justify-between gap-x-8 gap-y-2 min-[375px]:flex-1 lg:gap-y-4">
                  <div className="flex min-w-0 items-center gap-3.5">
                    {organizer.logoUrl?.trim() ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={organizer.logoUrl}
                        alt={organizer.name}
                        loading="lazy"
                        decoding="async"
                        className="size-14 shrink-0 rounded-2xl bg-white object-contain p-1.5 shadow-sm ring-1 ring-border/70"
                      />
                    ) : (
                      <span className={cn('flex size-14 shrink-0 items-center justify-center rounded-2xl text-fs-lg font-extrabold text-white shadow-sm', BRAND_GRADIENT)} aria-hidden>
                        {organizer.name.charAt(0).toUpperCase()}
                      </span>
                    )}
                    <div className="min-w-0">
                      <p className={TYPE.label}>Organized by</p>
                      {/* RD-ST6.5 — the organiser name WRAPS, it never ellipsises.
                          This span used to carry `truncate`, which is white-space:nowrap
                          plus text-overflow:ellipsis: any name wider than the column was
                          cut to "UDHAYAM FOUNDATI…" and no amount of vertical room in the
                          card could rescue it, because nowrap forbade a second line.
                          `line-clamp-2` wraps instead and caps at two lines, `min-w-0`
                          lets it shrink inside this flex row, and `break-words` covers a
                          single unbreakable word. Organiser names are free text, so this
                          has to hold for any string, not just the ones that fit today. */}
                      <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5">
                        <span className="line-clamp-2 min-w-0 break-words text-fs-lg font-extrabold leading-tight tracking-[-0.01em] text-foreground">
                          {organizer.name}
                        </span>
                        {organizer.verified && (
                          <span className="inline-flex shrink-0 items-center gap-1 text-fs-2xs font-bold text-primary">
                            <BadgeCheck className="size-3.5" aria-hidden />Verified
                          </span>
                        )}
                      </p>
                      <p className="mt-0.5 inline-flex items-center gap-1.5 text-fs-2xs font-semibold text-muted-foreground">
                        <ShieldCheck className="size-3.5 shrink-0 text-primary" aria-hidden />
                        Official Organizer
                      </p>
                      {organizer.tagline?.trim() && (
                        <p className="mt-1 truncate text-fs-2xs leading-snug text-muted-foreground max-lg:whitespace-normal max-lg:line-clamp-2">{organizer.tagline}</p>
                      )}
                    </div>
                  </div>

                  {/* REAL figures only — the live registered count and the organiser's
                      hosted-event count. No field exists for anything else, so nothing
                      else is shown; links stand in when neither figure exists. */}
                  {(registeredCount > 0 || (organizer.eventsHosted ?? 0) > 0) ? (
                    // `text-left lg:text-right`: below sm this block wraps onto its own
                    // line at flex-start, where right-aligned figures read as orphaned.
                    <div className="flex shrink-0 items-center divide-x divide-border/70 text-left lg:text-right">
                      {registeredCount > 0 && (
                        <div className="flex items-baseline gap-1.5 pr-6 last:pr-0 lg:block">
                          <p className="text-fs-lg font-extrabold leading-none text-foreground">
                            {registeredCount.toLocaleString('en-IN')}
                          </p>
                          <p className={cn('lg:mt-1', TYPE.label)}>Registered</p>
                        </div>
                      )}
                      {(organizer.eventsHosted ?? 0) > 0 && (
                        <div className="flex items-baseline gap-1.5 pl-6 first:pl-0 lg:block">
                          <p className="text-fs-lg font-extrabold leading-none text-foreground">
                            {organizer.eventsHosted!.toLocaleString('en-IN')}+
                          </p>
                          <p className={cn('lg:mt-1', TYPE.label)}>Events hosted</p>
                        </div>
                      )}
                    </div>
                  ) : orgLinks.length > 0 ? (
                    <div className="flex shrink-0 items-center gap-5">
                      {orgLinks.map(l => (
                        <a
                          key={l.label}
                          href={l.href}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-fs-sm font-semibold text-foreground underline-offset-4 transition-colors hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                        >
                          {l.label}
                        </a>
                      ))}
                    </div>
                  ) : null}
                </motion.div>
              )}

              {/* ── STARTS IN — bare digits, no glass pill ───────────────────────
                   The terminal word is shown here only while registration is still
                   open (e.g. "Happening now" beside a live Register CTA). Once it is
                   closed the CTA slot already states it, and ST5.x printed the same
                   sentence twice — visible de-duplication, not a content change.

                   RD-ST6.2 — the segments become a 2×2 grid from 375px. Four across is
                   ~175px wide, which would leave the organiser ~120px of a 311px row at
                   375 — not enough for its name once the 56px logo is subtracted. 2×2 is
                   ~90px, which buys the organiser back ~85px. Below 375 the section is
                   stacked, so the full-width four-across row is used again, and `lg:flex`
                   restores the approved tablet/desktop row verbatim. */}
              {hasClock && (
                <motion.div
                  {...rise(0.28)}
                  className="shrink-0 min-[375px]:border-l min-[375px]:border-border/60 min-[375px]:pl-5"
                  {...(showTimer ? { role: 'timer', 'aria-label': srLabel } : {})}
                >
                  {showTimer ? (
                    <div>
                      <p className={TYPE.label}>{heading}</p>
                      <div
                        aria-hidden
                        className="mt-2 flex items-end gap-4 tabular-nums min-[375px]:grid min-[375px]:grid-cols-2 min-[375px]:gap-x-4 min-[375px]:gap-y-1.5 xl:flex xl:items-end"
                      >
                        {cdSegments.map(({ v, l }, i) => (
                          <div key={l} className="flex items-end gap-4">
                            {i > 0 && (
                              <span className="h-8 w-px shrink-0 self-center bg-border/70 min-[375px]:hidden xl:block" aria-hidden />
                            )}
                            <div>
                              <div className="text-[length:var(--hero-digit)] font-extrabold leading-none tracking-[-0.04em] text-foreground">
                                {v == null ? '––' : pad2(v)}
                              </div>
                              <div className="mt-1.5 text-[10px] font-bold uppercase tracking-[0.18em] text-muted-foreground max-lg:tracking-[0.08em]">{l}</div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <span className="inline-flex items-center gap-2 text-fs-md font-bold text-foreground">
                      {clock.phase === 'live' && !reduce && <span className="size-2 rounded-full bg-primary motion-safe:animate-pulse" aria-hidden />}
                      {statusWord}
                    </span>
                  )}
                </motion.div>
              )}
                </div>
              )}

            </div>

            {/* ══════════ RIGHT · image + the one registration surface ══════════ */}
            <div className="contents lg:col-span-5 lg:flex lg:flex-col lg:gap-[var(--hero-gap)]">

              {/* ── 4 · CINEMATIC IMAGE ───────────────────────────────────────
                   `lg:flex-1 lg:min-h-0` lets it absorb the column's spare height so
                   both columns finish on one baseline — and, being a flex child of a
                   height-bounded column, it still cannot drive the hero's height.

                   RD-ST6.1 — the frame is 4:3 below sm and 16:10 from sm. Event posters
                   are usually portrait, so the widest ratio crops them hardest exactly
                   where the image has the least room to begin with. RD-ST6.2 settled on 16:10 for the whole
                   compact tier: it keeps the CTA a short scroll away. `lg:` and `lg:` are untouched, so tablet and desktop
                   render exactly as approved. */}
              <motion.div {...rise(0.16)} className="order-3 lg:order-none lg:flex lg:min-h-0 lg:flex-1">
                {bannerUrl?.trim() ? (
                  <button
                    type="button"
                    onClick={() => setPosterOpen(true)}
                    aria-label={`View ${title} poster full screen`}
                    className="group relative block aspect-[16/10] w-full overflow-hidden rounded-3xl bg-muted/40 shadow-2xl shadow-slate-900/15 ring-1 ring-black/5 outline-none focus-visible:ring-2 focus-visible:ring-primary/60 focus-visible:ring-offset-2 md:aspect-[2/1] lg:aspect-auto lg:min-h-[16rem] lg:flex-1"
                  >
                    {/* ABSOLUTE, not in flow. `h-full` against an auto-height parent
                        resolves to auto, so an in-flow <img> would size the frame to the
                        uploaded poster's own aspect — a 4:5 poster made the frame 598px
                        tall at 1440 and pushed the whole hero past the viewport contract.
                        Taking it out of flow lets the frame own its height and the image
                        crop into it. */}
                    {/* The poster is the LCP element. Through next/image it is format-
                        converted and resized per breakpoint; the raw original is a full-
                        resolution JPEG that mobile has no use for.

                        `fill` reproduces the previous `absolute inset-0 size-full` exactly
                        (the parent button is `relative`), so the out-of-flow behaviour the
                        comment above depends on is unchanged.

                        `preload`, NOT `priority`: Next.js 16 deprecated `priority` in favour
                        of `preload` (node_modules/next/dist/docs/…/02-components/image.md).

                        GUARD: bannerUrl is organiser-supplied and is NOT validated upstream —
                        it can be a data: URI or an off-allow-list host, either of which makes
                        next/image throw and would 500 the entire event page. isValidImageUrl
                        is this repo's documented predicate for "safe to hand to next/Image",
                        so anything it rejects keeps the original raw <img> path. */}
                    {isValidImageUrl(bannerUrl) ? (
                      <Image
                        src={bannerUrl}
                        alt={`${title} event poster`}
                        fill
                        preload
                        sizes="(max-width: 1023px) 100vw, 42vw"
                        className="object-cover transition-transform duration-700 ease-out group-hover:scale-[1.04] motion-reduce:transform-none"
                      />
                    ) : (
                      /* eslint-disable-next-line @next/next/no-img-element */
                      <img
                        src={bannerUrl}
                        alt={`${title} event poster`}
                        fetchPriority="high"
                        decoding="async"
                        className="absolute inset-0 size-full object-cover transition-transform duration-700 ease-out group-hover:scale-[1.04] motion-reduce:transform-none"
                      />
                    )}
                    {/* Scrim — anchors the image and lifts the affordance off it. */}
                    <span
                      aria-hidden
                      className="pointer-events-none absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-slate-950/45 to-transparent"
                    />
                    <span
                      aria-hidden
                      className="pointer-events-none absolute bottom-4 right-4 inline-flex size-9 items-center justify-center rounded-full bg-white/85 text-slate-900 opacity-0 shadow-md backdrop-blur-sm transition-opacity duration-200 group-hover:opacity-100 group-focus-visible:opacity-100"
                    >
                      <Expand className="size-4" />
                    </span>
                  </button>
                ) : (
                  <div
                    className={cn('aspect-[16/10] w-full rounded-3xl shadow-2xl shadow-slate-900/15 md:aspect-[2/1] lg:aspect-auto lg:min-h-[16rem] lg:flex-1', BRAND_GRADIENT)}
                    aria-hidden
                  />
                )}
              </motion.div>

              {/* ── 8 · THE ONE REGISTRATION SURFACE ──────────────────────────── */}
              <motion.div {...rise(0.32)} className="relative order-5 lg:order-none lg:shrink-0">
                <HeroCardGlow className="-z-10" />
                <div className="relative rounded-3xl border border-border/60 bg-card/95 p-4 shadow-xl shadow-slate-900/[0.07] backdrop-blur-sm lg:p-6">

                  {/* Price */}
                  {canRegister && (
                    <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
                      <div className="flex flex-wrap items-baseline gap-x-2 lg:block">
                        <p className={TYPE.label}>{isFree ? 'Entry' : 'From'}</p>
                        <p className="flex items-baseline gap-2 lg:mt-1">
                          <span className="text-[length:var(--hero-price)] font-extrabold leading-none tracking-[-0.03em] text-foreground">
                            {isFree ? 'Free' : formatINR(minPrice)}
                          </span>
                          {!isFree && (
                            <span className="text-fs-sm font-medium text-muted-foreground">/ participant</span>
                          )}
                        </p>
                      </div>
                      {isEarlyBird && (
                        <span className="shrink-0 text-fs-2xs font-bold uppercase tracking-[0.14em] text-primary">
                          Early Bird Offer
                        </span>
                      )}
                    </div>
                  )}

                  {/* Scarcity for the lead pass — a hairline meter, not a tinted box */}
                  {canRegister && leadRemaining != null && leadCapacity != null && leadCapacity > 0 && (
                    <div className="mt-3 lg:mt-4">
                      <p className="inline-flex items-center gap-2 text-fs-sm font-semibold text-foreground">
                        <Users className="size-4 shrink-0 text-primary" aria-hidden />
                        {leadRemaining.toLocaleString('en-IN')} spots left at this price
                      </p>
                      <div
                        className="mt-2 h-1 w-full overflow-hidden rounded-full bg-border/70"
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
                  <div className={cn(canRegister && 'mt-4 lg:mt-5')}>
                    {canRegister ? (
                      <HashScrollLink
                        targetId="register"
                        className={cn(
                          'group inline-flex h-14 w-full items-center justify-center gap-2 rounded-2xl text-fs-lg font-bold text-white shadow-lg shadow-primary/25 transition-transform duration-200 hover:-translate-y-0.5 active:translate-y-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-offset-2 motion-reduce:transform-none',
                          BRAND_GRADIENT,
                        )}
                      >
                        {ctaLabel ?? (isFreeEvent ? 'Register Free' : 'Register Now')}
                        <ArrowRight className="size-5 transition-transform group-hover:translate-x-1 motion-reduce:transform-none" aria-hidden />
                      </HashScrollLink>
                    ) : (
                      <span className="flex w-full items-center justify-center rounded-2xl bg-muted py-4 text-fs-md font-semibold text-muted-foreground">
                        {statusWord || 'Registrations closed'}
                      </span>
                    )}
                  </div>

                  {/* Secondary actions */}
                  <div className="mt-2.5 flex items-center gap-3 lg:mt-3">
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
                      {copied ? 'Link copied' : 'Share'}
                    </button>
                  </div>
                </div>
              </motion.div>
            </div>

          </div>

          {/* ══════════ 9 · WHAT'S INCLUDED — one horizontal strip ══════════════
               Platform guarantees, then the ranked benefits the organiser configured
               on the passes themselves. The coverage sentence each benefit used to
               carry as a second line is preserved for assistive tech and on hover,
               so the strip reads as one line without losing information. */}
          {included.length > 0 && (
            <motion.div {...rise(0.38)} className="mt-[var(--hero-gap)] border-t border-border/60 pt-3.5 lg:pt-4">
              {/* A 2-column grid below sm, the single wrapping row from sm up. Ragged
                  `flex-wrap` at 360 produced uneven pairs with no shared left edge;
                  fixed columns make the strip scannable without adding a card. */}
              <ul className="grid grid-cols-2 gap-x-4 gap-y-2 lg:flex lg:flex-wrap lg:items-center lg:gap-x-7 lg:gap-y-2.5">
                {included.map(item => (
                  <li
                    key={item.key}
                    title={item.note || undefined}
                    className="inline-flex items-center gap-2 text-fs-sm font-semibold text-foreground"
                  >
                    <item.icon className="size-4 shrink-0 text-primary" aria-hidden />
                    {item.label}
                    {item.note && <span className="sr-only"> — {item.note}</span>}
                  </li>
                ))}
              </ul>
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
