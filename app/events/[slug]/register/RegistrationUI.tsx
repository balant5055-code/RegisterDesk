'use client'

// RegistrationUI — the presentation layer for /events/[slug]/register.
//
// RD-RT4.0 "Ticket Desk". RT1.0–RT3.5 tokenised this route and fixed its information
// architecture, but the surface it produced was still white cards on a white page: every
// element sat on the same plane, so nothing could be quiet and nothing could be loud.
// This pass rebuilds the COMPOSITION on three ideas and nothing else:
//
//   1 · A CANVAS. The page sits on a tinted surface (--rd-canvas, derived from the
//       existing --muted/--background tokens), so the white panels finally read as
//       elevated objects rather than as regions of the page. Everything else — depth,
//       grouping, hierarchy — follows from that one change.
//   2 · ONE PANEL LANGUAGE. A single radius, hairline and layered shadow (PANEL) that
//       the form sections, the journey, the pass selector and the summary all inherit.
//   3 · ONE ACCENT. The brand gradient is spent on exactly three things — the completed
//       journey rail, the selected pass and the primary action — and nowhere else. The
//       remaining 95% of the page is neutral.
//
// Every component here is presentation only. No validation, no pricing maths, no
// Firestore, no Razorpay, no field generation. They receive already-computed values and
// render them; RegisterClient keeps 100% of the logic it had.
//
// Nothing is fabricated: each block renders only when its value exists, and the whole
// row/panel collapses when it does not.

import Link from 'next/link'
import type { ReactNode } from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import {
  Calendar, MapPin, Globe, ShieldCheck, Zap, Check, CalendarClock, QrCode,
  ArrowLeft, Ticket, Clock3, Lock, RotateCcw, ChevronRight,
} from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { Breadcrumbs } from '@/components/ui/Breadcrumbs'
import { MarketingLogo } from '@/components/marketing/MarketingLogo'
import { PassPrice } from './PassPrice'
import { TYPE, BRAND_GRADIENT } from '@/components/event-templates/shared/ui/framework'
// RD-RT4.0: the route's surface tokens live in a server-safe module so the pass picker
// (a server component) and this client layer paint on exactly the same canvas.
import { CANVAS, PAGE, PANEL, PANEL_HEAD, PANEL_BODY, FOCUS_RING } from './registerTheme'

// ─── Shared shapes ──────────────────────────────────────────────────────────────

export interface EventIdentity {
  eventSlug:  string
  eventName:  string
  bannerUrl:  string
  dateLabel:  string        // '' when the organiser set no date
  timeLabel:  string
  venueLabel: string | null
  isOnline:   boolean
  closesLabel: string | null // from the pass's salesEndDate; null when unset
}

// ═══ 1 · Checkout chrome ════════════════════════════════════════════════════════
// A real checkout bar: brand left, security + exit right, pinned to the top of the
// viewport for the whole flow. RT3.2 had this as a 48px rule inside the page container
// that scrolled away with the content — so the one piece of chrome that tells you where
// you are and how to leave was gone by the second field.

export function CheckoutTopBar({ eventSlug, secure = true }: {
  eventSlug: string
  /** False on free registrations, where a payment-security claim would be noise. */
  secure?:   boolean
}) {
  return (
    <header className="sticky top-0 z-50 border-b border-border/70 bg-card/85 backdrop-blur-xl">
      <div className={cn(PAGE, 'flex h-14 items-center justify-between gap-4')}>
        <MarketingLogo className="h-6 w-auto sm:h-7" />

        <div className="flex items-center gap-2.5 sm:gap-3.5">
          {secure && (
            <span className="hidden items-center gap-1.5 rounded-full bg-emerald-500/[0.08] px-2.5 py-1 text-fs-2xs font-semibold text-emerald-700 sm:inline-flex">
              <Lock className="size-3 shrink-0" aria-hidden />
              Secure checkout
            </span>
          )}
          <span aria-hidden className="hidden h-4 w-px bg-border sm:block" />
          <Link
            href={`/events/${eventSlug}`}
            className={cn(
              // min-h-9 / px-2: at `py-1` the hit area measured ~22px tall, under the
              // 24×24 CSS px floor (WCAG 2.5.8). The negative margin keeps the optical
              // position identical inside the 56px bar.
              '-mx-2 inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-md px-2 text-fs-xs font-semibold text-muted-foreground transition-colors hover:text-foreground',
              FOCUS_RING,
            )}
          >
            <ArrowLeft className="size-3.5" aria-hidden />
            Back to Event
          </Link>
        </div>
      </div>
    </header>
  )
}

