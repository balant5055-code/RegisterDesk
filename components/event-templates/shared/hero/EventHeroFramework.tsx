'use client'

// EventHeroFramework — the shared event hero, owned once for every template.
//
// RD-ST4.5 (Phase 3) — rebuilt around ONE decision, not two competing columns.
//
// The audit that drove this (ST4.2 OB-1/OB-2, plus a fresh read of the old markup):
//
//   • The POSTER outranked everything. It was the largest object, the only full-colour
//     one, the only elevated one — and it had no max-height, so hero height was set by
//     whatever aspect ratio the organiser uploaded. A 9:16 poster produced a ~800px
//     column against a ~280px content column, pushing the price and every trust signal
//     below the fold on desktop and ~1050px down on mobile.
//   • PRICE was rank 7 of 7 — 13px text in a bottom strip, separated from the CTA by the
//     full height of the poster.
//   • The COUNTDOWN sat between the venue and the CTA, splitting the decision path.
//   • The TRUST strip sat under a divider at the very bottom, reading as a footer rather
//     than as reassurance at the point of decision.
//   • CLUTTER: a 48px event-type badge repeating what the kicker already said; a second
//     poster affordance ("View Poster") next to the click-to-open poster itself.
//
// Composition now:
//
//   Overline   — registration status · event type. Rank 1, one line, one chip each.
//   Left (7)   — title → tagline → a <dl> metadata group (when / where / distances /
//                closes) → secondary actions → organiser attribution.
//   Right (5)  — THE REGISTRATION PANEL: capped poster, price, countdown, seats, the one
//                primary CTA, and the trust row. One card, one decision.
//   Mobile     — the panel's decision block is ordered BEFORE the poster, so price and
//                CTA land in the first screen instead of below the artwork.
//
// Unchanged by contract: the clock, the phase state machine, the countdown maths, the
// share/copy/download actions, the poster lightbox, and every href the caller supplies.
//
// Time model: a shared client clock via useSyncExternalStore — `now` is null on the
// server and first paint (countdown shows "––"), so SSR and hydration agree, then it
// ticks. Phase + countdown are pure-derived in render (no effects, no layout shift).

