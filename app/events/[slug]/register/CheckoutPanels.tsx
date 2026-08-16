'use client'

// CheckoutPanels — the on-page checkout blocks for /events/[slug]/register.
//
// RD-RT5.0 "One Page". These replace RegistrationReview.tsx, which rendered a SECOND
// screen the attendee had to reach before they could pay: the form unmounted, five
// review sections mounted, and the primary action moved. Two screens meant two chances
// to abandon — and on mobile it meant reading the same answers twice on the way to a
// button that had been one tap away the whole time.
//
// The two things that screen genuinely OWNED are not review-only concerns, so they are
// now panels inside the single form:
//
//   ConsentPanel      — the consent gate (and the terms / refund acknowledgements)
//   OrderSummaryPanel — the itemised total, immediately above the Pay button
//
// Everything else it rendered — the poster, the event facts, the attendee's own answers
// played back, a second copy of the CTA — restated what is already on the page and is
// gone with it.
//
// Presentation only. No validation, no pricing maths, no network, no Razorpay. Every
// value arrives already computed by RegisterClient, exactly as it did before.

import Link from 'next/link'
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ShieldCheck, Receipt, ArrowRight, Lock } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { TYPE } from '@/components/event-templates/shared/ui/framework'
import { Dialog } from '@/components/ui/Dialog'
import { TermsDialog } from '@/components/legal/TermsDialog'
import { buttonVariants } from '@/components/ui/button'
import { useFocusTrap } from '@/lib/hooks/useFocusTrap'
import { CheckOption } from './formControls'
import { PANEL, PANEL_HEAD, PANEL_BODY } from './registerTheme'

// ─── Consent gate ───────────────────────────────────────────────────────────────

export interface ConsentState {
  info:   boolean
  terms:  boolean
  refund: boolean
}

/**
 * THE gate — one definition, shared by the submit handler, the desktop summary CTA and
 * the mobile checkout bar, so no surface can become an ungated path to payment.
 *
 * Logic is unchanged from the previous isReviewReady(): the same three flags, and terms
 * / refund are only required when the organiser actually published that URL.
 */
export function isConsentComplete(
  c: ConsentState,
  termsUrl?: string,
  refundPolicyUrl?: string,
): boolean {
  // `c.terms` is now unconditional: the PLATFORM Terms & Conditions are mandatory for every
  // event, shown in a modal rather than depending on an organiser-published URL. The refund
  // row keeps its URL-conditional behaviour, which is unchanged.
  return c.info && c.terms && (!refundPolicyUrl?.trim() || c.refund)
}

/**
 * Scroll/focus target used when Pay is pressed while consent is still missing.
 * The CTA is deliberately NOT disabled in that state (a disabled button fires no event
 * and reads as broken) — it brings the attendee here and says why instead.
 */
export const CONSENT_SECTION_ID = 'terms-and-consent'

// ─── Shared shell ───────────────────────────────────────────────────────────────
// The same panel language the organiser's form sections use (FormSectionCard), with an
// icon in place of the ordinal chip: these are checkout blocks, not question groups, and
// numbering them would imply they are more steps of the form.

function CheckoutSection({ id, icon, title, description, emphasis, children }: {
  id?:          string
  icon:         ReactNode
  title:        string
  description?: string
  /** The block that carries the decision gets the brand edge. */
  emphasis?:    boolean
  children:     ReactNode
}) {
  return (
    <section
      id={id}
      tabIndex={id ? -1 : undefined}
      className={cn(
        PANEL,
        'mt-4 scroll-mt-24 outline-none transition-shadow duration-300',
        emphasis && 'border-primary/35 shadow-[0_1px_2px_rgb(15_23_42_/_0.04),0_20px_44px_-28px_rgb(var(--primary-rgb)_/_0.35)]',
      )}
    >
      <div className={cn(PANEL_HEAD, 'flex items-start gap-3 rounded-t-2xl')}>
        <span
          aria-hidden
          className="mt-px flex size-7 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary"
        >
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <h2 className={TYPE.cardTitle}>{title}</h2>
          {description && <p className={cn('mt-0.5', TYPE.cardBody)}>{description}</p>}
        </div>
      </div>
      <div className={PANEL_BODY}>{children}</div>
    </section>
  )
}

// ─── 1 · Terms & Consent ────────────────────────────────────────────────────────

