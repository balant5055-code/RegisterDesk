'use client'

// ─── SportsCover — the masthead of the race ──────────────────────────────────
//
// SPORTS-ONLY. Nothing here is shared with any other template; the seven composed
// templates keep EventHeroFramework, TeamSports and Meetup keep the framework's
// ComposedBody, and none of them import this file.
//
// ═══ THE COMPOSITION ═════════════════════════════════════════════════════════
// A start list. The white cuts read as a document rather than a race, so the hero is
// now the event's own photograph scrimmed to ink, with the facts set the way a start
// board sets them — the numeral large and tabular, its unit and label small:
//
//   breadcrumb                                           (on the page's white)
//   ┌ the photograph, scrimmed ─────────────────────────────────────────────────┐
//   │ RUNNING  ▏▏▎▏▏▎▏▏▎                       TIRUPPUR, TAMILNADU · 641663      │
//   │                                                                           │
//   │ Vanathukkul                          ┌──────────────────────────────┐     │
//   │ Noyyal Marathon                      │  the complete print, on a mat│     │
//   │ Send Your Contribution and …         └──────────────────────────────┘     │
//   │ description · Read More                ▣ UDHAYAM FOUNDATION               │
//   │ ─────────────────────────────────────  ─────────────────────────────────  │
//   │ RACE DAY  FLAG-OFF  DISTANCES   REG.   START LINE                         │
//   │ 22 AUG    5:00 AM   5 · 5 · 10  Event  Nallammal Temple, Mangalam …       │
//   │ SAT·2026  START LINE  3 TO …    concl. Tiruppur · 641663 · Full address   │
//   │ ─────────────────────────────────────                                     │
//   │ [Register]  Add to Calendar · Share                                       │
//   └───────────────────────────────────────────────────────────────────────────┘
//
// The ticks after the discipline are a start grid; the figures are tabular so the row
// reads as a board. Every number is the organiser's own: the date, the flag-off time,
// and the distances they created — a distance that is not numeric keeps its whole text.
// The ground is the banner under flat scrim passes and the landing's 5% grain; the
// PRINT above it is that same picture shown WHOLE on a white mat, never cropped.
//
// ═══ WHAT IS DELIBERATELY NOT HERE ═══════════════════════════════════════════
// No inclusions, no platform trust claims, no impact trio, no invented statements, no
// gradient surface, no shadow, no blur, no card. The one gradient on the page is a
// live Register CTA; a concluded event states its state as small type on a rule.
//
// ═══ BEHAVIOUR ═══════════════════════════════════════════════════════════════
// Registration eligibility, the CTA label, the hash-scroll target, the clock
// (useEventClock), calendar (AddToCalendarButton), share (navigator.share → clipboard),
// the address dialog and the poster lightbox are the same calls with the same
// arguments they have had since SportsHero. Only the presentation moved.

import { useState } from 'react'
import { ArrowRight, Share2, Check, Expand } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { EVENT_CONTAINER, BRAND_GRADIENT, SECTION_SCROLL_MT } from '@/components/event-templates/shared/ui/framework'
import { useEventClock, pad2 } from '@/components/event-templates/shared/hero/useEventClock'
import { HeroClampedText } from '@/components/event-templates/shared/hero/HeroClampedText'
import { HashScrollLink } from '@/components/event-templates/shared/ui/HashScrollLink'
import { AddToCalendarButton } from '@/components/event-templates/shared/ui/AddToCalendarButton'
import { ImageLightbox } from '@/components/event-templates/shared/ui/ImageLightbox'
import { formatDate, formatDateShort, formatTime, formatINR, passDisplayPrice } from '@/components/event-templates/shared/utils/format'
import { buildEventBreadcrumbs } from '@/lib/events/breadcrumbs'
import { Breadcrumbs } from '@/components/ui/Breadcrumbs'
import { Dialog } from '@/components/ui/Dialog'
import { splitVenueName } from './primitives'
import type { PassPublic } from '@/components/event-templates/types'
import type { PassAvailability } from '@/lib/registrations/types'
import type { OrganizerInfo, PhysicalVenueConfig } from '@/components/wizard/eventDetailsConfig'