import { createElement, useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { motion, useReducedMotion } from 'framer-motion'
import { ArrowRight, Share2, Copy, Check, Download, MoreHorizontal, ChevronDown, BadgeCheck, Users } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { AddToCalendarButton } from '@/components/event-templates/shared/ui/AddToCalendarButton'
import { ImageLightbox } from '@/components/event-templates/shared/ui/ImageLightbox'
import { EASE, EVENT_CONTAINER, CARD, TYPE } from '@/components/event-templates/shared/ui/framework'
import { pad2, useEventClock } from '@/components/event-templates/shared/hero/useEventClock'

// ─── Public contract ─────────────────────────────────────────────────────────────

export interface HeroCalendar {
  title: string; startDate: string; endDate: string
  startTime: string; endTime: string; location: string; description: string; slug: string
}

/** One metadata row. `label` turns it into a real <dt>/<dd> pair (grouped, readable). */
export interface HeroEssential { icon?: LucideIcon; label?: string; text: string }

/** One trust signal. The icon carries meaning — do not default them all to a tick. */
export interface HeroTrustItem { icon?: LucideIcon; label: string }

export interface EventHeroFrameworkProps {
  kicker?:  string
  title:    string
  tagline?: string
  /** Event-type icon — rendered small, inside the kicker chip (was a 48px badge). */
  icon?:    LucideIcon
  bannerUrl?: string

  /** Small status marker above the title (omit to hide) */
  status?: { label: string; tone?: 'open' | 'muted' }

  /** Date / venue / distance rows, pre-formatted by the caller */
  essentials: HeroEssential[]

  /** Timing — the framework owns the lifecycle countdown from these */
  timing: {
    startDate:        string
    startTime?:       string
    endDate?:         string
    registrationOpen: boolean
    salesCloseDate?:  string | null
    lifecycleStatus?: string
    startLabel?:      string
  }

  /** Actions */
  primary?:     { label: string; href: string }
  calendar?:    HeroCalendar

  /** Registration panel — price split so the amount can carry the visual weight. */
  pricing?:     { amount: string; caption?: string }
  /** e.g. "240 spots left". Caller decides when this is honest; omit for unlimited. */
  seatsLabel?:  string
  /** Organiser attribution (hierarchy rank 9). */
  organizer?:   { name: string; verified?: boolean }
  /** Trust row (hierarchy rank 10). */
  trust?:       HeroTrustItem[]
}


// ─── Component ───────────────────────────────────────────────────────────────────

export function EventHeroFramework({
  kicker, title, tagline, icon, bannerUrl, status, essentials, timing,
  primary, calendar, pricing, seatsLabel, organizer, trust = [],
}: EventHeroFrameworkProps) {
  const reduce = useReducedMotion()
  const [copied,  setCopied]        = useState(false)
  const [posterOpen, setPosterOpen] = useState(false)
  const [moreOpen, setMoreOpen]     = useState(false)
  const moreRef    = useRef<HTMLDivElement>(null)
  const moreBtnRef = useRef<HTMLButtonElement>(null)
  const headingId  = 'event-hero-title'

  const { phase, cd, showTimer, heading, statusWord, srLabel: cdSr } = useEventClock(timing)

  // ── actions — UNCHANGED ──
  const onShare = async () => {
    if (typeof window === 'undefined') return
    const url = window.location.href
    try {
      if (navigator.share) { await navigator.share({ title, url }); return }
      await navigator.clipboard.writeText(url)
      setCopied(true); setTimeout(() => setCopied(false), 1800)
    } catch { /* dismissed */ }
  }

  // Copy Link — reuses the standard clipboard API (no central helper exists) with a
  // local "copied" confirmation, matching the public-page pattern (Toast has no
  // provider on public event routes).
  const onCopy = async () => {
    if (typeof window === 'undefined') return
    try {
      await navigator.clipboard.writeText(window.location.href)
      setCopied(true); setTimeout(() => setCopied(false), 1800)
    } catch { /* ignored */ }
  }

  const closeMore = useCallback((restoreFocus: boolean) => {
    setMoreOpen(false)
    if (restoreFocus) moreBtnRef.current?.focus()
  }, [])

  // Close the More menu on outside click (mirrors the AddToCalendarButton idiom).
  useEffect(() => {
    if (!moreOpen) return
    const handler = (e: MouseEvent) => {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) setMoreOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [moreOpen])

  // A11y: the menu had role="menu" but no keyboard model. Escape closes and returns
  // focus to the trigger; Arrow keys move between items; Home/End jump.
  const onMenuKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') { e.preventDefault(); closeMore(true); return }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return
    const items = Array.from(moreRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])
    if (items.length === 0) return
    e.preventDefault()
    const i = items.indexOf(document.activeElement as HTMLElement)
    const to = e.key === 'ArrowDown' ? (i + 1) % items.length
      : e.key === 'ArrowUp' ? (i - 1 + items.length) % items.length
        : e.key === 'Home' ? 0 : items.length - 1
    items[to]?.focus()
  }

  // One shared shape for every secondary control so the group aligns perfectly.
  const SECONDARY_BTN =
    'inline-flex h-9 items-center gap-2 rounded-full border border-border/80 bg-card px-4 text-fs-sm font-semibold text-foreground transition-colors hover:border-foreground/30 hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40'
  const MENU_ITEM =
    'flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left text-fs-sm font-medium text-foreground transition-colors hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-none'

  const rise = (delay: number) => reduce
    ? {}
    : { initial: { opacity: 0, y: 14 }, animate: { opacity: 1, y: 0 },
        transition: { duration: 0.55, ease: EASE, delay } }

  const cdSegments = [{ v: cd?.d, l: 'Days' }, { v: cd?.h, l: 'Hrs' }, { v: cd?.m, l: 'Min' }]
  const posterName = `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'event'}-poster`
  const hasPoster  = !!bannerUrl?.trim()
  const hasPanel   = !!(pricing || primary || showTimer || statusWord || hasPoster || trust.length > 0)

  return (
    <section aria-labelledby={headingId} className="relative overflow-hidden border-b border-border/60 bg-white">
      <div className={cn(EVENT_CONTAINER, 'py-7 sm:py-8 lg:py-10')}>

        {/* ── Rank 1 · Registration status · event type ────────────────────────── */}
        {(status || kicker) && (
          <motion.div {...rise(0.04)} className="flex flex-wrap items-center gap-2">
            {status && (
              <span className={cn(
                'inline-flex items-center gap-2 rounded-full px-3 py-1 text-fs-2xs font-bold',
                status.tone === 'open'
                  ? 'bg-primary/10 text-primary ring-1 ring-primary/20'
                  : 'bg-muted text-muted-foreground ring-1 ring-border',
              )}>
                <span className={cn('size-1.5 rounded-full', status.tone === 'open' ? 'bg-primary' : 'bg-muted-foreground/60')} aria-hidden />
                {status.label}
              </span>
            )}
            {kicker && (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-card px-3 py-1 text-fs-2xs font-bold uppercase tracking-[0.14em] text-muted-foreground">
                {icon && createElement(icon, { className: 'size-3.5 text-primary', 'aria-hidden': true })}
                {kicker}
              </span>
            )}
          </motion.div>
        )}

        {/* ── Ranks 2 & 3 · title + description, full width above the split ────── */}
        <motion.div {...rise(0.1)} className="mt-6 flex flex-col gap-2.5">
          <h1 id={headingId} className="max-w-4xl text-[clamp(28px,2.7vw,38px)] font-bold leading-[1.08] tracking-[-0.02em] text-foreground">
            {title}
          </h1>
          {tagline && (
            <p className="max-w-2xl text-[clamp(15px,1.2vw,17px)] leading-relaxed text-muted-foreground">{tagline}</p>
          )}
        </motion.div>

        {/* ── The split · narrative (7) · registration panel (5) ────────────────
             The PANEL is first in the DOM on purpose. On mobile that puts price and
             the CTA immediately under the title instead of below the whole metadata
             block, and it fixes the focus order — the primary action is now the first
             control a keyboard user reaches, not the third. Explicit column starts
             restore the visual left/right arrangement on lg without reordering DOM. */}
        <div className="mt-7 grid grid-cols-1 items-start gap-8 lg:grid-cols-12 lg:gap-12">

          {/* ═══ THE REGISTRATION PANEL — DOM-first, visually right on lg ═══════ */}
          {hasPanel && (
            <motion.div {...rise(0.15)} className="lg:col-span-5 lg:col-start-8 lg:row-start-1">
              <div className={cn(CARD, 'flex flex-col overflow-hidden shadow-lg shadow-black/[0.05]')}>

                {/* Decision block */}
                <div className="order-1 flex flex-col gap-4 p-5 lg:order-2">

                  {/* Rank 5 · price */}
                  {pricing && (
                    <div className="flex items-baseline gap-2">
                      {pricing.caption && <span className={TYPE.label}>{pricing.caption}</span>}
                      <span className="text-fs-2xl font-bold tracking-tight text-foreground">{pricing.amount}</span>
                    </div>
                  )}

                  {/* Rank 8 · countdown (or the terminal lifecycle word) */}
                  {(showTimer || statusWord) && (
                    <div
                      className={cn(pricing ? 'border-t border-border/50 pt-4' : 'rounded-xl bg-muted/40 px-4 py-3')}
                      {...(showTimer ? { role: 'timer', 'aria-label': cdSr } : {})}
                    >
                      {showTimer ? (
                        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                          <span className={TYPE.label}>{heading}</span>
                          <span aria-hidden className="flex items-baseline gap-3 tabular-nums">
                            {cdSegments.map(({ v, l }) => (
                              <span key={l} className="flex items-baseline gap-0.5">
                                <span className="text-fs-lg font-bold leading-none tracking-tight text-foreground">{v == null ? '––' : pad2(v)}</span>
                                <span className="text-fs-2xs font-semibold lowercase text-muted-foreground">{l.charAt(0).toLowerCase()}</span>
                              </span>
                            ))}
                          </span>
                        </div>
                      ) : (
                        <span className="inline-flex items-center gap-2 text-fs-sm font-semibold text-muted-foreground">
                          {phase === 'live' && !reduce && <span className="size-2 rounded-full bg-primary motion-safe:animate-pulse" aria-hidden />}
                          {statusWord}
                        </span>
                      )}
                    </div>
                  )}

                  {/* Seats remaining — only when the caller can state it honestly */}
                  {seatsLabel && (
                    <p className="inline-flex items-center gap-2 text-fs-sm font-medium text-muted-foreground">
                      <Users className="size-4 shrink-0 text-primary/70" aria-hidden />{seatsLabel}
                    </p>
                  )}

                  {/* Rank 4 · the ONE primary CTA — the only gradient in the hero */}
                  {primary && (
                    <Link
                      href={primary.href}
                      className="group inline-flex h-12 w-full items-center justify-center gap-2 rounded-xl text-fs-md font-bold text-white shadow-sm transition-transform duration-200 hover:-translate-y-0.5 active:translate-y-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-offset-2 motion-reduce:transform-none"
                      style={{ backgroundImage: 'var(--primary-gradient)' }}
                    >
                      {primary.label}
                      <ArrowRight className="size-4 transition-transform group-hover:translate-x-1 motion-reduce:transform-none" aria-hidden />
                    </Link>
                  )}

                  {/* Rank 10 · trust — at the decision point, not in a page footer */}
                  {trust.length > 0 && (
                    <ul className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border/50 pt-4">
                      {trust.map(t => (
                        <li key={t.label} className="inline-flex items-center gap-1.5 text-fs-2xs font-medium text-muted-foreground">
                          {t.icon
                            ? createElement(t.icon, { className: 'size-3.5 shrink-0 text-primary/70', 'aria-hidden': true })
                            : <Check className="size-3.5 shrink-0 text-primary/70" aria-hidden />}
                          {t.label}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                {/* Poster — capped so hero height no longer depends on the uploaded
                    aspect ratio (ST42-O01). On mobile it is ordered AFTER the decision
                    block so price + CTA land in the first screen (ST42-OB-2). */}
                <div className="order-2 border-t border-border/50 p-3 lg:order-1 lg:border-b lg:border-t-0">
                  {hasPoster ? (
                    <button
                      type="button"
                      onClick={() => setPosterOpen(true)}
                      aria-label={`View ${title} poster full screen`}
                      className="group block w-full overflow-hidden rounded-xl bg-muted/30 outline-none focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-offset-2"
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={bannerUrl}
                        alt={`${title} event poster`}
                        fetchPriority="high"
                        decoding="async"
                        className="mx-auto block max-h-[240px] w-auto max-w-full object-contain transition-transform duration-500 ease-out group-hover:scale-[1.02] motion-reduce:transform-none sm:max-h-[300px] lg:max-h-[340px]"
                      />
                    </button>
                  ) : (
                    <div className="aspect-[16/9] w-full rounded-xl" style={{ backgroundImage: 'var(--primary-gradient)' }} aria-hidden />
                  )}
                </div>
              </div>
            </motion.div>
          )}

          {/* ═══ Narrative · metadata → secondary actions → organiser ═══════════ */}
          <div className="flex flex-col gap-7 lg:col-span-7 lg:col-start-1 lg:row-start-1">

            {/* Ranks 6/7 · metadata — a real definition list, grouped and labelled.
                Falls back to a plain list when a caller supplies unlabelled rows, so
                a <dd> is never emitted without its <dt>. */}
            {essentials.length > 0 && (
              <motion.div {...rise(0.16)}>
                {essentials.every(e => !!e.label) ? (
                  <dl className="grid gap-x-8 gap-y-5 sm:grid-cols-2">
                    {essentials.map((e, i) => (
                      <div key={i} className="flex items-start gap-3">
                        {e.icon && (
                          <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                            <e.icon className="size-4" aria-hidden />
                          </span>
                        )}
                        <div className="min-w-0">
                          <dt className={TYPE.label}>{e.label}</dt>
                          <dd className="mt-0.5 text-fs-base font-semibold text-foreground">{e.text}</dd>
                        </div>
                      </div>
                    ))}
                  </dl>
                ) : (
                  <ul className="grid gap-x-8 gap-y-5 sm:grid-cols-2">
                    {essentials.map((e, i) => (
                      <li key={i} className="flex items-start gap-3">
                        {e.icon && (
                          <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                            <e.icon className="size-4" aria-hidden />
                          </span>
                        )}
                        <span className="min-w-0 text-fs-base font-semibold text-foreground">{e.text}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </motion.div>
            )}

            {/* Secondary actions — deliberately after the primary CTA in the DOM */}
            <motion.div {...rise(0.24)} className="flex flex-wrap items-center gap-2.5">
              {calendar && <AddToCalendarButton {...calendar} label="Add to Calendar" className={SECONDARY_BTN} />}

              {/* More — progressive disclosure for the low-frequency actions */}
              <div ref={moreRef} className="relative inline-block" onKeyDown={onMenuKeyDown}>
                <button
                  ref={moreBtnRef}
                  type="button"
                  onClick={() => setMoreOpen(v => !v)}
                  aria-haspopup="menu"
                  aria-expanded={moreOpen}
                  aria-label="More actions"
                  className={SECONDARY_BTN}
                >
                  <MoreHorizontal className="size-4" aria-hidden />More
                  <ChevronDown className={cn('size-3.5 shrink-0 transition-transform', moreOpen && 'rotate-180')} aria-hidden />
                </button>

                {moreOpen && (
                  <div role="menu" aria-label="More actions" className="absolute left-0 z-50 mt-2 min-w-[196px] overflow-hidden rounded-xl border border-border bg-card shadow-lg">
                    <button type="button" role="menuitem" onClick={() => { onShare(); closeMore(false) }} className={MENU_ITEM}>
                      <Share2 className="size-4 shrink-0 text-muted-foreground" aria-hidden />Share
                    </button>
                    <div className="border-t border-border" />
                    <button type="button" role="menuitem" onClick={onCopy} className={MENU_ITEM}>
                      {copied ? <Check className="size-4 shrink-0 text-primary" aria-hidden /> : <Copy className="size-4 shrink-0 text-muted-foreground" aria-hidden />}
                      {copied ? 'Link copied' : 'Copy Link'}
                    </button>
                    {hasPoster && (
                      <>
                        <div className="border-t border-border" />
                        <a
                          role="menuitem"
                          href={bannerUrl}
                          download={posterName}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={() => closeMore(false)}
                          className={MENU_ITEM}
                        >
                          <Download className="size-4 shrink-0 text-muted-foreground" aria-hidden />Download Poster
                        </a>
                      </>
                    )}
                  </div>
                )}
              </div>
            </motion.div>

            {/* Rank 9 · organiser attribution */}
            {organizer?.name?.trim() && (
              <motion.div {...rise(0.28)} className="flex items-center gap-2 border-t border-border/60 pt-5 text-fs-sm text-muted-foreground">
                <span>Hosted by <span className="font-semibold text-foreground">{organizer.name}</span></span>
                {organizer.verified && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-fs-2xs font-bold text-primary">
                    <BadgeCheck className="size-3.5" aria-hidden />Verified
                  </span>
                )}
              </motion.div>
            )}
          </div>
        </div>
      </div>

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
