// Public Event Framework — shared primitives (RD-POLISH-02).
//
// One place for the section shell, header, card, motion tokens, icon registry and
// link chips that every Showcase used to re-declare. Presentational + pure (no
// 'use client'): safe to import from any section. Do not add content or data logic
// here — this is the design-system layer.

import { createElement, type ReactNode, type Ref } from 'react'
import Link from 'next/link'
import { Paperclip, ExternalLink } from 'lucide-react'
import {
  Medal, Flag, Timer, ScrollText, Droplets, HeartPulse, Camera, Video, Utensils, Apple,
  Music, Trophy, Users, ShieldCheck, MapPin, Bus, Briefcase, DoorOpen, Baby, Gift, Shirt, Mic, Check,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils/cn'

// ─── Motion tokens ───────────────────────────────────────────────────────────────
export const EASE = [0.16, 1, 0.3, 1] as const

/** Scroll-reveal preset. Pass `useReducedMotion()` result. */
export function reveal(reduce: boolean | null, delay = 0) {
  return reduce ? {} : {
    initial:     { opacity: 0, y: 16 },
    whileInView: { opacity: 1, y: 0 },
    viewport:    { once: true, amount: 0.2 },
    transition:  { duration: 0.5, ease: EASE, delay },
  }
}
/** Card hover-lift preset. */
export const hoverLift = (reduce: boolean | null, y = -3) => (reduce ? undefined : { y })

// ═══ RD-ST4.4 · THE EVENT DETAILS VISUAL FOUNDATION ══════════════════════════════
//
// One layout system, one vertical rhythm, one type scale, one card language. Every
// section inherits from here; no section declares its own page width or section
// padding any more. Closes ST41-C01/C02 (seven content-start positions), ST41-A04
// (three scroll offsets), ST41-D01 (19 arbitrary font sizes), ST41-E01 (five card
// systems) and ST41-F01 (three header systems).

// ─── 1 · Layout ──────────────────────────────────────────────────────────────────
// THE page container. Identical to lib/ds/containers.ts `container.page`, which the
// design system already mandates ("use these instead of arbitrary max-w-[*] values")
// and which MarketingNavbar and MarketingFooter already use — so every band on the
// page, chrome included, now starts its content at the same x.
export const EVENT_CONTAINER = 'mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8'

// Optional INNER reading measure. Applied to the content INSIDE the page container —
// never to the container itself — so a narrow prose column keeps its comfortable
// measure while its left edge still lines up with every other section.
const MEASURE = {
  full:   '',              // fills the page container (default)
  wide:   'max-w-5xl',
  narrow: 'max-w-4xl',
  prose:  'max-w-3xl',
} as const
export type SectionMeasure = keyof typeof MEASURE

/**
 * RD-ST5.2 P0.2 — the two band backgrounds, named so a section can accept the choice
 * as a prop and let the TEMPLATE decide the page's cadence. Sections each picked
 * their own background before, which is how the page ended up with eight consecutive
 * white bands: no single file could see the sequence it was producing.
 */
export type SectionBg = 'white' | 'muted'

// Legacy `maxW` values map onto the measure scale, so existing call sites keep
// working and pick up the new alignment without edits.
const MAXW_TO_MEASURE: Record<string, SectionMeasure> = {
  '7xl': 'full', '6xl': 'full', '5xl': 'wide', '4xl': 'narrow',
  '3xl': 'prose', '2xl': 'prose',
}

// ─── 2 · Vertical rhythm ─────────────────────────────────────────────────────────
// RD-ST5.2 P0.1 — the scale stopped at `sm`, so a 768px tablet and a 1920px monitor
// got identical band padding while the hero above them scaled fluidly against the
// viewport (--hero-py / --hero-h in tokens.css). The page visibly lost the hero's
// generosity at exactly the width where it should feel most spacious. One `lg` step
// closes that, and every SectionShell consumer inherits it without an edit.
/** A full content SECTION. */
export const SECTION_PY   = 'py-14 sm:py-16 lg:py-20'
/** A content BAND (waiver notice, legal strip) — not a section. */
export const BAND_PY      = 'py-4'
/** A notification STRIP (lifecycle status bars) — the tightest rhythm. */
export const STRIP_PY     = 'py-2.5'
/** One scroll offset for the one fixed navbar (was scroll-mt-24 vs -28). */
export const SECTION_SCROLL_MT = 'scroll-mt-24'
/** Gap between a section header and its content. */
export const HEADER_MB    = 'mb-8'
/** Default gap between sibling cards in a section grid. */
export const GRID_GAP     = 'gap-4'

// ─── 3 · Typography ──────────────────────────────────────────────────────────────
// Every role resolves to a font-size token via the text-fs utilities registered in
// globals.css. Those utilities set font-size ONLY (line-height stays with leading-*),
// so these are drop-in replacements for the old text-[Npx] values.
export const TYPE = {
  /** Section eyebrow — the small uppercase kicker above a section title. */
  eyebrow:      'text-fs-xs font-bold uppercase tracking-[0.14em] text-primary',
  /** Section h2. */
  sectionTitle: 'text-fs-xl font-bold tracking-tight text-foreground sm:text-fs-2xl',
  /** Section description under the title. */
  sectionDesc:  'text-fs-md leading-relaxed text-muted-foreground',
  /** Sub-group heading inside a section (day label, tier label, category). */
  groupLabel:   'text-fs-sm font-bold uppercase tracking-[0.14em] text-muted-foreground',
  /** Card / item title. */
  cardTitle:    'text-fs-md font-bold leading-snug text-foreground',
  /** Larger card title (panel headings, venue name, organiser name). */
  cardTitleLg:  'text-fs-lg font-bold leading-tight text-foreground',
  /**
   * RD-ST5.2 P1.2 — title of a large INTERACTIVE panel (the challenge selector).
   *
   * A display-weight heading that must still sit under `sectionTitle` at every
   * breakpoint: 18→24 against the section's 24→28. The Challenge panel previously
   * used an inline `clamp(28px,2.8vw,36px)`, which made a card title LARGER than the
   * h2 containing it at every width — the one true hierarchy inversion on the page.
   * Declared here rather than inline so no section owns a private display scale.
   */
  panelTitle:   'text-fs-lg font-extrabold leading-tight tracking-tight text-foreground sm:text-fs-xl',
  /**
   * A prominent NUMBER — a stat value or a headline price. Not a heading, so it
   * carries no hierarchy obligation; it exists so big figures stop being re-declared
   * (organiser stats and the challenge price were the same treatment written twice,
   * once as a token size and once as an inline clamp).
   */
  statValue:    'text-fs-xl font-extrabold leading-none tracking-tight text-foreground',
  /** Card body copy. */
  cardBody:     'text-fs-sm leading-relaxed text-muted-foreground',
  /** Long-form body copy. */
  body:         'text-fs-base leading-relaxed text-muted-foreground',
  /** Small uppercase field label inside a card. */
  label:        'text-fs-2xs font-bold uppercase tracking-[0.14em] text-muted-foreground',
  /** Meta / supporting line. */
  meta:         'text-fs-xs text-muted-foreground',
  /** Smallest supporting line (chips, counts, timestamps). */
  metaSm:       'text-fs-2xs text-muted-foreground',
} as const

// ─── 4 · Card language ───────────────────────────────────────────────────────────
export const CARD       = 'rounded-2xl border border-border/50 bg-card shadow-sm'
export const CARD_HOVER = 'transition-shadow duration-150 hover:shadow-md'
/** Card padding scale — was eight ad-hoc values across the chain. */
export const CARD_PAD_SM = 'p-4'
export const CARD_PAD    = 'p-5'
export const CARD_PAD_LG = 'p-6'

/**
 * RD-ST5.2 P1.3 · THE icon tile.
 *
 * The small tinted square that precedes a card's title. It was declared six times
 * across the chain at three sizes (size-9 / size-10 / size-11) — the same component
 * drawn three ways, which is what made otherwise-identical cards fail to line up.
 * `size-10` is the plurality value, so most call sites are unchanged.
 *
 * `inline-flex` + `shrink-0` covers both uses: a stacked tile above a title, and a
 * tile as a flex item in a horizontal card row. The dimensions are fixed, so the two
 * are equivalent in every existing layout.
 *
 * Colour is carried here too — every call site used `bg-primary/10`. Sections that
 * tint per item (Experience) override it with an inline style, which still wins.
 */
export const ICON_TILE = 'inline-flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary'
/** The icon INSIDE an `ICON_TILE`. Was size-5 in four places and size-[18px] in two. */
export const ICON_TILE_ICON = 'size-5'

// ─── 5 · Glass / overlay ─────────────────────────────────────────────────────────
// RD-ST5.0. ST4.2-P05 recorded that the design system had NO blur/glass token despite
// five ad-hoc backdrop-blur sites. These are that missing token, declared once so a
// cinematic hero can't grow a private set of overlay values.
/** Frosted DARK panel over media (white text) — e.g. the hero countdown. */
export const GLASS_DARK  = 'border border-white/10 bg-slate-900/85 backdrop-blur-md'
/** Frosted LIGHT panel over media (foreground text). */
export const GLASS_LIGHT = 'border border-white/60 bg-white/70 backdrop-blur-md'
/** The one brand gradient surface — never re-declare the gradient string. */
export const BRAND_GRADIENT = 'bg-[image:var(--primary-gradient)]'

// ─── Section shell ───────────────────────────────────────────────────────────────
export function SectionShell({
  id, maxW = '6xl', measure, bg = 'white', border = true,
  className, containerClassName, innerRef, onKeyDown, children,
}: {
  id?:                string
  /** @deprecated Use `measure`. Legacy widths map onto the measure scale. */
  maxW?:              string
  /** Inner reading measure. Never changes where the section's content STARTS. */
  measure?:           SectionMeasure
  bg?:                SectionBg
  border?:            boolean
  className?:         string
  containerClassName?: string
  innerRef?:          Ref<HTMLDivElement>
  onKeyDown?:         React.KeyboardEventHandler<HTMLDivElement>
  children:           ReactNode
}) {
  const measureCls = MEASURE[measure ?? MAXW_TO_MEASURE[maxW] ?? 'full']
  return (
    <section
      id={id}
      className={cn(SECTION_SCROLL_MT, SECTION_PY, border && 'border-b border-border/60',
        bg === 'muted' ? 'bg-muted/20' : 'bg-white', className)}
    >
      <div ref={innerRef} onKeyDown={onKeyDown} className={cn(EVENT_CONTAINER, containerClassName)}>
        {measureCls ? <div className={measureCls}>{children}</div> : children}
      </div>
    </section>
  )
}

// ─── Section header (eyebrow · title · description · actions) ────────────────────
// THE one section header. Replaces the hand-rolled header rows that sections used to
// build when they needed a header-level CTA (ST41-F01).
export function EventSectionHeader({
  eyebrow, title, description, subtitle, actions, className,
}: {
  eyebrow?:     string
  title?:       string
  description?: string
  /** @deprecated Use `description`. */
  subtitle?:    string
  /** Optional right-aligned action (a link, a pill, a button). */
  actions?:     ReactNode
  className?:   string
}) {
  const desc = description ?? subtitle
  const copy = (
    <div className="max-w-2xl">
      {eyebrow && <p className={TYPE.eyebrow}>{eyebrow}</p>}
      {title && <h2 className={cn(TYPE.sectionTitle, eyebrow && 'mt-2')}>{title}</h2>}
      {desc && <p className={cn(TYPE.sectionDesc, (eyebrow || title) && 'mt-2.5')}>{desc}</p>}
    </div>
  )

  if (!actions) return <div className={cn(HEADER_MB, className)}>{copy}</div>

  return (
    <div className={cn(HEADER_MB, 'flex flex-wrap items-end justify-between gap-4', className)}>
      {copy}
      <div className="shrink-0">{actions}</div>
    </div>
  )
}

/** @deprecated Alias kept so every existing call site inherits the one header. */
export const SectionHeader = EventSectionHeader

// ─── Icon registry ───────────────────────────────────────────────────────────────
const ICONS: Record<string, LucideIcon> = {
  medal: Medal, finisher_medal: Medal, finisher: Medal,
  bib: Flag, race_bib: Flag, race_number: Flag, flag_off: Flag, start: Flag, race: Flag, run: Flag,
  timing_chip: Timer, rfid: Timer, timing: Timer, chip: Timer,
  certificate: ScrollText, e_certificate: ScrollText,
  hydration: Droplets, water: Droplets,
  medical: HeartPulse, first_aid: HeartPulse, ambulance: HeartPulse, warmup: HeartPulse, warm_up: HeartPulse,
  photography: Camera, photos: Camera, photo: Camera, expo: Camera, exhibition: Camera,
  videography: Video, video: Video,
  breakfast: Utensils, meal: Utensils, lunch: Utensils,
  refreshments: Apple, food: Apple, snacks: Apple,
  music: Music, entertainment: Music,
  prize: Trophy, prize_money: Trophy, awards: Trophy, award: Trophy, ceremony: Trophy, finish: Trophy,
  pacers: Users, pacer: Users, session: Users, networking: Users, panel: Users,
  insurance: ShieldCheck, safety: ShieldCheck,
  tracking: MapPin, live_tracking: MapPin,
  parking: Bus, transport: Bus, shuttle: Bus,
  bag_drop: Briefcase, bag: Briefcase, cloakroom: Briefcase,
  changing: DoorOpen, changing_rooms: DoorOpen, washroom: DoorOpen, registration: DoorOpen, gates: DoorOpen, check_in: DoorOpen,
  kids: Baby, kids_zone: Baby,
  gift: Gift, goodie: Gift, race_kit: Gift,
  keynote: Mic, talk: Mic,
}
/** Exact-key icon lookup — returns null for unknown/blank (never a guessed icon). */
export function resolveIcon(key?: string): LucideIcon | null {
  if (!key?.trim()) return null
  return ICONS[key.trim().toLowerCase()] ?? null
}
/** Render a resolved icon without a render-bound JSX tag (rules-of-hooks safe). */
export function renderIcon(key: string | undefined, className: string) {
  const Icon = resolveIcon(key)
  return Icon ? createElement(Icon, { className, 'aria-hidden': true }) : null
}
/** Fuzzy benefit-label → icon (for free-text benefit lists); falls back to a tick. */
export function benefitIcon(label?: string): LucideIcon {
  const s = (label ?? '').toLowerCase()
  if (/medal|finisher|trophy/.test(s))                return Medal
  if (/t-?shirt|jersey|tee|apparel|dri-?fit/.test(s)) return Shirt
  if (/bib|race number/.test(s))                       return Flag
  if (/chip|timing|timed/.test(s))                     return Timer
  if (/certificate|e-?cert/.test(s))                   return ScrollText
  if (/refresh|food|snack|breakfast|meal|fruit/.test(s)) return Apple
  if (/hydrat|water|drink/.test(s))                    return Droplets
  if (/photo|picture|media/.test(s))                   return Camera
  if (/transport|shuttle|bus|parking/.test(s))         return Bus
  return Check
}

// ─── Link chips (attachments + external links) ───────────────────────────────────
export function AttachmentChips({ attachments, links, className }: {
  attachments?: { label?: string; url: string }[]
  links?:       { label?: string; url: string }[]
  className?:   string
}) {
  const a = (attachments ?? []).filter(x => x?.url?.trim())
  const l = (links ?? []).filter(x => x?.url?.trim())
  if (a.length === 0 && l.length === 0) return null
  return (
    <div className={cn('flex flex-wrap gap-2', className)}>
      {a.map((x, i) => (
        <a key={`a${i}`} href={x.url} target="_blank" rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 rounded-lg border border-border/70 bg-card px-2.5 py-1 text-fs-xs font-medium text-foreground transition-colors hover:border-primary/40 hover:text-primary">
          <Paperclip className="size-3.5" aria-hidden />{x.label?.trim() || 'Attachment'}
        </a>
      ))}
      {l.map((x, i) => (
        <Link key={`l${i}`} href={x.url} target="_blank" rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 rounded-lg border border-border/70 bg-card px-2.5 py-1 text-fs-xs font-medium text-foreground transition-colors hover:border-primary/40 hover:text-primary">
          {x.label?.trim() || 'Learn more'}<ExternalLink className="size-3" aria-hidden />
        </Link>
      ))}
    </div>
  )
}
