'use client'

// RegistrationUI — the presentation layer for /events/[slug]/register.
//
// RD-RT1.0 architecture rework. The registration page and the Event Details page were
// two different design systems sharing a URL space: Event Details resolves every size
// through `TYPE.*` / `text-fs-*` tokens (0 raw sizes), while this route hard-coded 68
// raw pixel font sizes across 13 distinct values (13.5px, 12.5px, 11.5px, 10.5px …) and
// imported nothing from the framework. That — not spacing — is why clicking Register
// felt like leaving the product.
//
// Every component here is presentation only. No validation, no pricing maths, no
// Firestore, no Razorpay, no field generation. They receive already-computed values and
// render them; RegisterClient keeps 100% of the logic it had.
//
// Nothing is fabricated: each block renders only when its value exists, and the whole
// row/panel collapses when it does not.

import Link from 'next/link'
import { motion } from 'framer-motion'
import {
  Calendar, MapPin, Globe, ShieldCheck, Zap, RotateCcw, Check,
  CalendarClock, QrCode, ArrowLeft,
} from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { Breadcrumbs } from '@/components/ui/Breadcrumbs'
import { MarketingLogo } from '@/components/marketing/MarketingLogo'
import { PassPrice } from './PassPrice'
import {
  TYPE, CARD, CARD_PAD, BRAND_GRADIENT,
} from '@/components/event-templates/shared/ui/framework'

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

// ─── 1 · Compact page header ────────────────────────────────────────────────────
// RD-RT3.2. RT1.0 opened this route with a full-bleed poster hero: 21/6 banner, overlaid
// title, pass badge, metadata row and trust chips — roughly 350px before a single field.
// That is Event Details language, and the attendee has already made the decision it was
// built to support. Registration is a checkout, so it now opens with a ~110px header.
//
// Nothing was deleted, only relocated: poster, pass, date, venue, closing and the trust
// statements all live in the sticky summary, which is visible on desktop the whole way
// down. The page <h1> stays here.

export function RegistrationHeader({ eventSlug, eventName, estimate }: {
  eventSlug: string
  eventName: string
  /** Derived from the real visible-field count; null falls back to generic copy. */
  estimate:  string | null
}) {
  return (
    <header className="mb-4">
      {/* Checkout top bar — brand left, exit right, the convention every payment page
          follows. The negative margins let its rule span the full container width while
          the content stays on the page gutter. */}
      <div className="-mx-4 mb-3 flex h-12 items-center justify-between gap-4 border-b border-border/60 px-4 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
        <MarketingLogo className="h-6 w-auto sm:h-7" />
        <Link
          href={`/events/${eventSlug}`}
          className="inline-flex shrink-0 items-center gap-1.5 rounded text-fs-xs font-semibold text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-offset-2"
        >
          <ArrowLeft className="size-3.5" aria-hidden />
          Back to Event
        </Link>
      </div>

      <h1 className={TYPE.sectionTitle}>Register for {eventName}</h1>

      <p className={cn('mt-0.5', TYPE.cardBody)}>
        {estimate
          ? `Complete your registration in about ${estimate}.`
          : 'Complete your registration in just a few minutes.'}
      </p>

      {/* The SAME breadcrumb component the event page uses (SportsHero / EventPageShell),
          so the crumb trail does not change character between the two pages. */}
      <Breadcrumbs
        className="mt-2"
        items={[
          { label: 'Home',   href: '/' },
          { label: 'Events', href: '/events' },
          { label: eventName, href: `/events/${eventSlug}` },
          { label: 'Registration' },
        ]}
      />
    </header>
  )
}

// ─── 2 · Step wizard ────────────────────────────────────────────────────────────
// Was six numbered circles joined by hairlines — a technical read-out ("3 of 6") that
// told you where you were but not what was coming. Now each step carries its own LABEL
// above a progress rail: completed steps fill with the brand gradient, the current step
// is highlighted, future steps stay muted.
//
// Identical inputs, identical semantics: `activeIdx` (-1 = all complete) and
// `completedCount` are passed straight through from RegisterClient. No logic moved.