/** The same contract SportsHero took — SportsTemplate passes it unchanged. */
export interface SportsCoverProps {
  title:              string
  tagline?:           string
  shortDesc?:         string
  discipline?:        string
  edition?:           string
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
  distances?:         string[]
  showAttendeeCount?: boolean
  showSocial?:        boolean
  physical?:          PhysicalVenueConfig
}

/** The section's own id — the section navigation's "Overview" target. */
export const SPORTS_COVER_ID = 'overview'

/**
 * An OUTLINED control on the dark ground (2026-09-25, owner: "make Add to Calendar and
 * Share nicely"): 40px, the control radius, a hairline in the on-media ink with a faint
 * lift of fill, the icon in bronze. Hover warms the hairline to bronze and deepens the
 * fill — no movement, no glow.
 */
const ON_MEDIA_BUTTON =
  'inline-flex h-10 items-center gap-2 rounded-[var(--radius-control)] border border-ink-on-media/25 bg-ink-on-media/[0.04] px-4 py-0 text-fs-sm font-semibold text-ink-on-media ' +
  'transition-colors duration-200 hover:border-hero-accent-rule/70 hover:bg-ink-on-media/[0.09] hover:text-ink-on-media ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink-on-media/70 focus-visible:ring-offset-2 focus-visible:ring-offset-hero-ink'

/** AddToCalendarButton, dressed as the same outlined control: its leading calendar
 *  glyph takes the bronze, the trailing chevron stays in the ink. */
const ON_MEDIA_CALENDAR = cn(ON_MEDIA_BUTTON, '[&>svg:first-child]:text-hero-accent-rule [&>svg:last-child]:text-ink-on-media-muted')

export function SportsCover(props: SportsCoverProps) {
  const {
    title, tagline, shortDesc, discipline, edition, bannerUrl, slug,
    startDate, startTime = '', endDate = '', endTime = '',
    venueType, venueName, lifecycleStatus, registrationOpen, isFreeEvent, passes, availability,
    organizer, ctaLabel, countdownLabel, distances, physical,
  } = props

  const [posterOpen, setPosterOpen] = useState(false)
  const [addressOpen, setAddressOpen] = useState(false)
  const [copied, setCopied] = useState(false)

  const headingId = 'event-hero-title'

  // ── Registration state — identical derivation to the old hero ────────────────
  const activePasses = passes.filter(p => p.status !== 'inactive')
  const canRegister  = registrationOpen && activePasses.length > 0
  const leadPass = activePasses.length
    ? activePasses.reduce((a, b) => (passDisplayPrice(a) <= passDisplayPrice(b) ? a : b))
    : undefined
  const minPrice = leadPass ? passDisplayPrice(leadPass) : 0
  const isFree   = isFreeEvent || minPrice === 0
  const leadRemaining = leadPass && availability ? availability[leadPass.id]?.remaining ?? null : null
  const salesCloseDate = activePasses.map(p => p.salesEndDate?.trim()).filter(Boolean).sort()[0] as string | undefined
  const salesCloseLabel = salesCloseDate ? formatDateShort(salesCloseDate) : ''

  const clock = useEventClock({
    startDate, startTime, endDate, registrationOpen, salesCloseDate, lifecycleStatus, startLabel: countdownLabel,
  })
  const { cd, showTimer, heading, statusWord, srLabel } = clock

  // ── Place ───────────────────────────────────────────────────────────────────
  const isOnline   = venueType === 'online'
  const venueTitle = splitVenueName(physical?.name?.trim() || (isOnline ? 'Online event' : venueName)).name
  const addressParts = isOnline ? [] : [
    physical?.addressLine1?.trim(),
    physical?.addressLine2?.trim(),
    [physical?.city?.trim(), physical?.state?.trim()].filter(Boolean).join(', '),
    physical?.pincode?.trim(),
    physical?.country?.trim() && !['india', 'in'].includes(physical.country.trim().toLowerCase())
      ? physical.country.trim() : '',
  ].filter(Boolean) as string[]
  const whereLine = isOnline ? 'Online event' : [venueTitle, addressParts.join(', ')].filter(Boolean).join(', ')
  const localityLine = isOnline ? '' : [
    [physical?.city?.trim(), physical?.state?.trim()].filter(Boolean).join(', '),
    physical?.pincode?.trim(),
  ].filter(Boolean).join(' · ')
  const hasFullAddress = addressParts.length > 0 || venueTitle.length > 60

  const kicker       = [discipline, edition].filter(Boolean).join(' · ') || undefined
  const dateLine     = startDate ? formatDate(startDate) : ''   // the calendar entry and the address dialog
  const timeLine     = startTime ? formatTime(startTime) : ''
  const distanceLine = (distances ?? []).map(d => d.trim()).filter(Boolean).join(' · ')
  const crumbs       = buildEventBreadcrumbs('sports', title)
  const posterName   = `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'event'}-poster`
  const hasPoster    = !!bannerUrl?.trim()

  const onShare = async () => {
    if (typeof window === 'undefined') return
    const url = window.location.href
    try {
      if (navigator.share) { await navigator.share({ title, url }); return }
      await navigator.clipboard.writeText(url)
      setCopied(true); setTimeout(() => setCopied(false), 1800)
    } catch { /* dismissed */ }
  }

  /** "2026-08-22" as a LOCAL calendar date — the ISO string parses as UTC otherwise. */
function calendarDate(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim())
  if (!m) return null
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return Number.isNaN(d.getTime()) || d.getMonth() !== Number(m[2]) - 1 ? null : d
}

