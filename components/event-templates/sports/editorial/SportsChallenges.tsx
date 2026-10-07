'use client'

// ─── SportsChallenges — the distance index and the chosen distance ───────────
//
// SPORTS-ONLY. The DATA MODEL is untouched: `passesToChallenges` (challengeModel.ts)
// still normalises passes, availability and race categories into Challenge[], and
// `buildRegisterHref` still builds the one register link. Only the composition here
// is new.
//
//   ┌ index (4/12) ────────────┬ the chosen distance (8/12) ───────────────────┐
//   │ 01 —— 5 KM WALKATHON ₹500│            5            KM     ₹500           │
//   │ 02 —— 5 KM MARATHON  ₹500│         WALKATHON                             │
//   │ 03 —— 10 KM MARATHON ₹1k │  ─────────────────────────────────────────    │
//   └──────────────────────────┤  AGE        CLOSING      AVAILABILITY  REG.   │
//                              │  8–100 yrs  21 Aug 2026  2,705 slots   Closed │
//                              │  ─────────────────────────────────────────    │
//                              │  INCLUDED  E-Certificate · Medical Support …  │
//                              │  —— REGISTRATIONS CLOSED      (or Register)   │
//                              └───────────────────────────────────────────────┘
//
// The distance itself is the loud object: the numeral is set at display scale with
// its unit beside it, which is the one number a runner is actually choosing between.
// Everything else is type on hairlines — no card, no pill, no alert band, no shadow,
// no disabled button, and no platform trust claims (those are not event data).
//
// Everything derives from `selectedId`: one price, one availability, one register
// action on the page. The sticky bar mirrors the same selection and appears only once
// the in-section action has scrolled away.

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { ArrowRight } from 'lucide-react'
import { buildRegisterHref } from '@/lib/events/registerHref'
import { DownloadTicketLink } from '@/components/event-templates/shared/registration/DownloadTicketLink'
import { cn } from '@/lib/utils/cn'
import { formatINR, formatDateShort } from '@/components/event-templates/shared/utils/format'
import { BRAND_GRADIENT, EVENT_CONTAINER, benefitIcon } from '@/components/event-templates/shared/ui/framework'
import type { Challenge } from '@/components/event-templates/shared/registration/challengeModel'
import { FIELD, INDEX, OVERLINE, Rule, SectionHead, SportsSection, idx, NUM, UNIT, UNIT_LG, CAPTION, VALUE, ITEM, BODY } from './primitives'

// ─── Derived labels (the same rules the shared section applied) ──────────────────

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
  if (!open)         return 'Closed'
  if (!c.selectable) return 'Sold out'
  return 'Open'
}

/**
 * The distance as a numeral and a unit, read out of the organiser's own string
 * ("5 Km Walkathon" → 5 · KM · Walkathon). A distance that is not numeric keeps its
 * whole text as the word — nothing is fabricated and nothing is dropped.
 */
/** A distance in km (0 when the organiser's string is not a distance). */
export function kmOf(c: Challenge): number {
  const { figure, unit } = splitDistance(c)
  const n = Number.parseFloat(figure)
  if (!Number.isFinite(n) || n <= 0) return 0
  if (unit === 'M') return n / 1000
  if (/^MI/.test(unit)) return n * 1.609
  return n
}

export function splitDistance(c: Challenge): { figure: string; unit: string; word: string } {
  const source = (c.distance || c.name || '').trim()
  const m = /^(\d+(?:\.\d+)?)\s*(km|k|mi|miles?|m)\b\s*(.*)$/i.exec(source)
  if (!m) return { figure: '', unit: '', word: source }
  const rest = m[3].trim()
  return { figure: m[1], unit: m[2].toUpperCase(), word: rest || c.name.trim() }
}

const REGISTER_LINK = cn(
  'group inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-surface px-6 text-fs-md font-bold text-white',
  'transition-transform duration-200 hover:-translate-y-0.5 active:translate-y-0 motion-reduce:transform-none',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-action/50 focus-visible:ring-offset-2',
  BRAND_GRADIENT,
)

