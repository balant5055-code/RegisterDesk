'use client'

// RegistrationReview — the pre-payment confirmation experience.
//
// RD-RT3.0 rework of the panel introduced by RD-PAYMENT-05 B1. That panel was correct
// but technical: a bold line, a sentence, a <dl> of fee rows and two buttons, all at the
// same visual weight, with the attendee's own answers nowhere in sight. You confirmed a
// number without being shown what you were buying or what you had typed.
//
// It is now five sections, in the order a buyer actually checks them:
//
//   1. Registration Summary — poster, event, pass, date, venue, closing
//   2. Attendee Summary     — the answers, grouped by the organiser's own form sections
//   3. Pass Summary         — pass, price, discount, confirmation mode
//   4. Pricing Summary      — invoice rows, total carrying the strongest emphasis
//   5. Confirmation         — explicit consent before the payment sheet opens
//
// Presentation only. Every value is passed in already computed; this file performs no
// pricing maths, no validation and no network work. `onProceed` calls the existing
// confirmAndPay(), `onEdit` the existing setFeeConfirm(null).
//
// DATA HONESTY: pass benefits, distance/category and event category are NOT rendered —
// none of them reach this route (see the RT3.0 report). Nothing is substituted.

import Link from 'next/link'
import { motion, useReducedMotion } from 'framer-motion'
import {
  Calendar, MapPin, Globe, CalendarClock, ShieldCheck, Ticket, Pencil,
  ArrowLeft, BadgeCheck, Clock3,
} from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import {
  TYPE, CARD, CARD_PAD, BRAND_GRADIENT, reveal,
} from '@/components/event-templates/shared/ui/framework'
import { buttonVariants } from '@/components/ui/button'
import { CheckOption } from './formControls'
import type { EventIdentity } from './RegistrationUI'

// ─── Shapes ─────────────────────────────────────────────────────────────────────

export interface ReviewAnswerGroup {
  /** The organiser's own section title — the grouping, not one we invented. */
  title:  string
  items:  { id: string; label: string; value: string }[]
}

/**
 * RD-RT3.1: the review renders a LIST of participants, not "the attendee". Exactly one
 * is supplied today; Universal Group Registration adds entries without touching this
 * component. Nothing here assumes length === 1.
 */
export interface ReviewParticipant {
  id:     string
  name:   string
  email:  string
  phone?: string
  groups: ReviewAnswerGroup[]
}

export interface ReviewConsent {
  info:   boolean
  terms:  boolean
  refund: boolean
}

/** THE gate. Used by the review CTA and the sticky-summary CTA alike. */
export function isReviewReady(c: ReviewConsent, termsUrl?: string, refundPolicyUrl?: string): boolean {
  return c.info && (!termsUrl?.trim() || c.terms) && (!refundPolicyUrl?.trim() || c.refund)
}

export interface ReviewPricing {
  lines:      { label: string; paise: number }[]
  totalPaise: number
  /** Present only when a coupon is applied. */
  discount:   { code: string; label: string } | null
  /**
   * True once the SERVER has returned canonical financials (RD-PAYMENT-05 B1), i.e. the
   * itemised charge that Razorpay will take. Until then the review shows the pass price
   * it already knows and says so.
   */
  authoritative: boolean
}

// ─── Section shell ──────────────────────────────────────────────────────────────
// One card, one header treatment, one ordinal chip — the same language RT1.0 gave the
// form sections, so review reads as a continuation rather than a different screen.

function ReviewSection({ index, title, action, reduce, children }: {
  index:    number
  title:    string
  action?:  React.ReactNode
  reduce:   boolean | null
  children: React.ReactNode
}) {
  return (
    <motion.section {...reveal(reduce)} className={cn(CARD, 'overflow-hidden')}>
      <div className="flex items-center justify-between gap-3 border-b border-border/60 bg-muted/[0.03] px-5 py-4">
        <div className="flex min-w-0 items-center gap-3">
          <span
            aria-hidden
            className="flex size-6 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-fs-2xs font-bold text-primary"
          >
            {index}
          </span>
          <h2 className={TYPE.cardTitle}>{title}</h2>
        </div>
        {action}
      </div>
      <div className={CARD_PAD}>{children}</div>
    </motion.section>
  )
}

