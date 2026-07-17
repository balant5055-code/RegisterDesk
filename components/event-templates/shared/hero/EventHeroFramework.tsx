'use client'

// EventHeroFramework — the shared event hero, owned once for every template.
//
// Composition: a two-column hero on a strict 12-column grid.
//
//   Overline (full width) — registration status · discipline, placed ABOVE the grid so
//     both columns start at the title block (the poster aligns to the title, not the
//     status pill).
//   Left (7 cols) — identity (icon · title · tagline) → date/venue → countdown → action
//     row, in a single natural top-down flow (gap-based, no distribution) so the CTA sits
//     immediately after the countdown with no floating gap.
//   Right (5 cols) — the collectible poster, top-aligned with the title block.
//   Trust strip (full width) — price · trust, ~24px below the grid.
//
// The poster shows the ENTIRE artwork (object-contain, matted, never clipped) with View
// / Download built into the frame (DS Button + shared ImageLightbox dialog). Breadcrumb
// lives in its own row above the hero, owned by the template shell.
//
// Time model: a shared client clock via useSyncExternalStore — `now` is null on the
// server and first paint (countdown shows "––"), so SSR and hydration agree, then it
// ticks. Phase + countdown are pure-derived in render (no effects, no layout shift).

import { createElement, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import Link from 'next/link'
import { motion, useReducedMotion } from 'framer-motion'
import { ArrowRight, Share2, Copy, Check, Maximize2, Download, MoreHorizontal, ChevronDown } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { AddToCalendarButton } from '@/components/event-templates/shared/ui/AddToCalendarButton'
import { ImageLightbox } from '@/components/event-templates/shared/ui/ImageLightbox'
import { Button } from '@/components/ui/button'
import { EASE, hoverLift } from '@/components/event-templates/shared/ui/framework'

const pad2 = (n: number) => String(n).padStart(2, '0')

// ── shared once-per-second clock (module-scoped; one interval for all heroes) ──
let clockMs: number | null = null
function subscribeClock(cb: () => void): () => void {
  clockMs = Date.now()
  const seed = typeof queueMicrotask !== 'undefined' ? queueMicrotask : (f: () => void) => setTimeout(f, 0)
  seed(cb)
  const id = setInterval(() => { clockMs = Date.now(); cb() }, 1000)
  return () => clearInterval(id)
}
function useNow(): number | null {
  return useSyncExternalStore(subscribeClock, () => clockMs, () => null)
}

// ─── Public contract ─────────────────────────────────────────────────────────────

export interface HeroCalendar {
  title: string; startDate: string; endDate: string
  startTime: string; endTime: string; location: string; description: string; slug: string
}

export interface HeroEssential { icon?: LucideIcon; text: string }

export interface EventHeroFrameworkProps {
  kicker?:  string
  title:    string
  tagline?: string
  /** Event-type icon for the identity badge (derived from the type registry by the caller) */
  icon?:    LucideIcon
  bannerUrl?: string

  /** Small status marker above the title (omit to hide) */
  status?: { label: string; tone?: 'open' | 'muted' }

  /** Date / time / venue rows, pre-formatted by the caller */
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

  /** Trust row */
  priceLabel?: string
  trust?:      string[]
}

type Phase = 'cancelled' | 'completed' | 'live' | 'closing' | 'upcoming' | 'closed'

// ─── Component ───────────────────────────────────────────────────────────────────

export function EventHeroFramework({
  kicker, title, tagline, icon, bannerUrl, status, essentials, timing,
  primary, calendar, priceLabel, trust = [],
}: EventHeroFrameworkProps) {
  const reduce = useReducedMotion()
  const now    = useNow()
  const [copied,  setCopied]        = useState(false)
  const [posterOpen, setPosterOpen] = useState(false)
  const [moreOpen, setMoreOpen]     = useState(false)
  const moreRef = useRef<HTMLDivElement>(null)

  const { startDate, startTime = '', endDate = '', registrationOpen, salesCloseDate = '', lifecycleStatus, startLabel } = timing

  const phase: Phase = (() => {
    if (lifecycleStatus === 'cancelled') return 'cancelled'
    if (lifecycleStatus === 'completed') return 'completed'
    if (now === null) return registrationOpen ? 'upcoming' : 'closed'
    const d = new Date(now)
    const today = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
    const end = endDate || startDate
    if (end && today > end) return 'completed'
    if (startDate && today >= startDate && (!end || today <= end)) return 'live'
    if (!registrationOpen) return 'closed'
    if (salesCloseDate && salesCloseDate >= today) {
      const days = Math.ceil((new Date(`${salesCloseDate}T23:59:59`).getTime() - now) / 86_400_000)
      if (days <= 3) return 'closing'
    }
    return 'upcoming'
  })()

  const targetMs =
    phase === 'upcoming' ? new Date(`${startDate}T${startTime || '00:00'}:00`).getTime()
      : phase === 'closing' ? new Date(`${salesCloseDate}T23:59:59`).getTime()
        : NaN
  const cd = (now !== null && !Number.isNaN(targetMs))
    ? (() => {
        const ts = Math.max(0, Math.floor((targetMs - now) / 1000))
        return { d: Math.floor(ts / 86400), h: Math.floor((ts % 86400) / 3600), m: Math.floor((ts % 3600) / 60) }
      })()
    : null

  const showTimer = phase === 'upcoming' || phase === 'closing'
  const heading   = phase === 'closing' ? 'Registration closes in' : (startLabel ?? 'Starts in')
  const statusWord =
    phase === 'live' ? 'Happening now'
      : phase === 'completed' ? 'Event concluded'
        : phase === 'cancelled' ? 'Event cancelled'
          : phase === 'closed' ? 'Registration closed' : ''
  const cdSr = showTimer && cd ? `${heading} ${cd.d} days, ${cd.h} hours, ${cd.m} minutes` : statusWord

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

  // Close the More menu on outside click (mirrors the AddToCalendarButton idiom).
  useEffect(() => {
    if (!moreOpen) return
    const handler = (e: MouseEvent) => {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) setMoreOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [moreOpen])

  // One shared shape for every secondary control so the group aligns perfectly.
  const SECONDARY_BTN =
    'inline-flex h-10 items-center gap-2 rounded-full border border-border/80 bg-card px-4 text-[13.5px] font-semibold text-foreground transition-colors hover:border-foreground/30 hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40'
  const MENU_ITEM =
    'flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left text-[13px] font-medium text-foreground transition-colors hover:bg-muted/60'

  const rise = (delay: number) => reduce
    ? {}
    : { initial: { opacity: 0, y: 14 }, animate: { opacity: 1, y: 0 },
        transition: { duration: 0.55, ease: EASE, delay } }

  const cdSegments = [{ v: cd?.d, l: 'Days' }, { v: cd?.h, l: 'Hrs' }, { v: cd?.m, l: 'Min' }]
  const posterName = `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'event'}-poster`

  return (
    <section aria-label="Event overview" className="relative overflow-hidden border-b border-border/60 bg-white">
      <div className="mx-auto max-w-7xl px-5 py-7 sm:px-8 sm:py-8 lg:px-8 lg:py-10">

        {/* ── Overline: registration status · discipline (full width, above the grid so
               both columns start at the title, not the status pill) ── */}
        {(status || kicker) && (
          <motion.div {...rise(0.04)}>
            <div className="inline-flex items-center gap-2.5 rounded-full border border-border/70 bg-card px-3.5 py-1.5 shadow-sm">
              {status && (
                <span className="inline-flex items-center gap-2 text-[11px] font-semibold text-foreground">
                  <span className={cn('size-1.5 rounded-full', status.tone === 'open' ? 'bg-primary' : 'bg-muted-foreground/50')} aria-hidden />
                  {status.label}
                </span>
              )}
              {status && kicker && <span aria-hidden className="h-3 w-px bg-border" />}
              {kicker && (
                <span className="text-[11px] font-bold uppercase tracking-[0.14em] text-primary">{kicker}</span>
              )}
            </div>
          </motion.div>
        )}

        {/* ── 12-column grid · left content (7) · poster (5) · top-aligned ── */}
        <div className="mt-5 grid grid-cols-1 items-start gap-8 lg:grid-cols-12 lg:gap-12">

          {/* Left content — identity → date/venue → countdown → CTA (natural flow) */}
          <div className="flex flex-col gap-6 lg:col-span-7">

            {/* Event identity — icon badge · name (animated underline) · tagline */}
            <motion.div {...rise(0.1)} className="flex flex-wrap items-center gap-x-4 gap-y-2.5">
              {icon && (
                <span className="flex size-12 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary ring-1 ring-primary/15">
                  {createElement(icon, { className: 'size-6', 'aria-hidden': true })}
                </span>
              )}

              <div className="flex flex-col gap-1.5">
                <h1 className="text-[clamp(28px,2.7vw,38px)] font-bold leading-[1.08] tracking-[-0.02em] text-foreground">
                  {title}
                </h1>
                {tagline && (
                  <span className="text-[clamp(14px,1.2vw,16px)] font-medium text-muted-foreground">{tagline}</span>
                )}
              </div>
            </motion.div>

            {/* Date · venue — immediately below the subtitle */}
            {essentials.length > 0 && (
              <motion.div {...rise(0.16)} className="flex flex-col gap-2">
                {essentials.map((e, i) => (
                  <div key={i} className="flex items-center gap-2.5 text-[14px] font-medium text-foreground/85">
                    {e.icon && <e.icon className="size-4 shrink-0 text-primary/70" aria-hidden />}
                    <span>{e.text}</span>
                  </div>
                ))}
              </motion.div>
            )}

            {/* Countdown — follows date/venue */}
            {(showTimer || statusWord) && (
              <motion.div {...rise(0.2)} {...(showTimer ? { role: 'timer', 'aria-label': cdSr } : {})}>
                {showTimer ? (
                  <div className="flex items-center gap-2.5">
                    <span className="text-[10.5px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/70">{heading}</span>
                    <span aria-hidden className="flex items-baseline gap-2.5 tabular-nums">
                      {cdSegments.map(({ v, l }) => (
                        <span key={l} className="flex items-baseline gap-0.5">
                          <span className="text-[18px] font-bold leading-none tracking-tight text-foreground">{v == null ? '––' : pad2(v)}</span>
                          <span className="text-[11px] font-semibold lowercase text-muted-foreground">{l.charAt(0).toLowerCase()}</span>
                        </span>
                      ))}
                    </span>
                  </div>
                ) : (
                  <span className="inline-flex items-center gap-2 text-[13px] font-semibold text-muted-foreground">
                    {phase === 'live' && !reduce && <span className="size-2 rounded-full bg-primary motion-safe:animate-pulse" aria-hidden />}
                    {statusWord}
                  </span>
                )}
              </motion.div>
            )}

            {/* Action row — immediately follows the countdown; one baseline */}
            <motion.div {...rise(0.26)} className="flex flex-wrap items-center gap-2.5">
              {primary && (
                <Link
                  href={primary.href}
                  className="group inline-flex h-10 items-center gap-2 rounded-full px-6 text-[14px] font-bold text-white shadow-sm transition-transform duration-200 hover:-translate-y-0.5 active:translate-y-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-offset-2"
                  style={{ backgroundImage: 'var(--primary-gradient)' }}
                >
                  {primary.label}
                  <ArrowRight className="size-4 transition-transform group-hover:translate-x-1" aria-hidden />
                </Link>
              )}
              {calendar && <AddToCalendarButton {...calendar} label="Calendar" className={SECONDARY_BTN} />}

              {/* More — progressive disclosure for secondary actions */}
              <div ref={moreRef} className="relative inline-block">
                <button
                  type="button"
                  onClick={() => setMoreOpen(v => !v)}
                  aria-haspopup="true"
                  aria-expanded={moreOpen}
                  className={SECONDARY_BTN}
                >
                  <MoreHorizontal className="size-4" aria-hidden />More
                  <ChevronDown className={cn('size-3.5 shrink-0 transition-transform', moreOpen && 'rotate-180')} aria-hidden />
                </button>

                {moreOpen && (
                  <div role="menu" className="absolute left-0 z-50 mt-2 min-w-[196px] overflow-hidden rounded-xl border border-border bg-card shadow-lg">
                    <button type="button" role="menuitem" onClick={() => { onShare(); setMoreOpen(false) }} className={MENU_ITEM}>
                      <Share2 className="size-4 shrink-0 text-muted-foreground" aria-hidden />Share
                    </button>
                    <div className="border-t border-border" />
                    <button type="button" role="menuitem" onClick={onCopy} className={MENU_ITEM}>
                      {copied ? <Check className="size-4 shrink-0 text-primary" aria-hidden /> : <Copy className="size-4 shrink-0 text-muted-foreground" aria-hidden />}
                      {copied ? 'Link copied' : 'Copy Link'}
                    </button>
                    {bannerUrl?.trim() && (
                      <>
                        <div className="border-t border-border" />
                        <a
                          role="menuitem"
                          href={bannerUrl}
                          download={posterName}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={() => setMoreOpen(false)}
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
          </div>

          {/* Poster (5 cols) — top-aligned with the title block */}
          <motion.div {...rise(0.15)} className="lg:col-span-5">
            <motion.div
              whileHover={hoverLift(reduce, -5)}
              transition={{ duration: 0.3, ease: EASE }}
              className="group mx-auto flex w-full max-w-xs flex-col rounded-2xl border border-border/50 bg-card p-2.5 shadow-lg shadow-black/[0.06] ring-1 ring-black/[0.02] transition-shadow duration-300 hover:shadow-xl hover:shadow-black/10 sm:max-w-sm lg:max-w-md lg:mx-0"
            >
              <div className="overflow-hidden rounded-xl bg-muted/30">
                {bannerUrl?.trim() ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={bannerUrl}
                    alt={`${title} event poster`}
                    fetchPriority="high"
                    decoding="async"
                    className="block h-auto w-full object-contain transition-transform duration-500 ease-out group-hover:scale-[1.02] motion-reduce:transform-none"
                  />
                ) : (
                  <div className="aspect-[4/5] w-full" style={{ backgroundImage: 'var(--primary-gradient)' }} aria-hidden />
                )}
              </div>

              {bannerUrl?.trim() && (
                <div className="mt-3 px-0.5 pb-0.5">
                  <Button type="button" variant="outline" size="sm" onClick={() => setPosterOpen(true)} className="w-full">
                    <Maximize2 className="size-4" aria-hidden />View Poster
                  </Button>
                </div>
              )}
            </motion.div>
          </motion.div>

        </div>

        {/* ── Trust strip — sits ~24px below the hero content, full width ── */}
        {(priceLabel || trust.length > 0) && (
          <motion.div {...rise(0.3)} className="mt-6 border-t border-border/60 pt-6">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12px] text-muted-foreground">
              {priceLabel && <span className="text-[13px] font-semibold text-foreground">{priceLabel}</span>}
              {priceLabel && trust.length > 0 && <span aria-hidden className="h-3.5 w-px bg-border" />}
              {trust.map(t => (
                <span key={t} className="inline-flex items-center gap-1.5">
                  <Check className="size-3.5 text-primary/70" aria-hidden />{t}
                </span>
              ))}
            </div>
          </motion.div>
        )}
      </div>

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
  )
}