export function ConsentPanel({
  consent, onConsent, termsUrl, refundPolicyUrl, submitting, needsConsent = false,
}: {
  consent:          ConsentState
  onConsent:        (key: keyof ConsentState, value: boolean) => void
  termsUrl?:        string
  refundPolicyUrl?: string
  submitting:       boolean
  /** Set by the caller when Pay was pressed with consent missing. */
  needsConsent?:    boolean
}) {
  const [termsOpen, setTermsOpen] = useState(false)
  const terms  = termsUrl?.trim()
  const refund = refundPolicyUrl?.trim()

  return (
    <CheckoutSection
      id={CONSENT_SECTION_ID}
      icon={<ShieldCheck className="size-3.5" />}
      title="Terms & Consent"
      description="Required before payment."
      emphasis
    >
      {needsConsent && (
        // role=alert so the reason is announced the moment it appears — a purely visual
        // ring would leave a screen-reader user with a button that silently does nothing.
        <p role="alert" className="mb-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-fs-xs font-medium text-amber-800">
          Please confirm the information above before continuing.
        </p>
      )}

      <div className={cn(
        'flex flex-col gap-2 rounded-xl transition-shadow duration-300',
        // Amber, not primary: this is a "you missed something" prompt, and reusing the
        // brand pink here would recreate the exact ambiguity RD-REGISTRATION-UX removed.
        needsConsent && 'ring-2 ring-amber-400/70 ring-offset-2',
      )}>
        <CheckOption checked={consent.info} disabled={submitting} onToggle={v => onConsent('info', v)}>
          I confirm the information above is correct
        </CheckOption>

        <CheckOption checked={consent.terms} disabled={submitting} onToggle={v => onConsent('terms', v)}>
          I agree to the{' '}
          {/* Opens the terms modal. type=button: inside the form a bare button submits. */}
          <button type="button" onClick={() => setTermsOpen(true)} className="font-semibold text-primary underline underline-offset-2">
            Terms &amp; Conditions
          </button>
          {terms && (
            <>
              {' · '}
              <Link href={terms} target="_blank" rel="noopener noreferrer" className="font-semibold text-primary underline underline-offset-2">
                Organiser terms
              </Link>
            </>
          )}
        </CheckOption>

        {refund && (
          <CheckOption checked={consent.refund} disabled={submitting} onToggle={v => onConsent('refund', v)}>
            I agree to the{' '}
            <Link href={refund} target="_blank" rel="noopener noreferrer" className="font-semibold text-primary underline underline-offset-2">
              Refund Policy
            </Link>
          </CheckOption>
        )}
      </div>

      <TermsDialog
        open={termsOpen}
        onClose={() => setTermsOpen(false)}
        onAgree={() => onConsent('terms', true)}
        alreadyAgreed={consent.terms}
      />
    </CheckoutSection>
  )
}

// ─── 2 · Payment summary ────────────────────────────────────────────────────────
// The invoice, immediately above the action that authorises it. On desktop the sticky
// ticket panel carries the same total; this carries the BREAKDOWN, which a 56px footer
// chip and a ticket stub cannot.

export interface OrderLine { label: string; paise: number }

function fmtPaise(p: number): string {
  const r = p / 100
  return `₹${r.toLocaleString('en-IN', {
    minimumFractionDigits: p % 100 ? 2 : 0,
    maximumFractionDigits: 2,
  })}`
}

