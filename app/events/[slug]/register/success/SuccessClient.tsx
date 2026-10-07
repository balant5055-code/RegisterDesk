'use client'

// Registration confirmation — compact, editorial.
//
// One composition instead of four stacked cards: a short hero (status, serif headline,
// one sentence), then the TICKET as the focal object on the left — event, pass, a ruled
// date/time/reference ledger, a perforated tear line, the QR beside its code — and
// everything you DO with it in a tight column on the right. Same props, same data, same
// behaviour as before (copy, share, calendar, downloads, focus-on-load); only the
// presentation changed. It speaks the event page's language: Fraunces display, bronze
// hairlines (--hero-accent-rule), the public --action accent.

import { useState, useEffect, useRef } from 'react'
import Link         from 'next/link'
import { motion, useReducedMotion, type Variants } from 'framer-motion'
import {
  Download, ExternalLink, Copy, Check, Mail, MapPin, Share2, Phone, Receipt, ArrowRight, Clock3, XCircle,
} from 'lucide-react'
import { cn }       from '@/lib/utils/cn'
import { marketingButton } from '@/lib/marketing/theme'
import { AddToCalendarButton } from '@/components/event-templates/shared/ui/AddToCalendarButton'

export interface CalendarData {
  startDate: string   // YYYY-MM-DD
  endDate:   string   // YYYY-MM-DD
  startTime: string   // HH:MM or ''
  endTime:   string   // HH:MM or ''
  location:  string
}

// ─── Props ────────────────────────────────────────────────────────────────────

export interface SuccessClientProps {
  registrationId: string
  ticketCode:     string
  eventName:      string
  passName:       string
  attendeeName:   string
  attendeeEmail:  string
  status:         string
  isPending:      boolean
  qrSvg:          string
  ticketPdfUrl:   string
  receiptUrl:     string | null
  eventSlug:      string
  calendarData?:  CalendarData
  // H-1 summary + H-5 action targets (all optional — hidden when absent)
  dateLabel?:       string | null
  timeLabel?:       string | null
  directionsUrl?:   string | null
  organizerEmail?:  string | null
  organizerPhone?:  string | null
  shareUrl?:        string
  // RD-RT3.4 — all optional, all hidden when absent.
  faqUrl?:            string | null
  paymentStatus?:     string | null
}

// ─── Shared styles ──────────────────────────────────────────────────────────────

const LABEL   = 'text-fs-2xs font-semibold uppercase tracking-[0.2em] text-hero-eyebrow'
const CARD    = 'rounded-xl border border-border/70 bg-card'
/** Secondary actions: one height, squarer corners, quiet until hovered. */
const ACTION  =
  'inline-flex h-10 w-full items-center justify-center gap-2 rounded-[var(--radius-control)] border border-border/70 bg-card px-3 ' +
  'text-fs-sm font-medium text-hero-ink transition-colors hover:border-border-strong hover:bg-surface-3/60 ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-action/50'

function Eyebrow({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <p className={cn(LABEL, 'flex items-center gap-2.5', className)}>
      <span aria-hidden className="h-px w-6 shrink-0 bg-hero-accent-rule" />
      {children}
    </p>
  )
}

// ─── Status mark (reduced-motion aware) ─────────────────────────────────────────

function StatusMark({ variant, reduce }: { variant: 'confirmed' | 'pending' | 'problem'; reduce: boolean }) {
  const tone = variant === 'confirmed'
    ? { ring: 'text-emerald-600', bg: 'bg-emerald-500/10', path: 'M14 27l8 8L38 18' }
    : variant === 'pending'
      ? { ring: 'text-amber-600', bg: 'bg-amber-500/10', path: 'M26 16v10l5 4' }
      : { ring: 'text-rose-600', bg: 'bg-rose-500/10', path: 'M19 19l14 14M33 19L19 33' }
  return (
    <span className={cn('relative inline-flex size-12 shrink-0 items-center justify-center rounded-full', tone.bg, tone.ring)}>
      <svg viewBox="0 0 52 52" className="size-7" fill="none" aria-hidden>
        <motion.circle
          cx="26" cy="26" r="24" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
          initial={reduce ? false : { pathLength: 0 }} animate={{ pathLength: 1 }}
          transition={{ duration: 0.55, ease: 'easeInOut' }}
        />
        <motion.path
          d={tone.path} stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"
          initial={reduce ? false : { pathLength: 0 }} animate={{ pathLength: 1 }}
          transition={{ duration: 0.4, delay: reduce ? 0 : 0.45, ease: 'easeInOut' }}
        />
      </svg>
    </span>
  )
}