// ─── Props ───────────────────────────────────────────────────────────────────────

export interface SportsChallengesProps {
  slug:             string
  challenges:       Challenge[]
  registrationOpen: boolean
  eyebrow?:         string
  title?:           string
  subtitle?:        string
  ctaLabel?:        string
  unit?:            string
}

// ─── Component ───────────────────────────────────────────────────────────────────

export function SportsChallenges({
  slug, challenges, registrationOpen,
  eyebrow = 'Choose Your Challenge', title = 'Find Your Perfect Distance', subtitle,
  ctaLabel = 'Register', unit = 'slots',
}: SportsChallengesProps) {
  const tabsRef = useRef<(HTMLButtonElement | null)[]>([])
  const ctaRef  = useRef<HTMLDivElement>(null)

  // ── THE single source of truth ──
  const firstSelectable = challenges.find(c => c.selectable)?.id ?? challenges[0]?.id ?? ''
  const [selectedId, setSelectedId] = useState(firstSelectable)
  const selected = challenges.find(c => c.id === selectedId)

  // The sticky bar shows only once the in-section action has scrolled out of view, so
  // the page never presents two competing register actions at the same time.
  const [ctaOffscreen, setCtaOffscreen] = useState(false)
  useEffect(() => {
    const el = ctaRef.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver(([entry]) => setCtaOffscreen(!entry.isIntersecting), { rootMargin: '0px 0px -20% 0px' })
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
  const ctaText      = selected?.isFree ? `${ctaLabel} Free` : `${ctaLabel} Now`

  if (challenges.length === 0) return null

  // Up to four distances fit side by side on a phone; more than that stack.
  const rowOnPhone = challenges.length <= 4
  // The longest distance, in km, so each tab's course bar is drawn to scale.
  const maxKm = Math.max(0, ...challenges.map(kmOf))

  // Facts — only fields the organiser actually set. No placeholders.
  const facts = selected ? ([
    ageLabel(selected)         && { label: 'Age',          value: ageLabel(selected)! },
    selected.closesOn          && { label: 'Closing',      value: formatDateShort(selected.closesOn) },
    slotsLabel(selected, unit) && { label: 'Availability', value: slotsLabel(selected, unit)! },
    { label: 'Registration', value: registrationLabel(selected, registrationOpen) },
  ].filter(Boolean) as { label: string; value: string }[]) : []

  const shape = selected ? splitDistance(selected) : null

  return (
    <>
      <SportsSection id="register">
        <SectionHead
          eyebrow={eyebrow}
          title={title}
          lead={subtitle}
          aside={
            <p className={cn(OVERLINE, 'justify-center', registrationOpen ? 'text-action' : 'text-muted-foreground')}>
              <Rule className={registrationOpen ? undefined : 'bg-border'} />
              {registrationOpen ? 'Registration open' : 'Registration closed'}
              <Rule className={registrationOpen ? undefined : 'bg-border'} />
            </p>
          }
        />

        {/* ── THE INDEX — one row of distances, centred, divided by hairlines ── */}
        <ol
          role="tablist"
          aria-label={eyebrow}
          onKeyDown={onTabKey}
          // Up to four distances sit side by side at EVERY width (a phone stacked three
          // 125px rows — the bulkiest thing on the page); five or more stack below sm.
          className={cn(
            'mx-auto mt-8 grid max-w-5xl border-y border-border/60',
            rowOnPhone
              ? 'auto-cols-fr grid-flow-col divide-x divide-border/60'
              : 'grid-cols-1 sm:auto-cols-fr sm:grid-flow-col sm:divide-x sm:divide-border/60',
          )}
        >
          {challenges.map((c, i) => {
            const isSel = c.id === selectedId
            const s = splitDistance(c)
            return (
              <li key={c.id} className={cn('min-w-0', !rowOnPhone && 'border-b border-border/60 last:border-b-0 sm:border-b-0')}>
                <button
                  ref={el => { tabsRef.current[i] = el }}
                  type="button"
                  role="tab"
                  id={`challenge-tab-${c.id}`}
                  aria-selected={isSel}
                  aria-controls="challenge-panel"
                  tabIndex={isSel ? 0 : -1}
                  onClick={() => setSelectedId(c.id)}
                  className={cn(
                    'group relative flex w-full flex-col items-center gap-1 px-2 py-3.5 text-center outline-none transition-colors sm:px-4 sm:py-4',
                    'focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-action',
                    isSel ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {/* the selected distance is marked on the rule above it */}
                  <span aria-hidden className={cn('absolute inset-x-0 -top-px mx-auto h-0.5 w-16 transition-colors', isSel ? 'bg-action' : 'bg-transparent')} />
                  <span className={INDEX}>{idx(i)}</span>
                  <span className="flex items-baseline gap-1">
                    <span className={cn(NUM, 'text-fs-xl transition-colors', isSel ? 'text-hero-ink' : 'text-hero-ink/60')}>
                      {s.figure || c.name}
                    </span>
                    {s.unit && <span className={UNIT}>{s.unit}</span>}
                  </span>
                  {s.figure && <span className="max-w-full truncate text-fs-2xs font-semibold uppercase tracking-[0.14em]">{s.word}</span>}
                  <span className={cn(CAPTION, 'mt-0.5 tabular-nums')}>
                    {!c.selectable ? 'Sold out' : (c.isFree ? 'Free' : formatINR(c.price))}
                  </span>
                  {/* The course bar — each distance drawn to scale against the longest,
                      so 10 KM visibly runs twice as far as 5 KM. */}
                  {maxKm > 0 && kmOf(c) > 0 && (
                    <span aria-hidden className="mt-2 block h-[3px] w-full max-w-[7rem] overflow-hidden bg-border/70">
                      <span
                        className={cn('block h-full transition-colors', isSel ? 'bg-action' : 'bg-hero-accent-rule/70')}
                        style={{ width: `${Math.max(8, Math.round((kmOf(c) / maxKm) * 100))}%` }}
                      />
                    </span>
                  )}
                </button>
              </li>
            )
          })}
        </ol>

        {/* ── THE CHOSEN DISTANCE — composed on the same centre line ────────── */}
        {selected && shape && (
          <div
            role="tabpanel"
            id="challenge-panel"
            aria-labelledby={`challenge-tab-${selected.id}`}
            className="mt-10 lg:grid lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:gap-x-12"
          >
            {/* ── the wide column: the distance itself ─────────────────────── */}
            <div className="relative min-w-0">
            {/* The bib — the distance again, huge and outlined, behind the detail. */}
            {shape.figure && (
              <span aria-hidden className="pointer-events-none absolute -top-4 right-0 hidden select-none text-[9rem] sm:block font-semibold leading-none tracking-[-0.06em] text-transparent [-webkit-text-stroke:1.5px_var(--border)] sm:text-[12rem]">
                {shape.figure}
              </span>
            )}
            <h3 className="relative flex flex-col items-center text-center sm:items-start sm:text-left">
              {shape.figure ? (
                <>
                  <span className="flex items-start gap-2">
                    <span className={cn(NUM, 'text-[length:var(--hero-title)] leading-[0.85]')}>{shape.figure}</span>
                    <span className={cn(UNIT_LG, 'mt-1')}>{shape.unit}</span>
                  </span>
                  <span className="mt-2 text-fs-md font-semibold uppercase tracking-[0.14em] text-hero-ink">{shape.word}</span>
                </>
              ) : (
                <span className={cn(NUM, 'text-fs-2xl leading-tight')}>{shape.word}</span>
              )}
            </h3>

            <p className={cn(NUM, 'relative mt-3 text-center text-fs-2xl sm:text-left')}>
              {selected.isFree ? 'Free' : formatINR(selected.price)}
            </p>

            {selected.description && (
              <p className={cn('relative mx-auto mt-4 max-w-[60ch] text-center sm:mx-0 sm:text-left', BODY)}>{selected.description}</p>
            )}

            {selected.benefits.length > 0 && (
              <div className="mt-7 border-t border-border/60 pt-5 text-center sm:text-left">
                <p className={FIELD}>What&apos;s included</p>
                <ul className="mt-3 flex flex-wrap justify-center gap-x-6 gap-y-2 sm:justify-start">
                  {selected.benefits.map(b => {
                    const Icon = benefitIcon(b)
                    return (
                      <li key={b} className="inline-flex items-center gap-1.5 text-fs-sm font-medium text-foreground">
                        <Icon className="size-3.5 shrink-0 text-hero-accent-rule" aria-hidden />
                        {b}
                      </li>
                    )
                  })}
                </ul>
                {selected.notes.length > 0 && (
                  <p className={cn(CAPTION, 'mt-2.5')}>{selected.notes.join(' · ')}</p>
                )}
              </div>
            )}
            </div>

            {/* ── the narrow rail: the facts, then the one action ──────────── */}
            <div className="mt-8 min-w-0 lg:mt-0 lg:border-l lg:border-border/60 lg:pl-12">
              {facts.length > 0 && (
                <dl className="divide-y divide-border/60 border-y border-border/60">
                  {facts.map(f => (
                    <div key={f.label} className="flex items-baseline justify-between gap-4 py-3">
                      <dt className={FIELD}>{f.label}</dt>
                      <dd className={cn('truncate', VALUE)}>{f.value}</dd>
                    </div>
                  ))}
                </dl>
              )}

              <div ref={ctaRef} className="mt-6 flex flex-col items-center gap-2 sm:items-start">
                {canRegister ? (
                  <>
                    <Link href={registerHref} className={cn(REGISTER_LINK, 'w-full sm:w-auto')}>
                      {ctaText}
                      <ArrowRight className="size-4 transition-transform group-hover:translate-x-1 motion-reduce:transform-none" aria-hidden />
                    </Link>
                    {slotsLabel(selected, unit) && (
                      <p className="text-fs-sm text-muted-foreground">{slotsLabel(selected, unit)}</p>
                    )}
                  </>
                ) : (
                  <p className={cn(OVERLINE, 'text-foreground')}>
                    <Rule />
                    {selected.selectable ? 'Registrations closed' : 'Sold out'}
                  </p>
                )}
              </div>
            </div>
          </div>
        )}

        {/* 2026-10-06: the way back to an existing ticket (lost email, new phone) — this
            bespoke section never carried the shared TicketSection's link, so running events
            had no route to /download-ticket. Full width under the panel (the CTA column is
            too narrow for it), shown whether registration is open or closed. */}
        <div className="mt-8 flex justify-center border-t border-border/60 pt-5 lg:justify-start">
          <DownloadTicketLink slug={slug} />
        </div>
      </SportsSection>

      {/* ── Sticky bar — same `selectedId`, same `registerHref`; a hairline, not a glow ── */}
      {selected && canRegister && ctaOffscreen && (
        <div className="fixed inset-x-0 bottom-0 z-50 border-t border-border bg-card">
          <div className={cn(EVENT_CONTAINER, 'flex items-center gap-4 py-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))]')}>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                <span className={cn('truncate', ITEM)}>{selected.name}</span>
                <span className={cn(NUM, 'shrink-0 text-fs-md')}>
                  {selected.isFree ? 'Free' : formatINR(selected.price)}
                </span>
              </div>
            </div>
            <Link href={registerHref} className={REGISTER_LINK}>
              {ctaText}
              <ArrowRight className="size-4 transition-transform group-hover:translate-x-1 motion-reduce:transform-none" aria-hidden />
            </Link>
          </div>
        </div>
      )}
    </>
  )
}