// ═══ 2 · Masthead ═══════════════════════════════════════════════════════════════
// Breadcrumb → eyebrow → title → one sentence → three quiet facts. ~150px, and every
// line answers a different question: where am I, what is this, how long will it take,
// and is it safe. The poster, pass, price and venue deliberately do NOT appear here —
// they live in the summary, which is on screen the whole way down.

export function RegistrationMasthead({ eventSlug, eventName, estimate, isPaid }: {
  eventSlug: string
  eventName: string
  /** Derived from the real visible-field count; null falls back to generic copy. */
  estimate:  string | null
  isPaid:    boolean
}) {
  const chips = [
    estimate && { key: 'time',   Icon: Clock3,      text: `About ${estimate}` },
    { key: 'secure', Icon: ShieldCheck, text: isPaid ? 'Encrypted payment' : 'Sent securely' },
    { key: 'ticket', Icon: Zap,         text: 'Instant e-ticket' },
  ].filter(Boolean) as { key: string; Icon: typeof Clock3; text: string }[]

  return (
    <div className="pt-6 pb-5 sm:pt-8 sm:pb-7">
      {/* The SAME breadcrumb component the event page uses, so the crumb trail does not
          change character between the two pages. */}
      <Breadcrumbs
        items={[
          { label: 'Home',   href: '/' },
          { label: 'Events', href: '/events' },
          { label: eventName, href: `/events/${eventSlug}` },
          { label: 'Registration' },
        ]}
      />

      <p className={cn('mt-4', TYPE.eyebrow)}>Event Registration</p>

      <h1 className="mt-1.5 max-w-2xl text-balance text-fs-xl font-bold leading-tight tracking-tight text-foreground sm:text-fs-2xl">
        Register for {eventName}
      </h1>

      {/* The time estimate lives in the chip below, NOT here. Stating the same number
          twice within 40px reads as a template that forgot to pick a placement. */}
      <p className="mt-2 max-w-xl text-fs-base leading-relaxed text-muted-foreground">
        A few details, one secure payment, and your ticket is on its way.
      </p>

      <ul className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-2">
        {chips.map(c => (
          <li
            key={c.key}
            className="inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-card px-2.5 py-1 text-fs-2xs font-semibold text-muted-foreground shadow-[0_1px_2px_rgb(15_23_42_/_0.04)]"
          >
            <c.Icon className="size-3 shrink-0 text-primary" aria-hidden />
            {c.text}
          </li>
        ))}
      </ul>
    </div>
  )
}

// ═══ 3 · Journey stepper ════════════════════════════════════════════════════════
// Progress through the REGISTRATION (as opposed to through the form):
//
//   Registration → Review → Payment → Confirmation
//
// Nodes on a rail with the label under each node — the composition that lets a stepper
// carry four words without becoming a row of tabs. Completed rail segments fill with the
// brand gradient (left-to-right, so the fill reads as travel); the current node is the
// only element on the page wearing a brand ring; everything ahead is a muted circle.
//
// When no payment is due the Payment stage is marked "Not required" rather than removed,
// so a free registration and a paid one describe the same journey — the shape of the
// flow never changes underneath the attendee.

export type JourneyStage = 'form' | 'review' | 'payment' | 'success'

