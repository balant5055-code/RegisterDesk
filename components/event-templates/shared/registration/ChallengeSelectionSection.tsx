'use client'

// ChallengeSelectionSection — the "Challenge Studio".
//
// A reusable, data-driven selection experience shared by every template: a gallery
// of premium challenge cards (single-select radiogroup) beside one sticky summary
// panel that updates instantly. Challenges are normalised from real pass data via
// `passesToChallenges` — nothing is fabricated; every field self-hides when absent.
//
// Templates supply `challenges` + labels; the interaction model, a11y and layout
// are identical across Sports / Conference / Workshop / Entertainment / Exhibition.

import { useRef, useState } from 'react'
import Link from 'next/link'
import { motion, useReducedMotion } from 'framer-motion'
import {
  Users, CalendarClock, ShieldCheck, Zap, RotateCcw, ArrowRight, Check,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import type { PassPublic } from '@/components/event-templates/types'
import type { PassAvailability } from '@/lib/registrations/types'
import { formatINR, formatDateShort } from '@/components/event-templates/shared/utils/format'
import { SectionShell, SectionHeader } from '@/components/event-templates/shared/ui/framework'

// ─── Data model ─────────────────────────────────────────────────────────────────

export interface Challenge {
  id:          string
  name:        string
  price:       number
  isFree:      boolean
  description?: string           // organiser copy — hidden when empty
  distance?:   string            // enrichment from a linked category — optional
  benefits:    string[]          // real, from the pass
  remaining:   number | null     // null = unlimited/unknown
  total:       number | null
  status:      'available' | 'low' | 'sold_out'
  closesOn?:   string            // sales end date (YYYY-MM-DD)
  selectable:  boolean
}

/** Normalise passes (+ optional category enrichment) into challenges. */
export function passesToChallenges(
  passes: PassPublic[],
  availability: Record<string, PassAvailability>,
  opts?: { categories?: { name: string; distance?: string }[] },
): Challenge[] {
  const byName = new Map(
    (opts?.categories ?? []).map(c => [c.name.trim().toLowerCase(), c] as const),
  )
  return passes
    .filter(p => p.status !== 'inactive' && p.name?.trim())
    .map(p => {
      const av        = availability[p.id]
      const status    = av?.status ?? 'available'
      const remaining = av?.remaining ?? (p.unlimited ? null : (p.quantity ?? null))
      const cat       = byName.get(p.name.trim().toLowerCase())
      return {
        id:          p.id,
        name:        p.name.trim(),
        price:       p.price,
        isFree:      p.price === 0,
        description: p.description?.trim() || undefined,
        distance:    cat?.distance?.trim() || undefined,
        benefits:    (p.benefits ?? []).map(b => b.trim()).filter(Boolean),
        remaining,
        total:       av?.passCapacity ?? (p.unlimited ? null : (p.quantity ?? null)),
        status,
        closesOn:    p.salesEndDate?.trim() || undefined,
        selectable:  status !== 'sold_out',
      }
    })
}

// ─── Benefit → icon (keyword match; generic fallback) ────────────────────────────

// ─── Availability label ──────────────────────────────────────────────────────────

function slotsLabel(c: Challenge, unit: string): string | null {
  if (c.status === 'sold_out') return 'Sold out'
  if (c.remaining == null)     return null            // unlimited — no false scarcity
  return `${c.remaining.toLocaleString('en-IN')} ${unit} left`
}

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
  panelTitle = 'Your Challenge', ctaLabel = 'Register', unit = 'slots',
}: ChallengeSelectionSectionProps) {
  const reduce   = useReducedMotion()
  const cardsRef = useRef<(HTMLButtonElement | null)[]>([])

  const firstSelectable = challenges.find(c => c.selectable)?.id ?? ''
  const [selectedId, setSelectedId] = useState(firstSelectable)
  const selected = challenges.find(c => c.id === selectedId)

  // roving selection across selectable cards
  const move = (dir: 1 | -1) => {
    const order = challenges.map((c, i) => ({ c, i })).filter(x => x.c.selectable)
    if (!order.length) return
    const pos  = Math.max(0, order.findIndex(x => x.c.id === selectedId))
    const next = order[(pos + dir + order.length) % order.length]
    setSelectedId(next.c.id)
    cardsRef.current[next.i]?.focus()
  }
  const onKey = (e: React.KeyboardEvent, c: Challenge) => {
    if (['ArrowRight', 'ArrowDown'].includes(e.key)) { e.preventDefault(); move(1) }
    else if (['ArrowLeft', 'ArrowUp'].includes(e.key)) { e.preventDefault(); move(-1) }
    else if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); if (c.selectable) setSelectedId(c.id) }
  }

  const canRegister = registrationOpen && !!selected && selected.selectable
  const registerHref = selected ? `/events/${slug}/register?pass=${selected.id}` : '#'

  const trust = [
    { icon: ShieldCheck, label: 'Secure Registration' },
    { icon: Zap,         label: 'Instant Confirmation' },
    hasRefundPolicy && { icon: RotateCcw, label: 'Easy Refunds' },
  ].filter(Boolean) as { icon: LucideIcon; label: string }[]

  if (challenges.length === 0) return null

  return (
    <SectionShell id="register" maxW="6xl" bg="muted" border={false}>

        {/* header */}
        <SectionHeader eyebrow={eyebrow} title={title} subtitle={subtitle} />

        {!registrationOpen && (
          <div className="mb-6 rounded-2xl border border-amber-200 bg-amber-50 px-5 py-3.5 text-[13.5px] font-medium text-amber-800">
            {closedMessage || 'Registrations are currently closed for this event.'}
          </div>
        )}

        <div className="grid items-start gap-8 lg:grid-cols-[1fr_360px]">

          {/* ── Challenge selector — race-category cards ── */}
          <div role="radiogroup" aria-label="Choose your challenge" className="grid gap-4 pb-40 sm:grid-cols-2 lg:pb-0">
            {challenges.map((c, i) => {
              const isSel   = c.id === selectedId
              const slots   = slotsLabel(c, unit)
              const rewards = c.benefits.slice(0, 3)
              const extra   = c.benefits.length - rewards.length
              const selDot  = (
                <span className={cn(
                  'mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full transition-colors',
                  isSel ? 'bg-primary text-white' : 'border border-border/70',
                )}>
                  {isSel && <Check className="size-3" aria-hidden />}
                </span>
              )
              return (
                <motion.button
                  key={c.id}
                  ref={el => { cardsRef.current[i] = el }}
                  type="button"
                  role="radio"
                  aria-checked={isSel}
                  aria-disabled={!c.selectable || undefined}
                  tabIndex={isSel || (!firstSelectable && i === 0) ? 0 : -1}
                  disabled={!c.selectable}
                  onClick={() => c.selectable && setSelectedId(c.id)}
                  onKeyDown={e => onKey(e, c)}
                  whileHover={c.selectable && !reduce ? { y: -4, scale: 1.008 } : undefined}
                  transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
                  className={cn(
                    'group relative flex flex-col rounded-2xl p-5 text-left outline-none transition-[box-shadow,background-color] duration-200',
                    'focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-offset-2',
                    c.selectable ? 'cursor-pointer' : 'cursor-not-allowed opacity-60',
                    isSel
                      ? 'bg-gradient-to-b from-primary/[0.05] to-card shadow-xl shadow-primary/10 ring-1 ring-primary/30'
                      : 'bg-card shadow-sm ring-1 ring-border/60 hover:shadow-md hover:ring-border',
                  )}
                >
                  {/* distance hero (or name) + selection dot */}
                  {c.distance ? (
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <span className="block text-[30px] font-black leading-none tracking-tight text-foreground">{c.distance}</span>
                        <h3 className="mt-1.5 text-[13px] font-bold uppercase tracking-[0.08em] text-muted-foreground">{c.name}</h3>
                      </div>
                      {selDot}
                    </div>
                  ) : (
                    <div className="flex items-start justify-between gap-2">
                      <h3 className="text-[19px] font-bold leading-tight text-foreground">{c.name}</h3>
                      {selDot}
                    </div>
                  )}

                  <p className="mt-3 text-[20px] font-black tracking-tight text-foreground">
                    {c.isFree ? 'Free' : formatINR(c.price)}
                  </p>

                  {c.description && (
                    <p className="mt-1.5 line-clamp-2 text-[13px] leading-relaxed text-muted-foreground">{c.description}</p>
                  )}

                  {rewards.length > 0 && (
                    <p className="mt-3 line-clamp-1 text-[12.5px] font-medium text-foreground/70">
                      {rewards.join(' · ')}{extra > 0 ? ` · +${extra}` : ''}
                    </p>
                  )}

                  {/* footer — availability + selection state */}
                  <div className="mt-4 flex items-center justify-between gap-3 border-t border-border/40 pt-3">
                    <span className="min-w-0 truncate text-[12px] font-medium text-muted-foreground">
                      {slots ? (
                        <span className={cn('inline-flex items-center gap-1.5', c.status === 'low' && 'text-amber-600')}>
                          <Users className="size-3.5 shrink-0" aria-hidden />{slots}
                        </span>
                      ) : c.selectable ? 'Available' : ''}
                    </span>
                    <span className={cn('inline-flex shrink-0 items-center gap-1 text-[12.5px] font-bold', isSel ? 'text-primary' : 'text-muted-foreground group-hover:text-foreground')}>
                      {!c.selectable ? '—' : isSel ? <><Check className="size-3.5" aria-hidden />Selected</> : 'Choose'}
                    </span>
                  </div>
                </motion.button>
              )
            })}
          </div>

          {/* ── Sticky summary panel ── */}
          <div className="sticky bottom-0 z-30 self-end lg:bottom-auto lg:top-24 lg:self-start">
            <div
              aria-live="polite"
              className={cn(
                'rounded-t-3xl border-t border-border/70 bg-card p-5 shadow-[0_-8px_30px_-12px_rgba(0,0,0,0.18)]',
                'lg:rounded-2xl lg:border lg:shadow-sm',
                'pb-[max(1.25rem,env(safe-area-inset-bottom))] lg:pb-5',
              )}
            >
              <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-muted-foreground/70">{panelTitle}</p>

              {selected ? (
                <motion.div
                  key={selected.id}
                  initial={reduce ? false : { opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
                >
                  <div className="mt-1.5 flex items-start justify-between gap-3">
                    <h3 className="text-[20px] font-bold leading-tight text-foreground">{selected.name}</h3>
                    {selected.distance && (
                      <span className="shrink-0 rounded-full bg-muted px-2.5 py-1 text-[12px] font-bold text-foreground">{selected.distance}</span>
                    )}
                  </div>

                  <p className="mt-2.5 text-[26px] font-black tracking-tight text-foreground">
                    {selected.isFree ? 'Free' : formatINR(selected.price)}
                  </p>

                  {/* verbose detail — desktop only (mobile sheet stays compact) */}
                  {selected.description && (
                    <p className="mt-2 hidden text-[13px] leading-relaxed text-muted-foreground lg:line-clamp-3 lg:block">{selected.description}</p>
                  )}

                  {/* What's Included — a clean checklist, not a chip wall */}
                  {selected.benefits.length > 0 && (
                    <div className="mt-4 hidden lg:block">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/70">What&apos;s Included</p>
                      <ul className="mt-2 space-y-1.5">
                        {selected.benefits.map(b => (
                          <li key={b} className="flex items-start gap-2 text-[13px] text-foreground/85">
                            <Check className="mt-0.5 size-3.5 shrink-0 text-primary" aria-hidden />
                            <span>{b}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {/* facts — availability · closing date */}
                  {(slotsLabel(selected, unit) || selected.closesOn) && (
                    <div className="mt-4 hidden flex-col gap-2 border-t border-border/50 pt-4 lg:flex">
                      {slotsLabel(selected, unit) && (
                        <span className="inline-flex items-center gap-2 text-[13px] text-muted-foreground">
                          <Users className="size-4 text-primary/70" aria-hidden />{slotsLabel(selected, unit)}
                        </span>
                      )}
                      {selected.closesOn && (
                        <span className="inline-flex items-center gap-2 text-[13px] text-muted-foreground">
                          <CalendarClock className="size-4 text-primary/70" aria-hidden />Registration closes {formatDateShort(selected.closesOn)}
                        </span>
                      )}
                    </div>
                  )}
                </motion.div>
              ) : (
                <p className="mt-2 text-[14px] text-muted-foreground">Select a challenge to continue.</p>
              )}

              {/* CTA */}
              <div className="mt-5">
                {canRegister ? (
                  <Link
                    href={registerHref}
                    className="flex items-center justify-center gap-2 rounded-xl py-3.5 text-[15px] font-bold text-white shadow-sm transition-transform duration-200 hover:scale-[1.01] active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-offset-2"
                    style={{ backgroundImage: 'var(--primary-gradient)' }}
                  >
                    {selected?.isFree ? `${ctaLabel} Free` : ctaLabel} <ArrowRight className="size-4" aria-hidden />
                  </Link>
                ) : (
                  <span className="flex items-center justify-center rounded-xl bg-muted py-3.5 text-[14px] font-semibold text-muted-foreground">
                    Registrations closed
                  </span>
                )}
              </div>

              {/* trust */}
              <div className="mt-3 flex flex-wrap items-center justify-center gap-x-4 gap-y-1.5">
                {trust.map(({ icon: Icon, label }) => (
                  <span key={label} className="inline-flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                    <Icon className="size-3.5 text-primary/60" aria-hidden />{label}
                  </span>
                ))}
              </div>
            </div>
          </div>

        </div>
    </SectionShell>
  )
}