export function OrderSummaryPanel({
  passName, passPriceLabel, strikeLabel, passAgeLabel,
  lines, discount, totalPaise, paymentRequired, authoritative,
}: {
  passName:        string
  passPriceLabel:  string
  strikeLabel:     string | null
  /** Informational only — the age window this pass is open to. Null when unrestricted. */
  passAgeLabel?:   string | null
  lines:           OrderLine[]
  discount:        { code: string; label: string } | null
  totalPaise:      number
  paymentRequired: boolean
  /**
   * True once the SERVER has returned canonical financials, i.e. the itemised charge
   * Razorpay will take. Until then this shows the pass price the page already knows and
   * says so, rather than presenting an estimate as final.
   */
  authoritative:   boolean
}) {
  return (
    <CheckoutSection
      icon={<Receipt className="size-3.5" />}
      // RD-RT6.0: always "Order Summary", never "Payment Summary". That title now belongs
      // to the confirmation dialog, and having two blocks under the same heading — one of
      // them behind a backdrop — is exactly the "which one am I acting on?" ambiguity this
      // change exists to remove. The information is unchanged; only the label is.
      title="Order Summary"
    >
      {/* What you are buying — kept here because a single-pass event renders no pass
          switcher, and the pass name would otherwise appear nowhere on mobile. */}
      <div className="mb-4 flex items-start justify-between gap-4 border-b border-border/60 pb-4">
        <div className="min-w-0">
          <p className={TYPE.label}>Your pass</p>
          <p className="mt-1 text-fs-md font-bold leading-snug text-foreground">{passName}</p>
          {passAgeLabel && (
            <p className="mt-1 text-fs-2xs text-muted-foreground">
              Eligible age <span className="font-semibold text-foreground">{passAgeLabel}</span>
            </p>
          )}
        </div>
        <div className="shrink-0 text-right">
          {strikeLabel && <p className="text-fs-2xs text-muted-foreground line-through">{strikeLabel}</p>}
          <p className={cn('text-fs-lg font-bold tabular-nums', strikeLabel ? 'text-emerald-600' : 'text-foreground')}>
            {passPriceLabel}
          </p>
        </div>
      </div>

      <dl className="flex flex-col gap-2.5">
        {lines.map(l => (
          <div key={l.label} className="flex items-center justify-between gap-4 text-fs-sm">
            <dt className="text-muted-foreground">{l.label}</dt>
            <dd className="tabular-nums text-foreground">{fmtPaise(l.paise)}</dd>
          </div>
        ))}

        {discount && (
          <div className="flex items-center justify-between gap-4 text-fs-sm">
            <dt className="inline-flex min-w-0 items-center gap-1.5 text-emerald-700">
              Discount
              <span className="truncate rounded bg-emerald-100 px-1.5 py-0.5 font-mono text-fs-2xs font-bold">
                {discount.code}
              </span>
            </dt>
            <dd className="shrink-0 font-semibold tabular-nums text-emerald-700">{discount.label}</dd>
          </div>
        )}

        {/* Total — the strongest thing in the block. */}
        <div className="mt-2 flex items-baseline justify-between gap-4 border-t border-border pt-3.5">
          <dt className="text-fs-md font-bold text-foreground">
            {paymentRequired ? 'Total payable' : 'Total'}
          </dt>
          <dd className="text-fs-2xl font-extrabold leading-none tabular-nums tracking-tight text-foreground">
            {totalPaise === 0 ? 'Free' : fmtPaise(totalPaise)}
          </dd>
        </div>
      </dl>

      {/* Honest about provenance: any platform fees are itemised by the server, so this
          total is never presented as final before it is. */}
      {paymentRequired && !authoritative && (
        <p className="mt-3 text-fs-2xs text-muted-foreground">
          Any applicable fees are itemised before payment opens.
        </p>
      )}
    </CheckoutSection>
  )
}

// ─── 3 · Payment Summary MODAL ──────────────────────────────────────────────────
//
// RD-RT6.0. The old flow had ONE button that did two different things depending on
// invisible state: the first press created a Razorpay order and silently swapped the inline
// summary for an itemised one, and only a second press opened checkout. Attendees pressed
// once, saw the page change, and stopped — an order had been created and no payment made.
//
// The decision is now explicit and ordered. "Review & Pay" validates and opens THIS dialog,
// which creates nothing. Only "Proceed to Pay ₹X" — which names the exact amount and says
// where it goes — reaches the payment pipeline.
//
// It renders the existing shared Dialog (focus trap, Escape, backdrop, aria-modal, labelled
// title) rather than a new modal system, and its numbers come from the same canonical
// breakdown the server produced. Nothing here computes a fee.