// ─── Component ────────────────────────────────────────────────────────────────

export function SuccessClient(props: SuccessClientProps) {
  const {
    registrationId, ticketCode, eventName, passName, attendeeName, attendeeEmail,
    status, qrSvg, ticketPdfUrl, receiptUrl, eventSlug, calendarData,
    dateLabel, timeLabel,
    directionsUrl, organizerEmail, organizerPhone, shareUrl, faqUrl,
  } = props

  const reduce = useReducedMotion() ?? false
  const [copied, setCopied] = useState(false)
  const [shared, setShared] = useState(false)
  const headingRef = useRef<HTMLHeadingElement>(null)

  // M-1: move focus to the confirmation heading on load (keyboard/AT land at the top).
  useEffect(() => { headingRef.current?.focus() }, [])

  async function copyCode() {
    await navigator.clipboard.writeText(ticketCode).catch(() => null)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  async function shareEvent() {
    const url = shareUrl ?? (typeof window !== 'undefined' ? `${window.location.origin}/events/${eventSlug}` : '')
    const nav = typeof navigator !== 'undefined' ? navigator : undefined
    if (nav?.share) {
      await nav.share({ title: eventName, text: `Check out ${eventName}`, url }).catch(() => null)
    } else if (nav?.clipboard) {
      await nav.clipboard.writeText(url).catch(() => null)
      setShared(true)
      setTimeout(() => setShared(false), 2000)
    }
  }

  // H-2: exactly one presentation per status.
  const variant: 'confirmed' | 'pending' | 'problem' =
    status === 'confirmed' ? 'confirmed'
      : status === 'pending' || status === 'waitlisted' ? 'pending'
        : 'problem'

  const problem = status === 'rejected'
    ? { title: 'Registration not approved', sub: 'Unfortunately your registration for this event was not approved. Please contact the event organiser if you have any questions.' }
    : { title: 'Registration cancelled',    sub: 'This registration has been cancelled and its ticket is no longer valid for entry. Contact the event organiser if this is unexpected.' }

  const firstName = attendeeName?.trim().split(/\s+/)[0] ?? ''
  const headline = variant === 'pending'
    ? 'Registration received'
    : variant === 'problem'
      ? problem.title
      : firstName ? `You're all set, ${firstName}.` : "You're all set."
  const subhead = variant === 'pending'
    ? `Your registration for ${eventName} is pending review. We'll email ${attendeeEmail} once it's confirmed.`
    : variant === 'problem'
      ? problem.sub
      : `Your place at ${eventName} is confirmed. A copy of your ticket has been sent to ${attendeeEmail}.`

  const pill = variant === 'confirmed'
    ? { text: 'Confirmed', cls: 'border-emerald-500/30 bg-emerald-500/[0.08] text-emerald-700', dot: 'bg-emerald-500' }
    : variant === 'pending'
      ? { text: 'Pending review', cls: 'border-amber-500/30 bg-amber-500/[0.08] text-amber-700', dot: 'bg-amber-500' }
      : { text: status === 'rejected' ? 'Not approved' : 'Cancelled', cls: 'border-rose-500/30 bg-rose-500/[0.08] text-rose-700', dot: 'bg-rose-500' }

  const item: Variants = {
    hidden:  { opacity: reduce ? 1 : 0, y: reduce ? 0 : 14 },
    visible: { opacity: 1, y: 0, transition: { duration: 0.36, ease: 'easeOut' } },
  }
  const contactHref = organizerEmail ? `mailto:${organizerEmail}` : organizerPhone ? `tel:${organizerPhone}` : null

  // RD-RT3.4 — "what happens next", built ONLY from things that actually happen on this
  // route. Race-kit collection, results and certificates are deliberately absent: no
  // data for them reaches this page, and a step that may never occur is worse than none.
  const nextSteps: { key: string; title: string; detail?: string; done: boolean }[] =
    variant === 'problem' ? [] : variant === 'pending' ? [
      { key: 'received', title: 'Registration received', detail: `Reference ${ticketCode}`, done: true },
      { key: 'review',   title: 'Organiser review',      detail: 'The organiser will review your registration.', done: false },
      { key: 'email',    title: 'Confirmation email',    detail: `Sent to ${attendeeEmail} once approved.`, done: false },
      ...(dateLabel ? [{ key: 'event', title: 'Event day', detail: dateLabel, done: false }] : []),
    ] : [
      { key: 'done',   title: 'Registration confirmed', detail: `Reference ${ticketCode}`, done: true },
      { key: 'email',  title: 'Confirmation email sent', detail: attendeeEmail, done: true },
      { key: 'ticket', title: 'QR ticket ready',        detail: 'Show it at entry.', done: true },
      ...(dateLabel ? [{ key: 'event', title: 'Event day', detail: [dateLabel, timeLabel].filter(Boolean).join(' · '), done: false }] : []),
    ]

  const ledger = [
    dateLabel && { label: 'Date', value: dateLabel },
    timeLabel && { label: 'Time', value: timeLabel },
    { label: 'Reference', value: ticketCode, mono: true },
  ].filter(Boolean) as { label: string; value: string; mono?: boolean }[]

  // ── Next steps (rendered in the ticket column when there is no ticket) ──
  const stepsBlock = nextSteps.length > 0 && (
    <motion.section variants={item} aria-labelledby="rd-next-h">
      <h2 id="rd-next-h" className={cn(LABEL, 'mb-3')}>What happens next</h2>
      <ol className="space-y-3">
        {nextSteps.map((step, i) => (
          <li key={step.key} className="relative flex gap-3">
            {i < nextSteps.length - 1 && (
              <span aria-hidden className="absolute -bottom-3 left-[9px] top-5 w-px bg-border" />
            )}
            <span
              aria-hidden
              className={cn(
                'relative z-10 mt-0.5 flex size-[18px] shrink-0 items-center justify-center rounded-full',
                step.done ? 'bg-emerald-600 text-white' : 'border-2 border-border bg-card',
              )}
            >
              {step.done && <Check className="size-2.5" strokeWidth={3.5} />}
            </span>
            <div className="min-w-0 flex-1">
              <p className={cn('text-fs-sm font-medium leading-snug', step.done ? 'text-hero-ink' : 'text-hero-ink-soft')}>{step.title}</p>
              {step.detail && <p className="mt-0.5 break-words text-fs-xs text-hero-ink-soft">{step.detail}</p>}
            </div>
            <span className="sr-only">{step.done ? 'Completed' : 'Upcoming'}</span>
          </li>
        ))}
      </ol>
    </motion.section>
  )

  return (
    <motion.div
      className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6 lg:px-8 lg:py-12"
      initial={reduce ? 'visible' : 'hidden'}
      animate="visible"
      variants={{ hidden: {}, visible: { transition: { staggerChildren: reduce ? 0 : 0.07 } } }}
    >
      {/* ── Hero ─────────────────────────────────────────────────────────────── */}
      <motion.header variants={item} className="flex items-start gap-4 sm:gap-5" role="status" aria-live="polite">
        <StatusMark variant={variant} reduce={reduce} />
        <div className="min-w-0">
          <span className={cn('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-fs-2xs font-semibold uppercase tracking-[0.12em]', pill.cls)}>
            <span aria-hidden className={cn('size-1.5 rounded-full', pill.dot)} />
            {pill.text}
          </span>
          <h1
            ref={headingRef}
            tabIndex={-1}
            className="mt-2.5 text-balance font-display text-fs-display-sm font-light tracking-[-0.015em] text-hero-ink outline-none leading-[1.1]"
          >
            {headline}
          </h1>
          <p className="mt-2 max-w-2xl text-fs-base leading-relaxed text-hero-ink-soft">{subhead}</p>
        </div>
      </motion.header>

      <div className="mt-8 grid grid-cols-1 items-start gap-6 lg:mt-10 lg:grid-cols-12 lg:gap-8">

        {/* ── The ticket ─────────────────────────────────────────────────────── */}
        <div className="lg:col-span-7">
          {variant === 'confirmed' ? (
            <motion.section variants={item} aria-labelledby="rd-ticket-h" className={cn(CARD, 'relative shadow-[0_1px_2px_rgb(15_23_42_/_0.04),0_24px_48px_-32px_rgb(15_23_42_/_0.35)]')}>
              {/* Identity */}
              <div className="px-5 pt-5 sm:px-7 sm:pt-6">
                <Eyebrow>Admit one</Eyebrow>
                <h2 id="rd-ticket-h" className="mt-2.5 text-balance font-display text-fs-xl text-hero-ink leading-snug sm:text-fs-2xl">
                  {eventName}
                </h2>
                <p className="mt-1 text-fs-sm text-hero-ink-soft">{passName}</p>

                {/* Phones: label/value rows, so nothing truncates. From sm: the ruled three-column ledger. */}
                <dl className={cn('mt-5 grid grid-cols-1 divide-y divide-border/60 border-y border-border/60 sm:divide-x sm:divide-y-0', ledger.length === 3 ? 'sm:grid-cols-3' : 'sm:grid-cols-2')}>
                  {ledger.map(row => (
                    <div key={row.label} className="flex min-w-0 items-baseline justify-between gap-4 py-2.5 sm:block sm:py-3.5 sm:pl-4 sm:first:pl-0">
                      <dt className={LABEL}>{row.label}</dt>
                      <dd className={cn('text-right text-fs-sm text-hero-ink sm:mt-1.5 sm:truncate sm:text-left', row.mono ? 'font-mono font-semibold tracking-wider' : 'font-medium')}>
                        {row.value}
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>

              {/* Tear line — half-disc notches stay INSIDE the card edge (no blister on the shadow). */}
              <div className="relative my-5" aria-hidden>
                <span className="absolute -left-px top-1/2 h-5 w-2.5 -translate-y-1/2 rounded-r-full border-y border-r border-border/70 bg-background" />
                <span className="absolute -right-px top-1/2 h-5 w-2.5 -translate-y-1/2 rounded-l-full border-y border-l border-border/70 bg-background" />
                <div className="mx-5 border-t border-dashed border-border sm:mx-7" />
              </div>

              {/* Stub: QR + code */}
              <div className="flex flex-col items-center gap-5 px-5 pb-5 sm:flex-row sm:items-center sm:gap-7 sm:px-7 sm:pb-6">
                <div
                  className="size-40 shrink-0 overflow-hidden rounded-lg border border-border/70 bg-white p-2 [&>svg]:size-full"
                  dangerouslySetInnerHTML={{ __html: qrSvg }}
                  role="img"
                  aria-label={`QR code for ticket ${ticketCode}`}
                />
                <div className="w-full min-w-0 text-center sm:text-left">
                  <p className={LABEL}>Scan to check in</p>
                  <div className="mt-2 flex items-center justify-center gap-2 sm:justify-start">
                    <p className="font-mono text-fs-xl font-semibold tracking-[0.16em] text-hero-ink">{ticketCode}</p>
                    <button
                      type="button"
                      onClick={() => void copyCode()}
                      className="inline-flex size-8 shrink-0 items-center justify-center rounded-[var(--radius-control)] border border-border/70 text-hero-ink-soft transition-colors hover:bg-surface-3/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-action/50"
                      aria-label="Copy ticket code"
                    >
                      {copied ? <Check className="size-3.5 text-emerald-600" /> : <Copy className="size-3.5" />}
                    </button>
                  </div>
                  <p className="mt-2 text-fs-xs text-hero-ink-soft">Show this QR at the entrance. It works offline once downloaded.</p>
                  <Link
                    href={`/tickets/${registrationId}?success=1`}
                    className="mt-3 inline-flex items-center gap-1.5 text-fs-sm font-medium text-action underline-offset-4 hover:underline"
                  >
                    View full ticket
                    <ArrowRight className="size-3.5" aria-hidden />
                  </Link>
                </div>
              </div>
            </motion.section>
          ) : (
            <motion.div variants={item} className={cn(CARD, 'p-5 sm:p-7')}>
              {variant === 'problem' ? (
                <div className="flex items-start gap-3">
                  <XCircle className="mt-0.5 size-5 shrink-0 text-rose-600" aria-hidden />
                  <div>
                    <p className="font-display text-fs-lg text-hero-ink">{eventName}</p>
                    <p className="mt-1 text-fs-sm text-hero-ink-soft">{passName} · Reference <span className="font-mono">{ticketCode}</span></p>
                  </div>
                </div>
              ) : (
                <>
                  <div className="mb-5 flex items-start gap-3 border-b border-border/60 pb-5">
                    <Clock3 className="mt-0.5 size-5 shrink-0 text-amber-600" aria-hidden />
                    <div>
                      <p className="font-display text-fs-lg text-hero-ink">{eventName}</p>
                      <p className="mt-1 text-fs-sm text-hero-ink-soft">{passName}</p>
                    </div>
                  </div>
                  {stepsBlock}
                </>
              )}
            </motion.div>
          )}
        </div>

        {/* ── What you do with it ────────────────────────────────────────────── */}
        <div className="space-y-6 lg:sticky lg:top-24 lg:col-span-5">
          <motion.section variants={item} aria-label="Actions" className="space-y-2.5">
            {variant === 'confirmed' && (
              <a
                href={ticketPdfUrl}
                target="_blank"
                rel="noopener noreferrer"
                className={cn(marketingButton({ emphasis: 'gradient', variant: 'primary', size: 'lg' }), 'h-11 w-full gap-2 rounded-[var(--radius-control)]')}
              >
                <Download className="size-4" aria-hidden />
                Download ticket (PDF)
              </a>
            )}

            <div className="grid grid-cols-2 gap-2.5">
              {variant === 'confirmed' && calendarData?.startDate && (
                <AddToCalendarButton
                  title={eventName}
                  startDate={calendarData.startDate}
                  endDate={calendarData.endDate}
                  startTime={calendarData.startTime}
                  endTime={calendarData.endTime}
                  location={calendarData.location}
                  description={`You're registered for ${eventName}. View your ticket at ${typeof window !== 'undefined' ? window.location.origin : ''}/tickets/${registrationId}`}
                  slug={eventSlug}
                  label="Calendar"
                  className={ACTION}
                />
              )}
              {directionsUrl && variant !== 'problem' && (
                <a href={directionsUrl} target="_blank" rel="noopener noreferrer" className={ACTION}>
                  <MapPin className="size-4 text-hero-accent-rule" aria-hidden />
                  Directions
                </a>
              )}
              <button type="button" onClick={() => void shareEvent()} className={ACTION}>
                <Share2 className="size-4 text-hero-accent-rule" aria-hidden />
                {shared ? 'Link copied' : 'Share'}
              </button>
              {variant === 'confirmed' && receiptUrl && (
                <a href={receiptUrl} target="_blank" rel="noopener noreferrer" className={ACTION}>
                  <Receipt className="size-4 text-hero-accent-rule" aria-hidden />
                  Receipt
                </a>
              )}
              {contactHref && (
                <a href={contactHref} className={ACTION}>
                  {organizerEmail ? <Mail className="size-4 text-hero-accent-rule" aria-hidden /> : <Phone className="size-4 text-hero-accent-rule" aria-hidden />}
                  Organizer
                </a>
              )}
              <Link href={`/events/${eventSlug}`} className={ACTION}>
                <ExternalLink className="size-4 text-hero-accent-rule" aria-hidden />
                Event page
              </Link>
            </div>
          </motion.section>

          {variant === 'confirmed' && (
            <div className={cn(CARD, 'p-5')}>{stepsBlock}</div>
          )}

          {/* Need help — only when the organiser published a channel. */}
          {(organizerEmail || organizerPhone || faqUrl) && (
            <motion.section variants={item} aria-labelledby="rd-help-h" className="border-t border-border/60 pt-5">
              <h2 id="rd-help-h" className={LABEL}>Need help?</h2>
              <div className="mt-2.5 flex flex-wrap gap-x-5 gap-y-2 text-fs-xs">
                {organizerEmail && (
                  <a href={`mailto:${organizerEmail}`} className="inline-flex items-center gap-1.5 text-hero-ink hover:text-action">
                    <Mail className="size-3.5 shrink-0 text-hero-accent-rule" aria-hidden />{organizerEmail}
                  </a>
                )}
                {organizerPhone && (
                  <a href={`tel:${organizerPhone}`} className="inline-flex items-center gap-1.5 text-hero-ink hover:text-action">
                    <Phone className="size-3.5 shrink-0 text-hero-accent-rule" aria-hidden />{organizerPhone}
                  </a>
                )}
                {faqUrl && (
                  <a href={faqUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-hero-ink hover:text-action">
                    <ExternalLink className="size-3.5 shrink-0 text-hero-accent-rule" aria-hidden />FAQ
                  </a>
                )}
              </div>
            </motion.section>
          )}

          <p className="font-mono text-fs-2xs uppercase tracking-wider text-hero-ink-soft/70">
            <span className="sr-only">Registration ID: </span>ID {registrationId}
          </p>
        </div>
      </div>
    </motion.div>
  )
}