const EDIT_BTN =
  'inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-fs-xs font-semibold text-foreground outline-none transition-colors hover:border-primary/40 hover:text-primary focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-offset-2'

// ─── Review ─────────────────────────────────────────────────────────────────────

export function RegistrationReview({
  identity, passName, passPriceLabel, strikeLabel, passAgeLabel, approvalMode,
  participants, paymentRequired, pricing, termsUrl, refundPolicyUrl,
  submitting, consent, onConsent, ready, onProceed, onEdit,
}: {
  identity:        EventIdentity
  passName:        string
  passPriceLabel:  string
  strikeLabel:     string | null
  /** RD-RT3.2.3: informational only — the window this pass is open to. */
  passAgeLabel?:   string | null
  approvalMode:    'auto' | 'manual'
  /** One entry today. RD-RT3.1 keeps this a list so group registration is additive. */
  participants:    ReviewParticipant[]
  /** Drives the CTA and the payment section. False for free / fully-discounted. */
  paymentRequired: boolean
  pricing:         ReviewPricing
  termsUrl?:       string
  refundPolicyUrl?: string
  submitting:      boolean
  consent:         ReviewConsent
  onConsent:       (key: keyof ReviewConsent, value: boolean) => void
  /** Computed by the caller so this CTA and the sticky summary CTA share one gate. */
  ready:           boolean
  onProceed:       () => void
  onEdit:          () => void
}) {
  const reduce = useReducedMotion()

  const terms  = termsUrl?.trim()
  const refund = refundPolicyUrl?.trim()

  const facts = [
    identity.dateLabel && {
      key: 'date', Icon: Calendar,
      text: identity.timeLabel ? `${identity.dateLabel} · ${identity.timeLabel}` : identity.dateLabel,
    },
    identity.venueLabel && { key: 'venue', Icon: identity.isOnline ? Globe : MapPin, text: identity.venueLabel },
    identity.closesLabel && { key: 'closes', Icon: CalendarClock, text: `Registration closes ${identity.closesLabel}` },
  ].filter(Boolean) as { key: string; Icon: typeof Calendar; text: string }[]

  const fmtPaise = (p: number) => {
    const r = p / 100
    return `₹${r.toLocaleString('en-IN', { minimumFractionDigits: p % 100 ? 2 : 0, maximumFractionDigits: 2 })}`
  }

  return (
    <div className="flex flex-col gap-4">

      {/* ══ 1 · Registration Summary ══ */}
      <ReviewSection index={1} title="Registration Summary" reduce={reduce}>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
          <div className="relative aspect-[16/10] w-full shrink-0 overflow-hidden rounded-xl sm:w-40">
            {identity.bannerUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={identity.bannerUrl} alt="" className="absolute inset-0 size-full object-cover" />
            ) : (
              <div className={cn('absolute inset-0', BRAND_GRADIENT)} aria-hidden />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <h3 className={TYPE.cardTitleLg}>{identity.eventName}</h3>
            <p className="mt-1 inline-flex items-center gap-1.5 text-fs-sm font-semibold text-primary">
              <Ticket className="size-3.5" aria-hidden />
              {passName}
            </p>
            {facts.length > 0 && (
              <ul className="mt-3 flex flex-col gap-1.5">
                {facts.map(f => (
                  <li key={f.key} className="flex items-start gap-2 text-fs-sm text-foreground">
                    <f.Icon className="mt-0.5 size-3.5 shrink-0 text-primary/70" aria-hidden />
                    {f.text}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </ReviewSection>

      {/* ══ 2 · Attendee Summary ══ */}
      <ReviewSection
        index={2}
        title="Your Details"
        reduce={reduce}
        action={
          <button type="button" onClick={onEdit} className={EDIT_BTN}>
            <Pencil className="size-3" aria-hidden />
            Edit
          </button>
        }
      >
        <div className="flex flex-col gap-5">
          {participants.map((p, pi) => (
            <div key={p.id} className={cn(pi > 0 && "border-t border-border/50 pt-5")}>
              {/* Only labelled when there is more than one — a solo registration should
                  not read like a group of one. */}
              {participants.length > 1 && (
                <h3 className={cn("mb-3", TYPE.cardTitle)}>Participant {pi + 1}</h3>
              )}

              <p className={TYPE.label}>Registered as</p>
              <dl className="mt-2 grid gap-x-6 gap-y-2 sm:grid-cols-2">
                <ReviewRow label="Name"  value={p.name} />
                <ReviewRow label="Email" value={p.email} />
                {p.phone?.trim() && <ReviewRow label="Phone" value={p.phone} />}
              </dl>

              {/* Everything else, grouped by the organiser's OWN form sections. */}
              {p.groups.map(group => (
                <div key={group.title} className="mt-5 border-t border-border/50 pt-5">
                  <p className={TYPE.label}>{group.title}</p>
                  <dl className="mt-2 grid gap-x-6 gap-y-2 sm:grid-cols-2">
                    {group.items.map(item => (
                      <ReviewRow key={item.id} label={item.label} value={item.value} />
                    ))}
                  </dl>
                </div>
              ))}
            </div>
          ))}
        </div>
      </ReviewSection>

      {/* ══ 3 · Pass Summary ══ */}
      <ReviewSection index={3} title="Your Pass" reduce={reduce}>
        <div className={cn('flex items-start justify-between gap-4 rounded-xl border border-primary/20 bg-primary/[0.03] p-4')}>
          <div className="min-w-0">
            <p className="text-fs-md font-bold text-foreground">{passName}</p>
            {passAgeLabel && (
              <p className="mt-1 text-fs-xs text-muted-foreground">
                Eligible age <span className="font-semibold text-foreground">{passAgeLabel}</span>
              </p>
            )}
            <p className="mt-1.5 inline-flex items-center gap-1.5 text-fs-xs font-medium text-muted-foreground">
              {approvalMode === 'manual' ? (
                <><Clock3 className="size-3.5 shrink-0 text-amber-600" aria-hidden />Confirmed after organiser review</>
              ) : (
                <><BadgeCheck className="size-3.5 shrink-0 text-emerald-600" aria-hidden />Confirmed instantly</>
              )}
            </p>
          </div>
          <div className="shrink-0 text-right">
            {strikeLabel && <p className="text-fs-2xs text-muted-foreground line-through">{strikeLabel}</p>}
            <p className={cn('text-fs-lg font-bold tabular-nums', strikeLabel ? 'text-emerald-600' : 'text-foreground')}>
              {passPriceLabel}
            </p>
            {/* RD-RT3.2.2: the badge was missing here while the summary showed it. */}
            {strikeLabel && (
              <p className="text-fs-2xs font-bold uppercase tracking-wide text-emerald-600">Early bird</p>
            )}
          </div>
        </div>
      </ReviewSection>

      {/* ══ 4 · Pricing Summary ══ */}
      <ReviewSection index={4} title={paymentRequired ? 'Payment Summary' : 'Order Summary'} reduce={reduce}>
        <dl className="flex flex-col gap-2.5">
          {pricing.lines.map(l => (
            <div key={l.label} className="flex items-center justify-between gap-4 text-fs-sm">
              <dt className="text-muted-foreground">{l.label}</dt>
              <dd className="tabular-nums text-foreground">{fmtPaise(l.paise)}</dd>
            </div>
          ))}

          {pricing.discount && (
            <div className="flex items-center justify-between gap-4 text-fs-sm">
              <dt className="inline-flex items-center gap-1.5 text-emerald-700">
                Discount
                <span className="rounded bg-emerald-100 px-1.5 py-0.5 font-mono text-fs-2xs font-bold">
                  {pricing.discount.code}
                </span>
              </dt>
              <dd className="font-semibold tabular-nums text-emerald-700">{pricing.discount.label}</dd>
            </div>
          )}

          {/* Total — the strongest thing on the screen. */}
          <div className="mt-2 flex items-baseline justify-between gap-4 border-t border-border pt-3">
            <dt className="text-fs-md font-bold text-foreground">
              {paymentRequired ? "Total payable" : "Total"}
            </dt>
            <dd className="text-fs-xl font-bold tabular-nums tracking-tight text-foreground">
              {pricing.totalPaise === 0 ? "Free" : fmtPaise(pricing.totalPaise)}
            </dd>
          </div>
        </dl>

        {/* Honest about provenance: any platform fees are itemised by the server on the
            next step, so this total is never presented as final before it is. */}
        {paymentRequired && !pricing.authoritative && (
          <p className="mt-3 text-fs-2xs text-muted-foreground">
            Any applicable fees are itemised before payment opens.
          </p>
        )}
      </ReviewSection>

      {/* ══ 5 · Confirmation ══ */}
      <ReviewSection index={5} title={paymentRequired ? "Confirm & Pay" : "Confirm Registration"} reduce={reduce}>
        <div className="flex flex-col gap-2">
          <CheckOption checked={consent.info} disabled={submitting} onToggle={v => onConsent('info', v)}>
            I confirm the information above is correct
          </CheckOption>

          {terms && (
            <CheckOption checked={consent.terms} disabled={submitting} onToggle={v => onConsent('terms', v)}>
              I agree to the{' '}
              <Link href={terms} target="_blank" rel="noopener noreferrer" className="font-semibold text-primary underline underline-offset-2">
                Terms &amp; Conditions
              </Link>
            </CheckOption>
          )}

          {refund && (
            <CheckOption checked={consent.refund} disabled={submitting} onToggle={v => onConsent('refund', v)}>
              I agree to the{' '}
              <Link href={refund} target="_blank" rel="noopener noreferrer" className="font-semibold text-primary underline underline-offset-2">
                Refund Policy
              </Link>
            </CheckOption>
          )}
        </div>

        <div className="mt-5 flex flex-col gap-2.5 sm:flex-row-reverse">
          <button
            type="button"
            onClick={onProceed}
            disabled={submitting || !ready}
            className={cn(buttonVariants({ variant: 'primary', size: 'lg' }), 'flex-1 gap-2')}
          >
            <ShieldCheck className="size-4" aria-hidden />
            {submitting
              ? 'Processing…'
              : paymentRequired
                ? `Proceed to Secure Payment · ${fmtPaise(pricing.totalPaise)}`
                : 'Confirm & Complete Registration'}
          </button>
          <button
            type="button"
            onClick={onEdit}
            disabled={submitting}
            className={cn(buttonVariants({ variant: 'outline', size: 'lg' }), 'gap-1.5 sm:flex-none')}
          >
            <ArrowLeft className="size-4" aria-hidden />
            Edit Registration
          </button>
        </div>

        {/* Explains the disabled state instead of leaving it unexplained. */}
        {!ready && (
          <p aria-live="polite" className="mt-2.5 text-center text-fs-xs text-muted-foreground">
            Tick the boxes above to continue.
          </p>
        )}
      </ReviewSection>
    </div>
  )
}

/** One label/value pair. Long answers wrap across both columns. */
function ReviewRow({ label, value }: { label: string; value: string }) {
  const long = value.length > 40
  return (
    <div className={cn('min-w-0', long && 'sm:col-span-2')}>
      <dt className="text-fs-2xs font-medium uppercase tracking-[0.08em] text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 break-words text-fs-sm text-foreground">{value}</dd>
    </div>
  )
}
