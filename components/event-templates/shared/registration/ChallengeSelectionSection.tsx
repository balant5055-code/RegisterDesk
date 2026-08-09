'use client'

// ChallengeSelectionSection — the tabbed registration experience.
//
// RD-ST6.0 architecture refactor. The previous layout showed every pass as a card AND
// repeated the selected pass in a second panel: the same name, price, availability and
// benefits rendered twice, which is what produced the empty space, the weak focus and
// the extra scrolling. The selected pass is now the single source of truth.
//
//   TABS      — one pill per pass. Selection only; they carry no duplicated detail.
//   PANEL     — exactly ONE, describing the selected pass: identity → overview grid →
//               what's included → notes → primary CTA.
//   STICKY BAR— a full-width bar that mirrors the same selection and reuses the same
//               register href. It appears only once the in-panel CTA leaves the
//               viewport, so the two never compete.
//
// Everything derives from `selectedId`. There is no second copy of the selection, the
// price, the availability or the register action anywhere in this file.
//
// Data comes exclusively from `passesToChallenges`; nothing is hardcoded and every
// field self-hides when the organiser has not set it.

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { buildRegisterHref } from '@/lib/events/registerHref'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import {
  ShieldCheck, Zap, RotateCcw, ArrowRight, Info,
  Flag, UserRound, CircleCheck, CalendarClock, Ticket,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { formatINR, formatDateShort } from '@/components/event-templates/shared/utils/format'
import {
  SectionShell, EventSectionHeader, TYPE, CARD, EASE, BRAND_GRADIENT,
  EVENT_CONTAINER, benefitIcon,
} from '@/components/event-templates/shared/ui/framework'
// ST41-I01: the data model lives in a directive-free module so Server Components can
// call passesToChallenges(). The TYPE is re-exported here (types erase — no client
// reference), but callers must import the FUNCTION from challengeModel directly.
import type { Challenge } from '@/components/event-templates/shared/registration/challengeModel'

export type { Challenge }

// ─── Derived labels ──────────────────────────────────────────────────────────────

function slotsLabel(c: Challenge, unit: string): string | null {
  if (c.status === 'sold_out') return 'Sold out'
  if (c.remaining == null)     return null            // unlimited — no false scarcity
  return `${c.remaining.toLocaleString('en-IN')} ${unit} left`
}

/** Age eligibility, phrased from whichever bounds the organiser actually set. */
function ageLabel(c: Challenge): string | null {
  const min = c.minAge ?? null
  const max = c.maxAge ?? null
  if (min == null && max == null) return null
  if (min != null && max != null) return `${min}–${max} yrs`
  if (min != null)                return `${min}+ yrs`
  return `Up to ${max} yrs`
}

function registrationLabel(c: Challenge, open: boolean): string {
  if (!open)               return 'Closed'
  if (!c.selectable)       return 'Sold out'
  return 'Open'
}

// ─── Panel rhythm (ST6.1) ────────────────────────────────────────────────────────
// One padding scale for every band — 16px mobile, 20px tablet, 24px desktop — so the
// four sections share an identical internal margin and read as one system.
const SECTION_PAD     = 'p-4 sm:p-5 lg:p-6'

// ─── Props ───────────────────────────────────────────────────────────────────────

export interface ChallengeSelectionSectionProps {
  slug:              string
  challenges:        Challenge[]
  registrationOpen:  boolean
  closedMessage?:    string
  hasRefundPolicy?:  boolean
  /** Terminology — lets other templates reuse the same component. */
  eyebrow?:          string   // 'Choose Your Challenge'
  title?:            string   // headline; hidden when absent
  subtitle?:         string
  panelTitle?:       string   // 'Your Challenge'
  ctaLabel?:         string   // 'Register'
  unit?:             string   // 'slots'
}

// ─── Component ───────────────────────────────────────────────────────────────────

export function ChallengeSelectionSection({
  slug, challenges, registrationOpen, closedMessage, hasRefundPolicy,
  eyebrow = 'Choose Your Challenge', title, subtitle,
  panelTitle = 'Selected Pass', ctaLabel = 'Register', unit = 'slots',
}: ChallengeSelectionSectionProps) {
  const reduce  = useReducedMotion()
  const tabsRef = useRef<(HTMLButtonElement | null)[]>([])
  const ctaRef  = useRef<HTMLDivElement>(null)

  // ── THE single source of truth ──
  const firstSelectable = challenges.find(c => c.selectable)?.id ?? challenges[0]?.id ?? ''
  const [selectedId, setSelectedId] = useState(firstSelectable)
  const selected = challenges.find(c => c.id === selectedId)

  // The sticky bar shows only once the in-panel CTA has scrolled out of view, so the
  // page never presents two competing register actions at the same time.
  const [ctaOffscreen, setCtaOffscreen] = useState(false)
  useEffect(() => {
    const el = ctaRef.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver(
      ([entry]) => setCtaOffscreen(!entry.isIntersecting),
      { rootMargin: '0px 0px -20% 0px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [])

  // Standard tabs keyboard model: arrows move and activate, Home/End jump.
  const focusTab = (i: number) => {
    const c = challenges[i]
    if (!c) return
    setSelectedId(c.id)
    tabsRef.current[i]?.focus()
  }
  const onTabKey = (e: React.KeyboardEvent) => {
    const i = challenges.findIndex(c => c.id === selectedId)
    if (['ArrowRight', 'ArrowDown'].includes(e.key)) { e.preventDefault(); focusTab((i + 1) % challenges.length) }
    else if (['ArrowLeft', 'ArrowUp'].includes(e.key)) { e.preventDefault(); focusTab((i - 1 + challenges.length) % challenges.length) }
    else if (e.key === 'Home') { e.preventDefault(); focusTab(0) }
    else if (e.key === 'End')  { e.preventDefault(); focusTab(challenges.length - 1) }
  }

  const canRegister  = registrationOpen && !!selected && selected.selectable
  const registerHref = selected ? buildRegisterHref(slug, selected.id) : '#'

  const trust = [
    { icon: ShieldCheck, label: 'Secure Registration' },
    { icon: Zap,         label: 'Instant Confirmation' },
    hasRefundPolicy && { icon: RotateCcw, label: 'Easy Refund' },
  ].filter(Boolean) as { icon: LucideIcon; label: string }[]

  if (challenges.length === 0) return null

  // Overview — only fields the organiser actually set. No placeholders.
  const overview = selected ? ([
    selected.distance          && { icon: Flag,          label: 'Distance',     value: selected.distance },
    ageLabel(selected)         && { icon: UserRound,    label: 'Age',          value: ageLabel(selected)! },
    { icon: CircleCheck, label: 'Registration', value: registrationLabel(selected, registrationOpen) },
    selected.closesOn          && { icon: CalendarClock, label: 'Closing',      value: formatDateShort(selected.closesOn) },
    slotsLabel(selected, unit) && { icon: Ticket,        label: 'Availability', value: slotsLabel(selected, unit)! },
  ].filter(Boolean) as { icon: LucideIcon; label: string; value: string }[]) : []

  const ctaText = selected?.isFree ? `${ctaLabel} Free` : `${ctaLabel} Now`

  return (
    <>
      <SectionShell id="register" maxW="6xl" bg="muted" border={false}>

        <EventSectionHeader eyebrow={eyebrow} title={title} description={subtitle} />

        {!registrationOpen && (
          <div className="mb-6 rounded-2xl border border-amber-200 bg-amber-50 px-5 py-3.5 text-fs-sm font-medium text-amber-800">
            {closedMessage || 'Registrations are currently closed for this event.'}
          </div>
        )}

        {/* ══════════ TABS ══════════
            Desktop: one row. Tablet: wraps. Mobile: horizontal scroll.
            Both states carry an equal-width border so selection cannot shift layout. */}
        <div
          role="tablist"
          aria-label={eyebrow}
          onKeyDown={onTabKey}
          className={cn(
            'flex gap-2 overflow-x-auto pb-1 md:flex-wrap md:overflow-visible md:pb-0',
            '[scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
          )}
        >
          {challenges.map((c, i) => {
            const isSel = c.id === selectedId
            return (
              <button
                key={c.id}
                ref={el => { tabsRef.current[i] = el }}
                type="button"
                role="tab"
                id={`challenge-tab-${c.id}`}
                aria-selected={isSel}
                aria-controls="challenge-panel"
                tabIndex={isSel ? 0 : -1}
                onClick={() => setSelectedId(c.id)}
                className={cn(
                  'shrink-0 rounded-full border px-5 py-2.5 text-fs-md font-bold outline-none',
                  'transition-[background-color,border-color,color,box-shadow] duration-200',
                  'focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-offset-2',
                  isSel
                    ? cn(BRAND_GRADIENT, 'border-transparent text-white shadow-md')
                    : 'border-border bg-card text-foreground hover:border-foreground/25 hover:bg-muted/40',
                  !c.selectable && !isSel && 'opacity-55',
                )}
              >
                {c.distance || c.name}
              </button>
            )
          })}
        </div>

        {/* ══════════ THE ONE PANEL ══════════ */}
        <div
          role="tabpanel"
          id="challenge-panel"
          aria-labelledby={selected ? `challenge-tab-${selected.id}` : undefined}
          className={cn(CARD, 'mt-6 overflow-hidden shadow-lg')}
        >
          <AnimatePresence mode="wait" initial={false}>
            {selected && (
              <motion.div
                key={selected.id}
                initial={reduce ? false : { opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={reduce ? { opacity: 0 } : { opacity: 0, y: -6 }}
                transition={{ duration: 0.15, ease: EASE }}
              >
                {/* ── 1 · Identity ── */}
                <div className={SECTION_PAD}>
                  <span className={cn(
                    'inline-flex items-center gap-2 rounded-full px-3 py-1 text-fs-2xs font-bold',
                    canRegister
                      ? 'bg-primary/10 text-primary ring-1 ring-primary/20'
                      : 'bg-muted text-muted-foreground ring-1 ring-border',
                  )}>
                    <span className={cn('size-1.5 rounded-full', canRegister ? 'bg-primary' : 'bg-muted-foreground/60')} aria-hidden />
                    Registration {registrationLabel(selected, registrationOpen)}
                  </span>

                  <div className="mt-4 flex flex-wrap items-end justify-between gap-x-8 gap-y-3">
                    {/* RD-ST5.2 P1.2 — was an inline clamp(28px→36px), which made this
                        card title LARGER than the section h2 containing it at every
                        width. Both now resolve through shared TYPE roles: `panelTitle`
                        stays strictly under `sectionTitle` at both breakpoints, and the
                        price uses the same `statValue` role as the organiser stats. */}
                    <h3 className={TYPE.panelTitle}>
                      {selected.name}
                    </h3>
                    <p className={cn('shrink-0', TYPE.statValue)}>
                      {selected.isFree ? 'Free' : formatINR(selected.price)}
                    </p>
                  </div>

                  {selected.description && (
                    <p className="mt-4 max-w-2xl text-fs-base leading-relaxed text-muted-foreground">
                      {selected.description}
                    </p>
                  )}
                </div>

                {/* ── 2 · Overview ── */}
                {overview.length > 0 && (
                  <div className={cn(SECTION_PAD, 'border-t border-border/40 bg-muted/30')}>
                    <h4 className={TYPE.cardTitle}>Overview</h4>
                    <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-3 lg:grid-cols-5">
                      {overview.map(o => (
                        <div key={o.label} className="flex min-w-0 items-start gap-2.5">
                          <o.icon className="mt-0.5 size-[18px] shrink-0 text-primary" aria-hidden />
                          <div className="min-w-0">
                            <dt className={TYPE.label}>{o.label}</dt>
                            <dd className="mt-1 truncate text-fs-md font-semibold text-foreground">{o.value}</dd>
                          </div>
                        </div>
                      ))}
                    </dl>
                  </div>
                )}

                {/* ── 3 · What's Included — labels, never IDs ── */}
                {selected.benefits.length > 0 && (
                  <div className={cn(SECTION_PAD, 'border-t border-border/40')}>
                    <h4 className={TYPE.cardTitle}>What&apos;s Included</h4>
                    <ul className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                      {selected.benefits.map(b => {
                        const Icon = benefitIcon(b)
                        return (
                          <li
                            key={b}
                            className="flex min-h-14 items-center gap-3 rounded-xl bg-muted/50 px-3.5 py-3"
                          >
                            <Icon className="size-[18px] shrink-0 text-primary" aria-hidden />
                            <span className="min-w-0 text-fs-sm font-semibold leading-snug text-foreground">{b}</span>
                          </li>
                        )
                      })}
                    </ul>

                    {/* Booking / policy notes — derived from real builder flags */}
                    {selected.notes.length > 0 && (
                      <ul className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-2">
                        {selected.notes.map(n => (
                          <li key={n} className="inline-flex items-center gap-1.5 text-fs-sm text-muted-foreground">
                            <Info className="size-3.5 shrink-0 text-primary/60" aria-hidden />{n}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}

                {/* ── 4 · CTA ── */}
                <div ref={ctaRef} className={cn(SECTION_PAD, 'border-t border-border/40 bg-muted/30')}>
                  {canRegister ? (
                    <Link
                      href={registerHref}
                      className={cn(
                        'group flex h-14 w-full items-center justify-center gap-2 rounded-xl text-fs-lg font-bold text-white shadow-md',
                        'transition-transform duration-200 hover:-translate-y-0.5 active:translate-y-0 motion-reduce:transform-none',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-offset-2',
                        BRAND_GRADIENT,
                      )}
                    >
                      {ctaText}
                      <ArrowRight className="size-5 transition-transform group-hover:translate-x-1 motion-reduce:transform-none" aria-hidden />
                    </Link>
                  ) : (
                    <span className="flex h-14 w-full items-center justify-center rounded-xl bg-muted text-fs-md font-semibold text-muted-foreground">
                      {selected.selectable ? 'Registrations closed' : 'Sold out'}
                    </span>
                  )}

                  <ul className="mt-4 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-fs-2xs text-muted-foreground">
                    {trust.map(({ label }, i) => (
                      <li key={label} className="inline-flex items-center gap-2">
                        {i > 0 && <span aria-hidden className="text-muted-foreground/40">&bull;</span>}
                        {label}
                      </li>
                    ))}
                  </ul>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </SectionShell>

      {/* ══════════ STICKY BAR ══════════
          Same `selectedId`, same `registerHref` — no second state, no second action. */}
      <AnimatePresence>
        {selected && canRegister && ctaOffscreen && (
          <motion.div
            initial={reduce ? false : { y: '100%' }}
            animate={{ y: 0 }}
            exit={reduce ? { opacity: 0 } : { y: '100%' }}
            transition={{ duration: 0.2, ease: EASE }}
            className="fixed inset-x-0 bottom-0 z-50 border-t border-border bg-card/95 shadow-[0_-6px_24px_rgb(0_0_0/0.08)] backdrop-blur-md"
          >
            <div className={cn(EVENT_CONTAINER, 'flex items-center gap-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]')}>
              <div className="min-w-0 flex-1">
                <p className={cn('hidden sm:block', TYPE.label)}>{panelTitle}</p>
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                  <span className="truncate text-fs-md font-bold text-foreground">{selected.name}</span>
                  <span className="shrink-0 text-fs-lg font-extrabold tracking-tight text-foreground">
                    {selected.isFree ? 'Free' : formatINR(selected.price)}
                  </span>
                  <span className="hidden shrink-0 items-center gap-1.5 text-fs-2xs font-semibold text-primary sm:inline-flex">
                    <span className="size-1.5 rounded-full bg-primary" aria-hidden />
                    Registration Open
                  </span>
                </div>
              </div>

              <Link
                href={registerHref}
                className={cn(
                  'group inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-xl px-5 text-fs-md font-bold text-white shadow-sm sm:px-7',
                  'transition-transform duration-200 hover:-translate-y-0.5 active:translate-y-0 motion-reduce:transform-none',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-offset-2',
                  BRAND_GRADIENT,
                )}
              >
                {ctaText}
                <ArrowRight className="size-4 transition-transform group-hover:translate-x-1 motion-reduce:transform-none" aria-hidden />
              </Link>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}