export function StepWizard({ sections, activeIdx, completedCount }: {
  sections:       { id: string; title?: string }[]
  activeIdx:      number
  completedCount: number
}) {
  if (sections.length <= 1) return null

  const total   = sections.length
  const allDone = activeIdx === -1

  return (
    <nav aria-label="Registration progress" className="mb-6">
      <div className="mb-2.5 flex items-baseline justify-between gap-4">
        <p className={TYPE.label}>Step {allDone ? total : Math.min(activeIdx + 1, total)} of {total}</p>
        <p className="text-fs-xs font-medium text-muted-foreground">
          {allDone ? total : completedCount} of {total} complete
        </p>
      </div>

      <ol className="flex items-stretch gap-1.5 sm:gap-2">
        {sections.map((s, i) => {
          const done    = allDone || i < activeIdx
          const current = !allDone && i === activeIdx
          return (
            <li key={s.id} className="min-w-0 flex-1">
              <p
                className={cn(
                  'mb-1.5 truncate text-fs-2xs font-bold uppercase tracking-[0.1em] transition-colors duration-200',
                  current ? 'text-primary' : done ? 'text-foreground' : 'text-muted-foreground/60',
                )}
                title={s.title ?? `Step ${i + 1}`}
              >
                {s.title ?? `Step ${i + 1}`}
              </p>
              <div className="relative h-1 overflow-hidden rounded-full bg-border/70">
                <motion.span
                  aria-hidden
                  className={cn('absolute inset-y-0 left-0', done ? BRAND_GRADIENT : 'bg-primary')}
                  initial={false}
                  animate={{ width: done ? '100%' : current ? '45%' : '0%' }}
                  transition={{ duration: 0.4, ease: [0.4, 0, 0.2, 1] }}
                />
              </div>
              {/* The visible rail is decorative; this is what assistive tech reads. */}
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

// ─── 2b · Journey stepper ───────────────────────────────────────────────────────
// RD-RT3.1. StepWizard tracks progress THROUGH THE FORM; this tracks progress through
// the REGISTRATION, which is a different question. One journey for every registration:
//
//   Registration → Review → Payment → Confirmation
//
// When no payment is due the Payment stage is marked "Not required" rather than removed,
// so a free registration and a paid one describe the same journey — the shape of the
// flow never changes underneath the attendee.

export type JourneyStage = 'form' | 'review' | 'payment' | 'success'

const JOURNEY: { id: JourneyStage; label: string }[] = [
  { id: 'form',     label: 'Registration' },
  { id: 'review',   label: 'Review'       },
  { id: 'payment',  label: 'Payment'      },
  { id: 'success',  label: 'Confirmation' },
]

export function JourneyStepper({ current, paymentRequired }: {
  current:         JourneyStage
  /** False → the Payment stage renders as skipped, never hidden. */
  paymentRequired: boolean
}) {
  const currentIdx = JOURNEY.findIndex(s => s.id === current)

  return (
    <nav aria-label="Registration journey" className="mb-4">
      <ol className="flex items-center gap-2 sm:gap-3">
        {JOURNEY.map((stage, i) => {
          const skipped = stage.id === 'payment' && !paymentRequired
          const done    = i < currentIdx && !skipped
          const active  = i === currentIdx
          return (
            <li key={stage.id} className="flex min-w-0 flex-1 items-center gap-2 sm:gap-3">
              <div className="flex min-w-0 items-center gap-2">
                <span
                  aria-hidden
                  className={cn(
                    'flex size-6 shrink-0 items-center justify-center rounded-full text-fs-2xs font-bold transition-colors',
                    done    ? cn(BRAND_GRADIENT, 'text-white')
                    : active ? 'bg-primary/10 text-primary ring-2 ring-primary/30'
                    : skipped ? 'bg-muted text-muted-foreground/50'
                    : 'bg-muted text-muted-foreground/60',
                  )}
                >
                  {done ? <Check className="size-3.5" strokeWidth={3} /> : skipped ? '–' : i + 1}
                </span>
                <span
                  className={cn(
                    'hidden truncate text-fs-xs font-semibold sm:block',
                    active ? 'text-foreground' : skipped ? 'text-muted-foreground/50' : 'text-muted-foreground',
                  )}
                >
                  {stage.label}
                </span>
              </div>
              {i < JOURNEY.length - 1 && (
                <span aria-hidden className={cn('h-px min-w-2 flex-1', done ? 'bg-primary/40' : 'bg-border')} />
              )}
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

// ─── 3 · Form section card ──────────────────────────────────────────────────────
// A pure shell so every logical group gets the SAME rhythm — one card language, one
// header treatment, one padding. Fields are rendered by RegisterClient and passed as
// children; this component never knows what a field is.

export function FormSectionCard({ title, description, index, complete, children }: {
  title?:       string
  description?: string
  /** Ordinal shown in the header chip; purely visual grouping. */
  index:        number
  /**
   * RD-RT3.3: true when every required field in this section is filled. Derived from
   * state the page already computes — no new source. A long form reads shorter when you
   * can see which parts are behind you.
   */
  complete?:    boolean
  children:     React.ReactNode
}) {
  return (
    // RD-RT3.2.2 BUG 2 (cause A): `overflow-hidden` used to live here to clip the header
    // tint to the card's rounded corners — but it also clipped any absolutely-positioned
    // dropdown opened by a field inside the card, which is why the Running Category list
    // was cut off at the card edge. The header now rounds its OWN top corners, so the
    // card no longer needs to clip its children.
    <section className={cn(CARD)}>
      {title && (
        <div className="flex items-start gap-3 rounded-t-2xl border-b border-border/60 bg-muted/[0.03] px-5 py-4">
          <span
            aria-hidden
            className={cn(
              'mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-lg text-fs-2xs font-bold transition-colors duration-200',
              complete ? 'bg-emerald-600 text-white' : 'bg-primary/10 text-primary',
            )}
          >
            {complete ? <Check className="size-3.5" strokeWidth={3} /> : index}
          </span>
          <div className="min-w-0 flex-1">
            <h2 className={TYPE.cardTitle}>{title}</h2>
            {description && <p className={cn('mt-0.5', TYPE.cardBody)}>{description}</p>}
          </div>
          {complete && (
            <span className="mt-0.5 shrink-0 text-fs-2xs font-semibold text-emerald-600">Complete</span>
          )}
        </div>
      )}
      {/* gap-5 (was gap-4): related fields need a little more air than the 16px that made
          a long section read as one undifferentiated wall. */}
      <div className="flex flex-col gap-5 px-5 py-5">{children}</div>
    </section>
  )
}

// ─── 4 · Summary panel ──────────────────────────────────────────────────────────
// The old card was a 340px column of 10.5–16px hand-set type. Same information, now on
// the page's card language, with the order-of-decision hierarchy: what → which pass →
// how much → when/where → what's guaranteed.
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
  action?:  React.ReactNode
}) {
  const { eventName, bannerUrl, dateLabel, timeLabel, venueLabel, isOnline, closesLabel } = identity
  const { isPaid, priceLabel, strikeLabel, discountLabel, couponCode, isEarlyBird, taxNote } = pricing

  const facts = [
    dateLabel  && { key: 'date',  Icon: Calendar,      text: timeLabel ? `${dateLabel} · ${timeLabel}` : dateLabel },
    venueLabel && { key: 'venue', Icon: isOnline ? Globe : MapPin, text: venueLabel },
    closesLabel && { key: 'closes', Icon: CalendarClock, text: `Closes ${closesLabel}` },
  ].filter(Boolean) as { key: string; Icon: typeof Calendar; text: string }[]

  const guarantees = [
    isPaid && { key: 'pay', Icon: ShieldCheck, text: 'Secured by Razorpay' },
    { key: 'instant', Icon: Zap, text: 'Ticket emailed instantly' },
    { key: 'qr', Icon: QrCode, text: 'QR ticket for entry' },
    { key: 'refund', Icon: RotateCcw, text: 'Refund policy set by the organiser' },
  ].filter(Boolean) as { key: string; Icon: typeof ShieldCheck; text: string }[]

  return (
    <div className={cn(CARD, 'overflow-hidden')}>
      {/* Poster strip — omitted entirely when there is none, rather than left blank. */}
      {bannerUrl && (
        <div className="relative aspect-[21/8] overflow-hidden">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={bannerUrl} alt="" className="absolute inset-0 size-full object-cover" />
          <div className="absolute inset-0 bg-gradient-to-t from-black/70 to-transparent" />
          <p className="absolute inset-x-0 bottom-0 truncate p-3.5 text-fs-sm font-bold text-white">{eventName}</p>
        </div>
      )}

      {/* RD-RT3.2 order: event → pass → date → venue → closing → coupon → total →
          secure payment → CTA. Money sits immediately above the action it authorises. */}
      <div className="divide-y divide-border/50">
        {/* 1 · Event — only when the poster has not already carried the name. */}
        {!bannerUrl && (
          <div className="px-4 py-3.5">
            <p className={TYPE.cardTitle}>{eventName}</p>
          </div>
        )}

        {/* 2–5 · Pass · Date · Venue · Closing — ONE block. These are all "what you are
            buying"; separating each with a rule made four facts read as four sections. */}
        <div className="flex flex-col gap-2 px-4 py-3">
          <div className="flex items-baseline justify-between gap-3">
            <span className={TYPE.label}>Pass</span>
            <span className="min-w-0 truncate text-fs-sm font-semibold text-foreground">{passName}</span>
          </div>
          {facts.map(f => (
            <div key={f.key} className="flex items-start gap-2 text-fs-xs">
              <f.Icon className="mt-0.5 size-3.5 shrink-0 text-primary/70" aria-hidden />
              <span className="text-foreground">{f.text}</span>
            </div>
          ))}
        </div>

        {/* 6 · Coupon — only when one is actually applied. */}
        {discountLabel && (
          <div className="bg-emerald-50/70 px-4 py-3">
            <div className="flex items-center justify-between text-fs-xs">
              <span className="inline-flex items-center gap-1.5 text-emerald-700">
                Discount
                {couponCode && (
                  <span className="rounded bg-emerald-100 px-1.5 py-0.5 font-mono text-fs-2xs font-bold">{couponCode}</span>
                )}
              </span>
              <span className="font-semibold text-emerald-700">{discountLabel}</span>
            </div>
          </div>
        )}

        {/* 7 · Total — the strongest row in the panel. A coupon strikethrough takes
            precedence over the early-bird one, so this row stays label-driven; the badge
            uses the same rule PassPrice applies everywhere else. */}
        <div className="px-4 py-3.5">
          <div className="flex items-baseline justify-between gap-3">
            <p className="text-fs-sm font-bold text-foreground">Total</p>
            <div className="shrink-0 text-right">
              {strikeLabel && (
                <p className="text-fs-2xs text-muted-foreground line-through">{strikeLabel}</p>
              )}
              <p className={cn('text-fs-lg font-bold tabular-nums', strikeLabel ? 'text-emerald-600' : 'text-foreground')}>
                {priceLabel}
              </p>
              {isEarlyBird && (
                <p className="text-fs-2xs font-bold uppercase tracking-wide text-emerald-600">Early bird</p>
              )}
            </div>
          </div>
          {taxNote && <p className="mt-1.5 text-fs-2xs text-muted-foreground">{taxNote}</p>}
        </div>

        {/* 8–9 · Trust then the page's one primary action — no rule between them: the
            guarantees exist to support the button directly beneath. */}
        <div className="px-4 py-3.5">
          <ul className="flex flex-col gap-1.5">
            {guarantees.map(g => (
              <li key={g.key} className="flex items-start gap-2 text-fs-2xs text-muted-foreground">
                <g.Icon className="mt-px size-3.5 shrink-0 text-emerald-600" aria-hidden />
                {g.text}
              </li>
            ))}
          </ul>
          {action && <div className="mt-3.5">{action}</div>}
        </div>
      </div>
    </div>
  )
}

// ─── 5 · Pass switcher ──────────────────────────────────────────────────────────
// Unchanged behaviour (role=radiogroup, same onSelect); tokenised type only.

export function PassSwitcher({ passes, selectedId, onSelect, switching }: {
  passes:     { id: string; name: string; price: number; regularPrice: number; isFree: boolean; ageLabel?: string | null }[]
  selectedId: string
  onSelect:   (id: string) => void
  switching:  boolean
}) {
  return (
    <div className="mb-6" role="radiogroup" aria-label="Select your pass">
      <p className={cn('mb-2', TYPE.label)}>Your pass</p>
      <div className="flex flex-col gap-2">
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
                'flex items-center justify-between gap-3 rounded-xl border px-4 py-3 text-left outline-none transition-colors disabled:opacity-60',
                'focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-offset-2',
                active ? 'border-primary bg-primary/[0.04] ring-1 ring-primary/20' : 'border-border bg-card hover:border-primary/40',
              )}
            >
              <span className="flex min-w-0 items-center gap-2.5">
                <span className={cn('flex size-4 shrink-0 items-center justify-center rounded-full border', active ? 'border-primary' : 'border-border')}>
                  {active && <span className="size-2 rounded-full bg-primary" aria-hidden />}
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-fs-sm font-semibold text-foreground">{p.name}</span>
                  {/* RD-RT3.2.3: the age window, shown only from real configured values
                      and hidden entirely when the pass is unrestricted. */}
                  {p.ageLabel && (
                    <span className="mt-0.5 block text-fs-2xs text-muted-foreground">Age {p.ageLabel}</span>
                  )}
                </span>
              </span>
              <PassPrice price={p.price} regularPrice={p.regularPrice} isFree={p.isFree} size="sm" className="shrink-0" />
            </button>
          )
        })}
      </div>
    </div>
  )
}

// ─── 6 · Estimated completion ───────────────────────────────────────────────────
// DERIVED, not stored. There is no "estimated time" field in the schema and none was
// invented: this is arithmetic over the real number of visible fields the user must
// fill, at roughly six fields per minute, floored at one minute. If the count is zero
// the caller gets null and the chip is not rendered.

export function estimateMinutes(visibleFieldCount: number): string | null {
  if (visibleFieldCount <= 0) return null
  const mins = Math.max(1, Math.ceil(visibleFieldCount / 6))
  return `${mins} minute${mins === 1 ? '' : 's'}`
}

export { Check }