export function PaymentSummaryDialog({
  open, onClose, onProceed, submitting,
  passName, lines, discount, totalPaise, paymentRequired, error,
}: {
  open:       boolean
  onClose:    () => void
  onProceed:  () => void
  /** The EXISTING payment submitting state — no second loading flag is introduced. */
  submitting: boolean
  passName:   string
  lines:      OrderLine[]
  discount:   { code: string; label: string } | null
  totalPaise: number
  /** False for free / fully-discounted → the CTA completes registration, never "Pay ₹0". */
  paymentRequired: boolean
  error?:     string | null
}) {
  const payLabel = paymentRequired
    ? `Proceed to Pay ${fmtPaise(totalPaise)}`
    : 'Complete Registration'

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Payment Summary"
      size="sm"
      // A stray backdrop tap must not discard a decision the attendee is in the middle of,
      // and must never interrupt an in-flight payment.
      closeOnBackdrop={false}
    >
      {/* max-h keeps a long breakdown inside a 375px viewport; the total + CTA live in the
          footer, OUTSIDE this scroller, so they can never be scrolled out of reach. */}
      <div className="max-h-[46vh] overflow-y-auto overscroll-contain">
        <p className={TYPE.label}>Your pass</p>
        <p className="mt-1 text-fs-md font-bold leading-snug text-foreground">{passName}</p>

        <dl className="mt-4 flex flex-col gap-2.5 border-t border-border/60 pt-4">
          {lines.map(l => (
            <div key={l.label} className="flex items-center justify-between gap-4 text-fs-sm">
              <dt className="min-w-0 text-muted-foreground">{l.label}</dt>
              <dd className="shrink-0 tabular-nums text-foreground">{fmtPaise(l.paise)}</dd>
            </div>
          ))}
          {discount && (
            <div className="flex items-center justify-between gap-4 text-fs-sm">
              <dt className="inline-flex min-w-0 items-center gap-1.5 text-emerald-700">
                Coupon discount
                <span className="truncate rounded bg-emerald-100 px-1.5 py-0.5 font-mono text-fs-2xs font-bold">
                  {discount.code}
                </span>
              </dt>
              <dd className="shrink-0 font-semibold tabular-nums text-emerald-700">{discount.label}</dd>
            </div>
          )}
        </dl>
      </div>

      {/* TOTAL — outside the scroller, so it is always visible. */}
      <div className="mt-4 flex items-baseline justify-between gap-4 border-t border-border pt-4">
        <span className="text-fs-2xs font-bold uppercase tracking-[0.1em] text-muted-foreground">
          {paymentRequired ? 'Total payable' : 'Total'}
        </span>
        <span className="text-fs-2xl font-extrabold leading-none tabular-nums tracking-tight text-foreground">
          {totalPaise === 0 ? 'Free' : fmtPaise(totalPaise)}
        </span>
      </div>

      {error && (
        <p role="alert" className="mt-3 rounded-lg border border-destructive/25 bg-destructive/[0.04] px-3 py-2 text-fs-xs leading-relaxed text-destructive">
          {error}
        </p>
      )}

      {/* Actions are in the body rather than Dialog's `footer` slot: the footer is a
          right-aligned row, and on a 375px screen the primary action needs the full width
          and to sit ABOVE the secondary one. */}
      <div className="mt-5 flex flex-col gap-2">
        <button
          type="button"
          onClick={onProceed}
          disabled={submitting}
          className={cn(buttonVariants({ variant: 'primary', size: 'lg' }), 'w-full gap-2')}
        >
          {submitting ? 'Processing…' : (
            <>
              {payLabel}
              <ArrowRight className="size-4 shrink-0" aria-hidden />
            </>
          )}
        </button>
        <button
          type="button"
          onClick={onClose}
          disabled={submitting}
          className={cn(buttonVariants({ variant: 'outline', size: 'lg' }), 'w-full')}
        >
          Go Back
        </button>
      </div>

      {paymentRequired && (
        <p className="mt-3 flex items-center justify-center gap-1.5 text-fs-2xs font-medium text-muted-foreground">
          <Lock className="size-3 shrink-0 text-emerald-600" aria-hidden />
          You will be taken to Razorpay to complete payment
        </p>
      )}
    </Dialog>
  )
}

// ─── 4 · Payment processing lock ────────────────────────────────────────────────
//
// RD-RT7.0. From the instant "Proceed to Pay" is pressed until the attempt resolves, the
// registration page must stop being an editable form. Nothing about the payment state
// machine changes — this renders the EXISTING `submitting` flag, which already spans
// exactly the right window:
//
//   finaliseRegistration / confirmAndPay / retryPayment set it true
//     → create-order → openRazorpayCheckout → handler → verify (+ its bounded retries)
//   …and their `finally` sets it false only once the attempt has reached one of its
//   terminal states (recovery card · unresolvedPayment · success redirect · released form).
//
// So there is no second flag, no competing machine, and no new place a duplicate order
// could originate: the guards that prevent one (`if (submitting) return`, the parked
// `unresolvedPayment`, and the server-side attempt claim) are untouched.
//
// ═══ IT MUST NOT FIGHT RAZORPAY ═══════════════════════════════════════════════
// Razorpay Checkout mounts its own container on document.body at a z-index in the
// billions. This sits at z-[400] — above the page, the sticky checkout bar (z-40) and the
// summary Dialog (z-300), and far below Razorpay. The attendee interacts with checkout
// completely normally; this is simply what is waiting underneath when it closes.
//
// NOT built on <Dialog>: that primitive renders a close button and an Escape handler, and
// a processing lock has no dismiss affordance to offer — an X that does nothing is worse
// than no X. It reuses the same primitives (portal, useFocusTrap, tokens) directly.

