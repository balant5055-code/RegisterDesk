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

// ─── Layout tokens ───────────────────────────────────────────────────────────────
export const CARD       = 'rounded-2xl border border-border/50 bg-card shadow-sm'
export const CARD_HOVER = 'transition-shadow duration-150 hover:shadow-md'

const MAXW: Record<string, string> = {
  '2xl': 'max-w-2xl', '3xl': 'max-w-3xl', '4xl': 'max-w-4xl',
  '5xl': 'max-w-5xl', '6xl': 'max-w-6xl', '7xl': 'max-w-7xl',
}

// ─── Section shell ───────────────────────────────────────────────────────────────
export function SectionShell({
  id, maxW = '6xl', bg = 'white', border = true,
  className, containerClassName, innerRef, onKeyDown, children,
}: {
  id?:                string
  maxW?:              keyof typeof MAXW
  bg?:                'white' | 'muted'
  border?:            boolean
  className?:         string
  containerClassName?: string
  innerRef?:          Ref<HTMLDivElement>
  onKeyDown?:         React.KeyboardEventHandler<HTMLDivElement>
  children:           ReactNode
}) {
  return (
    <section
      id={id}
      className={cn('scroll-mt-24 py-14 sm:py-16', border && 'border-b border-border/60',
        bg === 'muted' ? 'bg-muted/20' : 'bg-white', className)}
    >
      <div ref={innerRef} onKeyDown={onKeyDown} className={cn('mx-auto px-4 sm:px-6 lg:px-8', MAXW[maxW], containerClassName)}>
        {children}
      </div>
    </section>
  )
}

// ─── Section header (eyebrow · title · subtitle) ─────────────────────────────────
export function SectionHeader({ eyebrow, title, subtitle, className }: {
  eyebrow?:  string
  title?:    string
  subtitle?: string
  className?: string
}) {
  return (
    <div className={cn('mb-8 max-w-2xl', className)}>
      {eyebrow && <p className="text-[12px] font-bold uppercase tracking-[0.18em] text-primary">{eyebrow}</p>}
      {title && <h2 className="mt-2 text-[26px] font-bold tracking-tight text-foreground sm:text-[30px]">{title}</h2>}
      {subtitle && <p className="mt-2.5 text-[15px] leading-relaxed text-muted-foreground">{subtitle}</p>}
    </div>
  )
}

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
          className="inline-flex items-center gap-1.5 rounded-lg border border-border/70 bg-card px-2.5 py-1 text-[12px] font-medium text-foreground transition-colors hover:border-primary/40 hover:text-primary">
          <Paperclip className="size-3.5" aria-hidden />{x.label?.trim() || 'Attachment'}
        </a>
      ))}
      {l.map((x, i) => (
        <Link key={`l${i}`} href={x.url} target="_blank" rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 rounded-lg border border-border/70 bg-card px-2.5 py-1 text-[12px] font-medium text-foreground transition-colors hover:border-primary/40 hover:text-primary">
          {x.label?.trim() || 'Learn more'}<ExternalLink className="size-3" aria-hidden />
        </Link>
      ))}
    </div>
  )
}