const JOURNEY: { id: JourneyStage; label: string; short: string }[] = [
  { id: 'form',    label: 'Registration', short: 'Details' },
  { id: 'review',  label: 'Review',       short: 'Review'  },
  { id: 'payment', label: 'Payment',      short: 'Payment' },
  { id: 'success', label: 'Confirmation', short: 'Done'    },
]

export function JourneyStepper({ current, paymentRequired }: {
  current:         JourneyStage
  /** False → the Payment stage renders as skipped, never hidden. */
  paymentRequired: boolean
}) {
  const reduce     = useReducedMotion()
  const currentIdx = JOURNEY.findIndex(s => s.id === current)

  return (
    <nav aria-label="Registration journey" className={cn(PANEL, 'mb-4 px-4 py-4 sm:px-6 sm:py-5')}>
      <div className="mb-4 flex items-baseline justify-between gap-4">
        <p className={TYPE.label}>Your registration</p>
        <p className="text-fs-2xs font-semibold text-muted-foreground">
          Step {currentIdx + 1} of {JOURNEY.length}
        </p>
      </div>

      <ol className="flex items-start">
        {JOURNEY.map((stage, i) => {
          const skipped = stage.id === 'payment' && !paymentRequired
          const done    = i < currentIdx
          const active  = i === currentIdx
          const last    = i === JOURNEY.length - 1

          return (
            <li key={stage.id} className="relative flex min-w-0 flex-1 flex-col items-center">
              {/* Rail segment to the NEXT node. Sits behind the node, centred on it. */}
              {!last && (
                <span aria-hidden className="absolute left-1/2 top-[13px] h-0.5 w-full overflow-hidden rounded-full bg-border">
                  <motion.span
                    className={cn('block size-full origin-left', BRAND_GRADIENT)}
                    initial={false}
                    animate={{ scaleX: done ? 1 : 0 }}
                    transition={reduce ? { duration: 0 } : { duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
                  />
                </span>
              )}

              <span
                aria-hidden
                className={cn(
                  'relative z-10 flex size-7 shrink-0 items-center justify-center rounded-full text-fs-2xs font-bold transition-all duration-200',
                  done
                    ? cn(BRAND_GRADIENT, 'text-white shadow-[0_2px_10px_rgb(var(--primary-rgb)_/_0.35)]')
                    : active
                      ? 'bg-card text-primary ring-2 ring-primary shadow-[0_0_0_4px_rgb(var(--primary-rgb)_/_0.12)]'
                      : skipped
                        ? 'border border-dashed border-border-strong bg-card text-muted-foreground/50'
                        : 'bg-muted text-muted-foreground/70',
                )}
              >
                {done ? <Check className="size-3.5" strokeWidth={3} /> : skipped ? '–' : i + 1}
              </span>

              <span
                className={cn(
                  'mt-2 w-full truncate px-1 text-center text-fs-2xs transition-colors duration-200',
                  active
                    ? 'font-bold text-foreground'
                    : done
                      ? 'font-semibold text-muted-foreground'
                      : 'font-medium text-muted-foreground/60',
                )}
              >
                <span className="sm:hidden">{stage.short}</span>
                <span className="hidden sm:inline">{stage.label}</span>
              </span>

              {/* The visible rail is decorative; this is what assistive tech reads. */}
              <span className="sr-only">
                {stage.label}
                {skipped ? ' — not required' : done ? ' — complete' : active ? ' — current step' : ' — not started'}
              </span>
            </li>
          )
        })}
      </ol>
    </nav>
  )
}

// ═══ 4 · Form-section progress ══════════════════════════════════════════════════
// Progress through the FORM, which is a different question from the journey above.
// A segmented meter — one segment per section, in section order — plus the section
// names beneath, so "where am I" and "what is still coming" are answered by one object.
//
// Identical inputs, identical semantics: `activeIdx` (-1 = all complete) and
// `completedCount` are passed straight through from RegisterClient. No logic moved.

export function StepWizard({ sections, activeIdx, completedCount }: {
  sections:       { id: string; title?: string }[]
  activeIdx:      number
  completedCount: number
}) {
  const reduce = useReducedMotion()
  if (sections.length <= 1) return null

  const total   = sections.length
  const allDone = activeIdx === -1
  const doneN   = allDone ? total : completedCount

  return (
    <nav aria-label="Registration progress" className="mb-4">
      <div className="mb-2.5 flex items-baseline justify-between gap-4">
        <p className={TYPE.label}>Your details</p>
        <p className="text-fs-2xs font-semibold tabular-nums text-muted-foreground">
          {doneN} of {total} complete
        </p>
      </div>

      <ol className="flex items-stretch gap-2">
        {sections.map((s, i) => {
          const done    = allDone || i < activeIdx
          const current = !allDone && i === activeIdx
          return (
            <li key={s.id} className="min-w-0 flex-1">
              <div className="relative h-1.5 overflow-hidden rounded-full bg-border/80">
                <motion.span
                  aria-hidden
                  className={cn('absolute inset-y-0 left-0 rounded-full', done ? BRAND_GRADIENT : 'bg-primary/60')}
                  initial={false}
                  animate={{ width: done ? '100%' : current ? '42%' : '0%' }}
                  transition={reduce ? { duration: 0 } : { duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
                />
              </div>
              <p
                className={cn(
                  'mt-2 truncate text-fs-2xs transition-colors duration-200',
                  current
                    ? 'font-bold text-foreground'
                    : done
                      ? 'font-semibold text-muted-foreground'
                      : 'font-medium text-muted-foreground/55',
                )}
                title={s.title ?? `Step ${i + 1}`}
              >
                {s.title ?? `Step ${i + 1}`}
              </p>
              <span className="sr-only">
                {s.title ?? `Step ${i + 1}`}
                {done ? ' — complete' : current ? ' — current step' : ' — not started'}
              </span>
            </li>
          )
        })}
      </ol>
    </nav>
  )
}

// ═══ 5 · Form section card ══════════════════════════════════════════════════════
// A pure shell so every logical group gets the SAME rhythm — one card language, one
// header treatment, one padding. Fields are rendered by RegisterClient and passed as
// children; this component never knows what a field is.
//
// RD-RT4.0 adds a third state. Before, a section was either "complete" or not, so a
// twelve-field form presented twelve identical fields with no sense of place. Now the
// section you are actually on carries a soft brand edge and a little extra lift, the
// ones behind you settle back with a green tick, and the ones ahead stay quiet.

export function FormSectionCard({ title, description, index, complete, active, children }: {
  title?:       string
  description?: string
  /** Ordinal shown in the header chip; purely visual grouping. */
  index:        number
  /**
   * RD-RT3.3: true when every required field in this section is filled. Derived from
   * state the page already computes — no new source.
   */
  complete?:    boolean
  /** RD-RT4.0: the first not-yet-complete section. Same derivation, presentation only. */
  active?:      boolean
  children:     ReactNode
}) {
  return (
    // `overflow-hidden` is deliberately ABSENT: it would clip any absolutely-positioned
    // dropdown opened by a field inside the card (RD-RT3.2.2 BUG 2). The header rounds
    // its own top corners instead.
    <section
      className={cn(
        PANEL,
        'transition-shadow duration-300',
        active && 'border-primary/35 shadow-[0_1px_2px_rgb(15_23_42_/_0.04),0_20px_44px_-28px_rgb(var(--primary-rgb)_/_0.35)]',
      )}
    >
      {title && (
        <div className={cn(PANEL_HEAD, 'flex items-start gap-3 rounded-t-2xl')}>
          <span
            aria-hidden
            className={cn(
              'mt-px flex size-7 shrink-0 items-center justify-center rounded-xl text-fs-2xs font-bold transition-all duration-200',
              complete
                ? 'bg-emerald-500/10 text-emerald-600 ring-1 ring-emerald-500/25'
                : active
                  ? cn(BRAND_GRADIENT, 'text-white shadow-[0_2px_10px_rgb(var(--primary-rgb)_/_0.30)]')
                  : 'bg-muted text-muted-foreground/70',
            )}
          >
            {complete ? <Check className="size-3.5" strokeWidth={3} /> : index}
          </span>

          <div className="min-w-0 flex-1">
            <h2 className={TYPE.cardTitle}>{title}</h2>
            {description && <p className={cn('mt-0.5', TYPE.cardBody)}>{description}</p>}
          </div>

          {complete && (
            <span className="mt-0.5 inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-500/[0.08] px-2 py-0.5 text-fs-2xs font-semibold text-emerald-700">
              <Check className="size-3" strokeWidth={3} aria-hidden />
              Complete
            </span>
          )}
        </div>
      )}
      {/* gap-5: related fields need a little more air than the 16px that made a long
          section read as one undifferentiated wall. */}
      <div className={cn(PANEL_BODY, 'flex flex-col gap-5')}>{children}</div>
    </section>
  )
}

// ═══ 6 · Pass selector ══════════════════════════════════════════════════════════
// Unchanged behaviour (role=radiogroup, same onSelect, same disabled rule); the paint
// is entirely new. Each pass is a card that states its own case: name, eligibility
// window and price at real scale, with the selected one carrying a gradient edge, a
// tinted surface and a filled check — so "which one did I pick" is answerable from
// across the room rather than by finding a 4px dot.

export function PassSwitcher({ passes, selectedId, onSelect, switching }: {
  passes:     { id: string; name: string; price: number; regularPrice: number; isFree: boolean; ageLabel?: string | null }[]
  selectedId: string
  onSelect:   (id: string) => void
  switching:  boolean
}) {
  return (
    <section className={cn(PANEL, 'mb-4')}>
      <div className={cn(PANEL_HEAD, 'flex items-center justify-between gap-3 rounded-t-2xl')}>
        <div className="flex min-w-0 items-center gap-3">
          <span aria-hidden className="flex size-7 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <Ticket className="size-3.5" />
          </span>
          <div className="min-w-0">
            <h2 className={TYPE.cardTitle}>Choose your pass</h2>
            <p className={cn('mt-0.5', TYPE.cardBody)}>Switch any time — your answers are kept.</p>
          </div>
        </div>
        {/* Hidden below sm: at 390px this count squeezed the description to 67% of the
            available measure, forcing a two-line wrap with an orphaned word right beside
            it. The three cards immediately below already convey how many options exist. */}
        <span className="hidden shrink-0 text-fs-2xs font-semibold text-muted-foreground sm:block">
          {passes.length} options
        </span>
      </div>

      <div className={cn(PANEL_BODY, 'flex flex-col gap-2.5')} role="radiogroup" aria-label="Select your pass">
        {passes.map(p => {
          const active = p.id === selectedId
          return (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={switching}
              onClick={() => onSelect(p.id)}
              className={cn(
                'group relative flex items-center gap-3.5 overflow-hidden rounded-xl border p-3.5 text-left',
                'transition-[border-color,background-color,box-shadow,transform] duration-200',
                'disabled:cursor-not-allowed disabled:opacity-60',
                FOCUS_RING,
                active
                  ? 'border-primary/50 bg-[rgb(var(--primary-rgb)_/_0.035)] shadow-[0_2px_16px_-6px_rgb(var(--primary-rgb)_/_0.35)]'
                  : 'border-border bg-card hover:border-border-strong hover:bg-muted/30 motion-safe:hover:-translate-y-px',
              )}
            >
              {/* Gradient edge — grows from the top on selection. */}
              <span
                aria-hidden
                className={cn(
                  'absolute inset-y-0 left-0 w-[3px] origin-top rounded-r-full transition-transform duration-300 motion-reduce:transition-none',
                  BRAND_GRADIENT,
                  active ? 'scale-y-100' : 'scale-y-0',
                )}
              />

              {/* Selection mark. */}
              <span
                aria-hidden
                className={cn(
                  'ml-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border-2 transition-all duration-200',
                  active
                    ? cn(BRAND_GRADIENT, 'border-transparent text-white shadow-[0_2px_8px_rgb(var(--primary-rgb)_/_0.40)]')
                    : 'border-border-strong bg-card group-hover:border-primary/50',
                )}
              >
                <Check className={cn('size-3 transition-opacity duration-150', active ? 'opacity-100' : 'opacity-0')} strokeWidth={3} />
              </span>

              <span className="min-w-0 flex-1">
                <span className={cn('block truncate text-fs-md font-bold leading-snug', active ? 'text-foreground' : 'text-foreground')}>
                  {p.name}
                </span>
                {/* RD-RT3.2.3: the age window, shown only from real configured values
                    and hidden entirely when the pass is unrestricted. */}
                {p.ageLabel && (
                  <span className="mt-1 inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-fs-2xs font-medium text-muted-foreground">
                    Age {p.ageLabel}
                  </span>
                )}
              </span>

              <PassPrice price={p.price} regularPrice={p.regularPrice} isFree={p.isFree} size="md" className="shrink-0" />
            </button>
          )
        })}
      </div>
    </section>
  )
}

// ═══ 7 · Summary panel ══════════════════════════════════════════════════════════
// The desktop checkout surface, composed as a TICKET: poster, what you are buying,
// a punched perforation, then the money and the one action that authorises it.
//
// The notches are the only place on this route that needs to know the page colour, and
// they read it from --rd-canvas rather than a hex — so the illusion survives a retheme.
//
// `action` is the sticky checkout affordance (see RegisterClient). Passing it in keeps
// this component free of any submit logic.

export interface SummaryPricing {
  isPaid:        boolean
  priceLabel:    string
  /** Regular price label, shown struck through when an early bird or coupon is active. */
  strikeLabel:   string | null
  discountLabel: string | null
  couponCode:    string | null
  isEarlyBird:   boolean
  taxNote:       string | null
}

export function SummaryPanel({
  identity, passName, pricing, action,
}: {
  identity: EventIdentity
  passName: string
  pricing:  SummaryPricing
  action?:  ReactNode
}) {
  const { eventName, bannerUrl, dateLabel, timeLabel, venueLabel, isOnline, closesLabel } = identity
  const { isPaid, priceLabel, strikeLabel, discountLabel, couponCode, isEarlyBird, taxNote } = pricing

  const facts = [
    dateLabel   && { key: 'date',  Icon: Calendar, text: timeLabel ? `${dateLabel} · ${timeLabel}` : dateLabel },
    venueLabel  && { key: 'venue', Icon: isOnline ? Globe : MapPin, text: venueLabel },
    closesLabel && { key: 'closes', Icon: CalendarClock, text: `Registration closes ${closesLabel}` },
  ].filter(Boolean) as { key: string; Icon: typeof Calendar; text: string }[]

  // RD-RT4.0 QA: "Secured by Razorpay" was dropped from this list. It is not missing —
  // the line directly above this strip, under the CTA, already says "Encrypted payment
  // via Razorpay". Before RT4.0 the trust list and the CTA sat in separate blocks and the
  // repetition was invisible; putting the guarantees in a footer directly beneath the
  // action made the two adjacent, and the same claim twice in 40px reads as padding.
  const guarantees = [
    { key: 'instant', Icon: Zap,       text: 'Ticket emailed instantly' },
    { key: 'qr',      Icon: QrCode,    text: 'QR ticket for entry' },
    { key: 'refund',  Icon: RotateCcw, text: 'Organiser refund policy' },
  ]

  return (
    // No `overflow-hidden`: the perforation notches deliberately paint OUTSIDE the card
    // edge. The poster clips itself instead.
    <div className={PANEL}>
      {/* ── Poster ── Always present: a real banner when the organiser set one, the
          brand surface when they did not, so the panel never opens on a blank rectangle. */}
      <div className="relative aspect-[21/7] overflow-hidden rounded-t-2xl">
        {bannerUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={bannerUrl} alt="" className="absolute inset-0 size-full object-cover" />
        ) : (
          <div className={cn('absolute inset-0', BRAND_GRADIENT)} aria-hidden />
        )}
        <div aria-hidden className="absolute inset-0 bg-gradient-to-t from-slate-950/80 via-slate-950/25 to-transparent" />
        <div className="absolute inset-x-0 bottom-0 p-4">
          <p className="text-fs-2xs font-bold uppercase tracking-[0.14em] text-white/70">You are registering for</p>
          <p className="mt-0.5 truncate text-fs-md font-bold leading-snug text-white">{eventName}</p>
        </div>
      </div>

      {/* ── What you are buying ── */}
      <div className="px-5 pt-4 pb-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className={TYPE.label}>Your pass</p>
            <p className="mt-1 truncate text-fs-md font-bold text-foreground">{passName}</p>
          </div>
          <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <Ticket className="size-4" />
          </span>
        </div>

        {facts.length > 0 && (
          <ul className="mt-4 flex flex-col gap-2.5">
            {facts.map(f => (
              <li key={f.key} className="flex items-start gap-2.5 text-fs-xs leading-relaxed">
                <f.Icon className="mt-px size-3.5 shrink-0 text-primary/70" aria-hidden />
                <span className="min-w-0 text-foreground">{f.text}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* ── Perforation ──
          RD-RT4.0 QA: these were full 18px circles straddling the card edge (-left-9px /
          -right-9px). Geometrically that was symmetrical and did not clip — but the OUTER
          half of each circle is opaque canvas paint sitting on top of the card's ambient
          shadow, so it erased a bite out of the shadow and rendered as a BLISTER on the
          outside of the card instead of a hole punched into it. Confirmed at 4× zoom.

          They are now HALF-discs that stop exactly at the card's outer edge: 10px wide
          (1px to cover the border + a 9px radius), flat side flush with the edge, bulging
          inward. Nothing paints outside the border box, so the shadow is untouched and the
          edge reads as genuinely cut. The single-side border arcs are gone with them —
          they outlined the disc, which was the other half of the blister illusion. */}
      <div className="relative">
        <span aria-hidden className={cn('absolute -left-px top-1/2 h-[18px] w-[10px] -translate-y-1/2 rounded-r-full', CANVAS)} />
        <span aria-hidden className={cn('absolute -right-px top-1/2 h-[18px] w-[10px] -translate-y-1/2 rounded-l-full', CANVAS)} />
        {/* mx-5 matches the panel's px-5 gutter, so the rule lines up with the content
            above and below it rather than sitting on its own inset. */}
        <div aria-hidden className="mx-5 border-t border-dashed border-border" />
      </div>

      {/* ── Money ── the strongest block in the panel, immediately above the action it
          authorises. */}
      <div className="px-5 pt-5 pb-5">
        {discountLabel && (
          <div className="mb-3 flex items-center justify-between gap-3 rounded-lg bg-emerald-500/[0.07] px-3 py-2 text-fs-xs">
            <span className="inline-flex min-w-0 items-center gap-1.5 font-medium text-emerald-700">
              Discount
              {couponCode && (
                <span className="truncate rounded bg-emerald-500/15 px-1.5 py-0.5 font-mono text-fs-2xs font-bold">{couponCode}</span>
              )}
            </span>
            <span className="shrink-0 font-bold tabular-nums text-emerald-700">{discountLabel}</span>
          </div>
        )}

        <div className="flex items-end justify-between gap-3">
          <div className="min-w-0">
            <p className={TYPE.label}>{isPaid ? 'Total payable' : 'Total'}</p>
            {taxNote && <p className="mt-1 text-fs-2xs text-muted-foreground">{taxNote}</p>}
          </div>
          <div className="shrink-0 text-right">
            {strikeLabel && (
              <p className="text-fs-2xs text-muted-foreground line-through">{strikeLabel}</p>
            )}
            <p className={cn(
              'text-fs-2xl font-extrabold leading-none tracking-tight tabular-nums',
              strikeLabel ? 'text-emerald-600' : 'text-foreground',
            )}>
              {priceLabel}
            </p>
            {isEarlyBird && (
              <p className="mt-1 text-fs-2xs font-bold uppercase tracking-wide text-emerald-600">Early bird</p>
            )}
          </div>
        </div>

        {action && <div className="mt-4">{action}</div>}
      </div>

      {/* ── Guarantees ── quiet, factual, and last: they exist to support the button
          above, not to compete with it. */}
      <ul className="flex flex-col gap-2 rounded-b-2xl border-t border-border/60 bg-muted/40 px-5 py-4">
        {guarantees.map(g => (
          <li key={g.key} className="flex items-center gap-2 text-fs-2xs text-muted-foreground">
            <g.Icon className="size-3.5 shrink-0 text-emerald-600/80" aria-hidden />
            {g.text}
          </li>
        ))}
      </ul>
    </div>
  )
}

// ═══ 8 · Compact summary (mobile disclosure) ════════════════════════════════════
// The same facts as SummaryPanel, laid out for the sheet that opens above the mobile
// checkout bar. Presentation only — it renders the identical `identity` / `pricing`
// objects the desktop panel receives, so the two can never disagree.

export function SummaryDigest({ identity, passName, pricing }: {
  identity: EventIdentity
  passName: string
  pricing:  SummaryPricing
}) {
  const { dateLabel, timeLabel, venueLabel, isOnline, closesLabel, eventName } = identity

  const facts = [
    dateLabel   && { key: 'date',  Icon: Calendar, text: timeLabel ? `${dateLabel} · ${timeLabel}` : dateLabel },
    venueLabel  && { key: 'venue', Icon: isOnline ? Globe : MapPin, text: venueLabel },
    closesLabel && { key: 'closes', Icon: CalendarClock, text: `Registration closes ${closesLabel}` },
  ].filter(Boolean) as { key: string; Icon: typeof Calendar; text: string }[]

  return (
    <div className="flex flex-col gap-3">
      <div>
        <p className={TYPE.label}>Event</p>
        <p className="mt-0.5 text-fs-sm font-semibold text-foreground">{eventName}</p>
      </div>
      <div>
        <p className={TYPE.label}>Pass</p>
        <p className="mt-0.5 text-fs-sm font-semibold text-foreground">{passName}</p>
      </div>
      {facts.length > 0 && (
        <ul className="flex flex-col gap-1.5 border-t border-border/60 pt-3">
          {facts.map(f => (
            <li key={f.key} className="flex items-start gap-2 text-fs-xs">
              <f.Icon className="mt-0.5 size-3.5 shrink-0 text-primary/70" aria-hidden />
              <span className="text-foreground">{f.text}</span>
            </li>
          ))}
        </ul>
      )}
      {pricing.discountLabel && (
        <div className="flex items-center justify-between gap-3 border-t border-border/60 pt-3 text-fs-xs">
          <span className="font-medium text-emerald-700">
            Discount{pricing.couponCode ? ` · ${pricing.couponCode}` : ''}
          </span>
          <span className="font-bold tabular-nums text-emerald-700">{pricing.discountLabel}</span>
        </div>
      )}
      {pricing.taxNote && (
        <p className="border-t border-border/60 pt-3 text-fs-2xs text-muted-foreground">{pricing.taxNote}</p>
      )}
    </div>
  )
}

// ═══ 9 · Estimated completion ═══════════════════════════════════════════════════
// DERIVED, not stored. There is no "estimated time" field in the schema and none was
// invented: this is arithmetic over the real number of visible fields the user must
// fill, at roughly six fields per minute, floored at one minute. If the count is zero
// the caller gets null and the chip is not rendered.

export function estimateMinutes(visibleFieldCount: number): string | null {
  if (visibleFieldCount <= 0) return null
  const mins = Math.max(1, Math.ceil(visibleFieldCount / 6))
  return `${mins} minute${mins === 1 ? '' : 's'}`
}

export { Check, ChevronRight }