export function PaymentProcessingLock({ open, free = false }: {
  open:  boolean
  /** Free / fully-discounted registration — no money is moving, so the copy adapts. */
  free?: boolean
}) {
  // Traps Tab and restores focus to the trigger on unmount. With no focusable element
  // inside, useFocusTrap swallows Tab entirely — which is what "background is unreachable"
  // means for a surface that offers no controls.
  const ref = useFocusTrap<HTMLDivElement>(open)

  // Freeze background scrolling, compensating for the scrollbar so the page underneath
  // does not shift when it disappears.
  //
  // BOTH elements, deliberately: `overflow:hidden` on <body> alone does not stop the page
  // when <html> is the scrolling element, which it is here — measured against the emulator,
  // the page still scrolled with only the body rule applied.
  useEffect(() => {
    if (!open || typeof document === 'undefined') return
    const { body, documentElement: html } = document
    const prev = {
      bodyOverflow: body.style.overflow,
      bodyPadding:  body.style.paddingRight,
      htmlOverflow: html.style.overflow,
    }
    const gutter = window.innerWidth - html.clientWidth
    body.style.overflow = 'hidden'
    html.style.overflow = 'hidden'
    if (gutter > 0) body.style.paddingRight = `${gutter}px`
    return () => {
      body.style.overflow = prev.bodyOverflow
      body.style.paddingRight = prev.bodyPadding
      html.style.overflow = prev.htmlOverflow
    }
  }, [open])

  // Move focus onto the panel itself. The trap cannot do it (there is nothing focusable to
  // land on), and without this focus falls to <body> and the announcement is missed.
  useEffect(() => {
    if (!open) return
    const raf = requestAnimationFrame(() => ref.current?.focus())
    return () => cancelAnimationFrame(raf)
  }, [open, ref])

  if (!open || typeof document === 'undefined') return null

  const title = free ? 'Completing your registration' : 'Payment processing'
  const body  = free
    ? 'Please wait while we complete your registration.'
    : 'Please wait while we securely process your payment.'

  return createPortal(
    <div className="fixed inset-0 z-[400] flex items-center justify-center p-4">
      {/* Opaque enough that the form beneath reads as unavailable rather than merely dimmed,
          and it swallows every pointer event, so a stray tap cannot reach a field. */}
      <div className="absolute inset-0 bg-slate-950/55 backdrop-blur-[3px]" aria-hidden />

      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="rd-paylock-title"
        aria-describedby="rd-paylock-body"
        aria-busy="true"
        tabIndex={-1}
        className={cn(
          PANEL,
          // max-w-sm + w-full keeps it inside a 320px viewport with the p-4 gutter intact;
          // mb clears the iOS home indicator when the panel sits low on a short screen.
          'relative z-10 w-full max-w-sm px-6 py-7 text-center outline-none',
          'mb-[env(safe-area-inset-bottom)]',
        )}
      >
        <span
          aria-hidden
          className="mx-auto mb-4 flex size-12 items-center justify-center rounded-2xl bg-primary/10"
        >
          <span className="size-6 animate-spin rounded-full border-[2.5px] border-primary border-t-transparent motion-reduce:animate-none" />
        </span>

        <h2 id="rd-paylock-title" className="text-fs-lg font-bold tracking-tight text-foreground">
          {title}
        </h2>

        <p id="rd-paylock-body" className="mt-2 text-fs-sm leading-relaxed text-muted-foreground">
          {body}
        </p>

        {/* The one instruction that actually protects the payment. */}
        <p className="mt-4 rounded-xl border border-amber-300/70 bg-amber-50 px-3 py-2.5 text-fs-xs font-semibold text-amber-800">
          Do not close or refresh this page.
        </p>

        {!free && (
          <p className="mt-4 flex items-center justify-center gap-1.5 text-fs-2xs font-medium text-muted-foreground">
            <Lock className="size-3 shrink-0 text-emerald-600" aria-hidden />
            Secured by Razorpay
          </p>
        )}

        {/* Announced to assistive tech without stealing focus a second time. */}
        <span role="status" aria-live="polite" className="sr-only">
          {title}. {body} Do not close or refresh this page.
        </span>
      </div>
    </div>,
    document.body,
  )
}