/** The organiser signs the print — and is named even when there is no print. */
  const plateCaption = !!organizer?.name?.trim()

  // ── The race board ──────────────────────────────────────────────────────────
  // Four readings, each a figure the organiser set, in the register a start list uses:
  // the numeral large and tabular, its unit and label small and letterspaced.
  const startAt = startDate ? calendarDate(startDate) : null
  const dayNum  = startAt ? String(startAt.getDate()).padStart(2, '0') : ''
  const monthAbr = startAt ? startAt.toLocaleDateString('en-IN', { month: 'short' }).toUpperCase() : ''
  const yearNum = startAt ? String(startAt.getFullYear()) : ''
  const weekday = startAt ? startAt.toLocaleDateString('en-IN', { weekday: 'short' }).toUpperCase() : ''
  const clockFigure = timeLine.replace(/\s*(AM|PM)$/i, '')
  const meridiem = /\s(AM|PM)$/i.exec(timeLine)?.[1]?.toUpperCase() ?? ''

  /** "5 Km Walkathon" → "5"; a distance that is not numeric keeps its whole text. */
  const distanceFigures = (distances ?? [])
    .map(d => /^(\d+(?:\.\d+)?)\s*(km|k|mi|miles?|m)\b/i.exec(d.trim()))
    .filter(Boolean) as RegExpExecArray[]
  const distanceUnit = distanceFigures[0]?.[2]?.toUpperCase() ?? ''
  const sameUnit = distanceFigures.length === (distances ?? []).filter(Boolean).length
    && distanceFigures.every(m => m[2].toUpperCase() === distanceUnit)

  const board = [
    (dayNum || monthAbr) && { key: 'date', label: 'Race day', figure: dayNum, unit: monthAbr,
      note: [weekday, yearNum].filter(Boolean).join(' · '), srNote: dateLine },
    clockFigure && { key: 'start', label: 'Flag-off', figure: clockFigure, unit: meridiem, note: 'Start line' },
    distanceLine && (sameUnit && distanceFigures.length
      ? { key: 'distances', label: 'Distances', figure: distanceFigures.map(m => m[1]).join(' · '), unit: distanceUnit, note: `${distanceFigures.length} to choose from` }
      : { key: 'distances', label: 'Distances', figure: '', unit: '', note: distanceLine }),
    {
      key: 'state', label: 'Registration',
      figure: '', unit: '',
      note: canRegister ? (isFree ? 'Free entry' : `From ${formatINR(minPrice)}`) : (statusWord || 'Closed'),
      srNote: canRegister
        ? [salesCloseLabel && `Closes ${salesCloseLabel}`, leadRemaining != null && `${leadRemaining.toLocaleString('en-IN')} spots left`]
            .filter(Boolean).join(' · ') || undefined
        : undefined,
    },
  ].filter(Boolean) as { key: string; label: string; figure: string; unit: string; note: string; srNote?: string }[]

  // The stats row carries everything but the distances; the distances are the bib row.
  const stats = board.filter(b => b.key !== 'distances')
  const bibs = (distances ?? []).map(d => d.trim()).filter(Boolean).map(label => {
    const m = /^(\d+(?:\.\d+)?)\s*(km|k|mi|miles?|m)\b\s*(.*)$/i.exec(label)
    return m
      ? { label, figure: m[1], unit: m[2].toUpperCase(), word: m[3].trim() }
      : { label, figure: '', unit: '', word: '' }
  })

  return (
    <section id={SPORTS_COVER_ID} className={cn('bg-background', SECTION_SCROLL_MT)} aria-labelledby={headingId}>
      {/* The chrome stays on the page's white; the stage below is the race's own. */}
      <div className={cn(EVENT_CONTAINER, 'py-2.5')}>
        <Breadcrumbs items={crumbs} />
      </div>

      <div className="relative isolate overflow-hidden bg-hero-ink">
        {/* ══ THE GROUND — the event's own photograph, scrimmed until the ink reads ══ */}
        {hasPoster && (
          <div aria-hidden className="absolute inset-0 -z-10">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={bannerUrl} alt="" aria-hidden className="size-full scale-[1.7] object-cover object-[22%_62%]" />
            <span className="absolute inset-0 bg-gradient-to-t from-hero-ink via-hero-ink/95 to-hero-ink/88" />
            <span className="absolute inset-0 bg-gradient-to-r from-hero-ink via-hero-ink/90 to-hero-ink/60" />
            <span className="rd-hero-grain absolute inset-0 opacity-[0.05] mix-blend-overlay" />
          </div>
        )}

        {/* ══ THE TRACK — a 400m oval's lanes, faint in the ink (2026-09-25 cover pass).
               Pure line work: no fill, no gradient, click-through, hidden from AT. ══ */}
        <svg
          aria-hidden
          viewBox="0 0 600 360"
          fill="none"
          className="pointer-events-none absolute -bottom-40 -right-40 -z-10 hidden w-[46rem] text-ink-on-media/[0.07] lg:block"
        >
          {[0, 1, 2, 3, 4, 5].map(i => (
            <rect key={i} x={20 + i * 18} y={20 + i * 18} width={560 - i * 36} height={320 - i * 36} rx={160 - i * 18} stroke="currentColor" strokeWidth="1.25" />
          ))}
          <line x1="300" y1="20" x2="300" y2="128" stroke="currentColor" strokeWidth="1.25" strokeDasharray="4 5" />
        </svg>

        <div className={cn(EVENT_CONTAINER, 'py-8 lg:py-11')}>

          {/* ══ 1 · THE START LINE — discipline, the grid, the place ═══════════ */}
          <div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-center sm:justify-start sm:text-left">
            <p className="text-fs-2xs font-semibold uppercase tracking-[0.22em] text-hero-accent-rule">{kicker ?? 'Event'}</p>
            <span aria-hidden className="hidden flex-1 items-end gap-[5px] sm:flex">
              {Array.from({ length: 18 }).map((_, i) => (
                <span key={i} className={cn('w-px', i % 3 === 0 ? 'h-3.5 bg-hero-accent-rule/70' : 'h-2 bg-ink-on-media/25')} />
              ))}
            </span>
            {localityLine && (
              <p className="text-fs-2xs font-semibold uppercase tracking-[0.14em] text-ink-on-media-muted">{localityLine}</p>
            )}
          </div>

          <div className="mt-6 sm:mt-7 lg:mt-8 lg:grid lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:items-start lg:gap-x-12 xl:gap-x-16">

            {/* ══ 2 · THE STATEMENT ════════════════════════════════════════════ */}
            <div className="min-w-0">
              <h1
                id={headingId}
                className="text-balance text-center font-display text-[clamp(1.625rem,2.8vw,2.25rem)] font-normal leading-[1.1] tracking-[-0.015em] text-ink-on-media sm:text-left"
              >
                {title}
              </h1>
              <span aria-hidden className="mx-auto mt-4 block h-px w-12 bg-hero-accent-rule sm:mx-0" />

              {tagline && (
                <p className="mx-auto mt-4 max-w-[36ch] text-balance text-center sm:mx-0 sm:text-left text-fs-md font-normal leading-[1.5] text-ink-on-media lg:text-fs-lg">
                  {tagline}
                </p>
              )}

              {shortDesc?.trim() && (
                <div className="mx-auto mt-3 max-w-[52ch] text-center sm:mx-0 sm:mt-4 sm:text-left [&_button]:text-hero-accent-rule [&_button:hover]:text-ink-on-media">
                  <HeroClampedText
                    text={shortDesc}
                    clampClassName="line-clamp-2"
                    className="whitespace-pre-line text-fs-base leading-relaxed text-ink-on-media-muted"
                    triggerLabel="Read More"
                    dialogTitle={title}
                  />
                </div>
              )}

              {/* ══ 3 · THE BOARD — the race read as figures (2026-09-25, owner) ══════
                     ONE row of three at every width — race day · flag-off · registration —
                     compact on a phone (24px figures), so the stats never stack into a
                     bulky 2×2 block. The distances get a row of their own beneath it, set
                     as race BIBS: pin holes, the figure, the discipline in bronze. */}
              {stats.length > 0 && (
                <dl className={cn('mt-6 grid border-y border-ink-on-media/20 py-4 sm:mt-7 sm:py-5', stats.length === 3 ? 'grid-cols-3' : stats.length === 2 ? 'grid-cols-2' : 'grid-cols-1', 'divide-x divide-ink-on-media/15')}>
                  {stats.map(b => (
                    <div key={b.key} className="min-w-0 px-3 text-center first:pl-0 last:pr-0 max-[359px]:px-2 sm:px-5 sm:text-left">
                      <dt className="truncate text-fs-2xs font-semibold uppercase tracking-[0.14em] text-ink-on-media-muted max-[359px]:tracking-[0.04em]">{b.label}</dt>
                      <dd className="mt-2">
                        {b.figure ? (
                          <p className="whitespace-nowrap text-fs-xl font-semibold tabular-nums leading-none tracking-[-0.035em] text-ink-on-media max-[359px]:text-fs-lg sm:text-fs-2xl lg:text-fs-3xl">
                            {b.figure}
                            {b.unit && <span className="text-fs-2xs font-semibold uppercase tracking-[0.12em] text-ink-on-media-muted sm:text-fs-xs"> {b.unit}</span>}
                          </p>
                        ) : null}
                        {b.note && b.key === 'state' ? (
                          <p className="flex items-start justify-center gap-2 pt-0.5 text-left text-fs-sm font-semibold leading-tight text-ink-on-media sm:justify-start sm:text-fs-md xl:whitespace-nowrap">
                            <span aria-hidden className="relative mt-1 flex size-2 shrink-0">
                              {canRegister && <span className="absolute inset-0 animate-ping rounded-full bg-success/70 motion-reduce:animate-none" />}
                              <span className={cn('relative size-2 rounded-full', canRegister ? 'bg-success' : 'bg-ink-on-media/40')} />
                            </span>
                            {b.note}
                          </p>
                        ) : b.note && (
                          <p className="mt-1.5 truncate text-fs-2xs font-semibold uppercase tracking-[0.14em] text-ink-on-media-muted max-[359px]:tracking-[0.04em]">
                            {b.note}
                          </p>
                        )}
                        {b.srNote && b.key !== 'date' && (
                          <p className="mt-1 text-fs-2xs font-semibold uppercase tracking-[0.14em] text-ink-on-media-muted">{b.srNote}</p>
                        )}
                        {b.srNote && b.key === 'date' && <span className="sr-only">{b.srNote}</span>}
                      </dd>
                    </div>
                  ))}
                </dl>
              )}

              {/* ══ 3b · THE BIBS — every distance on its own race number ═══════════ */}
              {bibs.length > 0 && (
                <div className="flex flex-col items-center gap-3 border-b border-ink-on-media/20 py-4 text-center sm:flex-row sm:gap-6 sm:py-5 sm:text-left">
                  <div className="shrink-0">
                    <p className="text-fs-2xs font-semibold uppercase tracking-[0.14em] text-ink-on-media-muted">Distances</p>
                    {bibs.length > 1 && (
                      <p className="mt-1 text-fs-2xs font-semibold uppercase tracking-[0.14em] text-hero-accent-rule">{bibs.length} to choose from</p>
                    )}
                  </div>
                  <ul className="flex flex-wrap justify-center gap-2.5 sm:justify-start">
                    {bibs.map((bib, i) => (
                      <li
                        key={bib.label + i}
                        className="relative flex min-w-[5.25rem] flex-col items-center rounded-[4px] border border-ink-on-media/25 bg-ink-on-media/[0.05] px-3 pb-2 pt-3.5 text-center"
                      >
                        {/* the two safety-pin holes of a race bib */}
                        <span aria-hidden className="absolute left-2 top-1.5 size-1 rounded-full bg-ink-on-media/35" />
                        <span aria-hidden className="absolute right-2 top-1.5 size-1 rounded-full bg-ink-on-media/35" />
                        {bib.figure ? (
                          <span className="text-fs-xl font-semibold tabular-nums leading-none tracking-[-0.035em] text-ink-on-media">
                            {bib.figure}
                            <span className="ml-0.5 text-fs-2xs font-semibold uppercase tracking-[0.12em] text-ink-on-media-muted">{bib.unit}</span>
                          </span>
                        ) : (
                          <span className="text-fs-sm font-semibold text-ink-on-media">{bib.label}</span>
                        )}
                        {bib.word && (
                          <span className="mt-1 max-w-[7rem] truncate text-fs-2xs font-semibold uppercase tracking-[0.12em] text-hero-accent-rule">{bib.word}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* ══ 4 · WHERE, AND WHAT TO DO ABOUT IT ════════════════════════ */}
              <div className="mt-6 flex flex-wrap items-center justify-center gap-x-8 gap-y-4 sm:mt-5 sm:justify-start">
                {canRegister && (
                  <HashScrollLink
                    targetId="register"
                    className={cn(
                      'group inline-flex h-11 items-center justify-center gap-2 rounded-surface px-7 text-fs-md font-semibold text-white',
                      'transition-transform duration-200 hover:-translate-y-0.5 active:translate-y-0 motion-reduce:transform-none',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink-on-media/70 focus-visible:ring-offset-2 focus-visible:ring-offset-hero-ink',
                      BRAND_GRADIENT,
                    )}
                  >
                    {ctaLabel ?? (isFreeEvent ? 'Register Free' : 'Register Now')}
                    <ArrowRight className="size-4 transition-transform group-hover:translate-x-1 motion-reduce:transform-none" aria-hidden />
                  </HashScrollLink>
                )}

                <div className="flex flex-wrap items-center justify-center gap-2.5 sm:justify-start">
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
                      menuAlign="left"
                      className={ON_MEDIA_CALENDAR}
                    />
                  )}
                  <button type="button" onClick={onShare} className={ON_MEDIA_BUTTON}>
                    {copied ? <Check className="size-4 text-hero-accent-rule" aria-hidden /> : <Share2 className="size-4 text-hero-accent-rule" aria-hidden />}
                    {copied ? 'Link copied' : 'Share'}
                  </button>
                </div>

                {showTimer && cd && (
                  <p className="basis-full text-center text-fs-sm text-ink-on-media-muted sm:text-left" aria-label={srLabel}>
                    {heading}{' '}
                    <span className="font-medium tabular-nums text-ink-on-media">
                      {cd.d}d {pad2(cd.h)}h {pad2(cd.m)}m
                    </span>
                  </p>
                )}
              </div>
            </div>

            {/* ══ 5 · THE PRINT, THE HOST, THE VENUE ═══════════════════════════ */}
            <div className="mt-8 min-w-0 sm:mt-9 lg:mt-0">
              {hasPoster && (
                <div className="relative">
                {/* The offset frame — a second, bronze hairline mat behind the print. */}
                <span aria-hidden className="pointer-events-none absolute inset-0 translate-x-3 translate-y-3 border border-hero-accent-rule/45" />
                <button
                  type="button"
                  onClick={() => setPosterOpen(true)}
                  aria-label={`View ${title} poster full screen`}
                  className="group relative block w-full bg-ink-on-media p-2.5 outline-none transition-transform duration-300 hover:-translate-y-0.5 focus-visible:ring-2 focus-visible:ring-hero-accent-rule focus-visible:ring-offset-4 focus-visible:ring-offset-hero-ink motion-reduce:transform-none sm:p-3"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={bannerUrl}
                    alt={`${title} event poster`}
                    fetchPriority="high"
                    decoding="async"
                    className="block h-auto max-h-[38vh] w-full object-contain lg:max-h-[14rem]"
                  />
                  <span
                    aria-hidden
                    className="pointer-events-none absolute bottom-5 right-5 inline-flex size-8 items-center justify-center bg-hero-ink/85 text-ink-on-media opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-focus-visible:opacity-100"
                  >
                    <Expand className="size-4" />
                  </span>
                </button>
                </div>
              )}
              {hasPoster && (
                <p className="mt-5 flex items-center justify-center gap-2 text-fs-2xs font-semibold uppercase tracking-[0.14em] text-ink-on-media-muted sm:justify-start">
                  <span aria-hidden className="h-px w-5 bg-hero-accent-rule" />
                  Official poster
                  <span aria-hidden>·</span>
                  <button type="button" onClick={() => setPosterOpen(true)} className="uppercase text-hero-accent-rule underline-offset-4 hover:text-ink-on-media hover:underline focus-visible:outline-none focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-hero-accent-rule">
                    View full size
                  </button>
                </p>
              )}

              {(plateCaption || venueTitle) && (
              <div className={cn('border border-ink-on-media/15 bg-ink-on-media/[0.03] p-4 text-center sm:text-left', hasPoster ? 'mt-5' : '')}>
              {plateCaption && (
                <div className="flex items-center justify-center gap-3 sm:justify-start">
                  {organizer!.logoUrl?.trim() && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={organizer!.logoUrl} alt="" loading="lazy" decoding="async" className="size-8 shrink-0 bg-ink-on-media object-contain p-1" />
                  )}
                  <div className="min-w-0 text-left">
                    <p className="truncate text-fs-2xs font-semibold uppercase tracking-[0.14em] text-ink-on-media">{organizer!.name}</p>
                    <p className="mt-0.5 text-fs-2xs font-semibold uppercase tracking-[0.14em] text-ink-on-media-muted">
                      {organizer!.verified ? 'Verified organizer' : 'Official Organizer'}
                    </p>
                  </div>
                </div>
              )}

              {venueTitle && (
                <div className={cn(plateCaption && 'mt-4 border-t border-ink-on-media/15 pt-4')}>
                  <p className="text-fs-2xs font-semibold uppercase tracking-[0.14em] text-ink-on-media-muted">
                    {isOnline ? 'Where' : 'Start line'}
                  </p>
                  <p className="mt-2 line-clamp-2 break-words text-fs-md font-semibold leading-snug text-ink-on-media">{venueTitle}</p>
                  {(localityLine || hasFullAddress) && (
                    <p className="mt-1 text-fs-base text-ink-on-media-muted">
                      {localityLine}
                      {hasFullAddress && (
                        <>
                          {localityLine && <span aria-hidden> · </span>}
                          <button type="button" onClick={() => setAddressOpen(true)} className="font-medium text-hero-accent-rule underline-offset-4 hover:text-ink-on-media hover:underline focus-visible:outline-none focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-hero-accent-rule">
                            Full address
                          </button>
                        </>
                      )}
                    </p>
                  )}
                </div>
              )}
              </div>
              )}
            </div>
          </div>
        </div>
      </div>


      <Dialog open={addressOpen} onClose={() => setAddressOpen(false)} title="Venue address" size="sm">
        <address className="not-italic">
          <p className="text-fs-md font-semibold text-foreground">{venueTitle}</p>
          <div className="mt-2 space-y-0.5 text-fs-base leading-relaxed text-muted-foreground">
            {addressParts.map(part => <p key={part}>{part}</p>)}
          </div>
        </address>
      </Dialog>

      {hasPoster && (
        <ImageLightbox
          open={posterOpen}
          src={bannerUrl!}
          alt={`${title} event poster`}
          onClose={() => setPosterOpen(false)}
          downloadHref={bannerUrl}
          downloadName={posterName}
        />
      )}
    </section>
  )
}
