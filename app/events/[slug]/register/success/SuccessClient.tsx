'use client'

import { useState, useEffect, useRef } from 'react'
import Link         from 'next/link'
import { motion, useReducedMotion, type Variants } from 'framer-motion'
import { Download, ExternalLink, Copy, Check, Mail, Ticket, MapPin, Share2, Phone } from 'lucide-react'
import { cn }       from '@/lib/utils/cn'
import { AddToCalendarButton } from '@/components/event-templates/shared/ui/AddToCalendarButton'

export interface CalendarData {
  startDate: string   // YYYY-MM-DD
  endDate:   string   // YYYY-MM-DD
  startTime: string   // HH:MM or ''
  endTime:   string   // HH:MM or ''
  location:  string
}

// ─── Animated Icons (reduced-motion aware) ──────────────────────────────────────

function StatusIcon({ variant, reduce }: { variant: 'confirmed' | 'pending' | 'problem'; reduce: boolean }) {
  const stroke = variant === 'confirmed' ? '#059669' : variant === 'pending' ? '#d97706' : '#e11d48'
  const bg     = variant === 'confirmed' ? 'bg-emerald-100' : variant === 'pending' ? 'bg-amber-100' : 'bg-rose-100'
  const path   = variant === 'confirmed' ? 'M14 27l8 8L38 18' : variant === 'pending' ? 'M26 16v10l5 4' : 'M19 19l14 14M33 19L19 33'
  return (
    <div className="relative flex size-24 items-center justify-center">
      <motion.div
        className={cn('absolute inset-0 rounded-full', bg)}
        initial={reduce ? false : { scale: 0, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ duration: 0.4, ease: [0.34, 1.56, 0.64, 1] }}
      />
      <svg viewBox="0 0 52 52" className="relative size-11" fill="none" aria-hidden>
        <motion.circle
          cx="26" cy="26" r="24" stroke={stroke} strokeWidth="2" strokeLinecap="round"
          initial={reduce ? false : { pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ duration: 0.55, ease: 'easeInOut' }}
        />
        <motion.path
          d={path} stroke={stroke} strokeWidth="2.75" strokeLinecap="round" strokeLinejoin="round"
          initial={reduce ? false : { pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ duration: 0.4, delay: reduce ? 0 : 0.45, ease: 'easeInOut' }}
        />
      </svg>
    </div>
  )
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
  // RD-PAYMENT-05 B1: canonical fee breakdown (attendee_pays only; null otherwise).
  // RD-RT3.4 — all optional, all hidden when absent.
  faqUrl?:            string | null
  paymentStatus?:     string | null
}

// ─── Small building blocks ──────────────────────────────────────────────────────


const primaryAction   = 'flex items-center justify-center gap-2 rounded-xl bg-primary px-4 py-3 text-fs-base font-semibold text-primary-foreground shadow-sm transition-opacity hover:opacity-90'
const secondaryAction = 'flex items-center justify-center gap-2 rounded-xl border border-border bg-card px-3 py-2.5 text-fs-sm font-semibold text-foreground transition-colors hover:bg-muted/60'
const helpLink        = 'inline-flex items-center gap-1.5 rounded text-fs-xs font-semibold text-foreground underline-offset-2 outline-none transition-colors hover:text-primary hover:underline focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-offset-2'
const sectionLabel    = 'mb-2 text-fs-2xs font-semibold uppercase tracking-wider text-muted-foreground'

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

  const headline = variant === 'pending' ? 'Registration Received' : variant === 'problem' ? problem.title : "You're all set!"
  const subhead  = variant === 'pending'
    ? "Your registration is pending review. We'll email you once it's confirmed."
    : variant === 'problem' ? problem.sub : `Welcome, ${attendeeName}. Your registration is confirmed.`
  const headingColor = variant === 'pending' ? 'text-amber-700' : variant === 'problem' ? 'text-rose-700' : 'text-foreground'

  const item: Variants = {
    hidden:  { opacity: reduce ? 1 : 0, y: reduce ? 0 : 18 },
    visible: { opacity: 1, y: 0, transition: { duration: 0.38, ease: 'easeOut' } },
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
      { key: 'ticket', title: 'QR ticket ready',        detail: 'Show it at entry — download it below.', done: true },
      ...(dateLabel ? [{ key: 'event', title: 'Event day', detail: [dateLabel, timeLabel].filter(Boolean).join(' · '), done: false }] : []),
    ]

  return (
    <motion.div
      className="mx-auto w-full max-w-5xl px-4 py-10 sm:px-6 lg:px-8 lg:py-14"
      initial={reduce ? 'visible' : 'hidden'}
      animate="visible"
      variants={{ hidden: {}, visible: { transition: { staggerChildren: reduce ? 0 : 0.08 } } }}
    >
      {/* ── Success ─────────────────────────────────────────────────────────── */}
      <motion.div variants={item} className="mb-7 text-center" role="status" aria-live="polite">
        <div className="mb-5 flex justify-center">
          <StatusIcon variant={variant} reduce={reduce} />
        </div>
        <h1
          ref={headingRef}
          tabIndex={-1}
          className={cn('text-fs-2xl font-bold tracking-tight outline-none', headingColor)}
        >
          {headline}
        </h1>
        <p className="mt-2 text-fs-base leading-relaxed text-muted-foreground">{subhead}</p>

        {/* RD-RT3.4: what you registered for, stated in the header rather than only in
            the table below — the first question after "did it work?". */}
        <p className="mt-3 text-fs-md font-bold text-foreground">{eventName}</p>
        <p className="mt-0.5 text-fs-sm text-muted-foreground">{passName}</p>
        <p className="mt-2 font-mono text-fs-2xs uppercase tracking-wider text-muted-foreground">
          <span className="sr-only">Registration ID: </span>{registrationId}
        </p>
      </motion.div>

      {/*
        COMPOSITION — the hero keeps the full measure and stays the focal point. Below it,
        progress sits in a narrow sticky rail and the ticket (the actionable object) takes
        the wider column with its actions directly beneath it. Sticky is on the SHORT side
        deliberately: a sticky column taller than the viewport cannot scroll to its end.
        One column on mobile, in reading order.
      */}
      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-12 lg:gap-8">
        <div className="space-y-6 lg:sticky lg:top-24 lg:col-span-5">

      {/* ── What happens next ───────────────────────────────────────────────── */}
      {nextSteps.length > 0 && (
        <motion.section variants={item} aria-labelledby="rd-next-h">
          <h2 id="rd-next-h" className={sectionLabel}>What happens next</h2>
          <ol className="overflow-hidden rounded-2xl border border-border bg-card px-5 py-4 shadow-sm">
            {nextSteps.map((step, i) => (
              <li key={step.key} className="relative flex gap-3 pb-4 last:pb-0">
                {/* Rail — drawn between markers, never after the last one. */}
                {i < nextSteps.length - 1 && (
                  <span aria-hidden className="absolute bottom-0 left-[11px] top-6 w-px bg-border" />
                )}
                <span
                  aria-hidden
                  className={cn(
                    "relative z-10 mt-0.5 flex size-[22px] shrink-0 items-center justify-center rounded-full",
                    step.done ? "bg-emerald-600 text-white" : "border-2 border-border bg-card",
                  )}
                >
                  {step.done && <Check className="size-3" strokeWidth={3} />}
                </span>
                <div className="min-w-0 flex-1">
                  <p className={cn("text-fs-sm font-semibold", step.done ? "text-foreground" : "text-muted-foreground")}>
                    {step.title}
                  </p>
                  {step.detail && <p className="mt-0.5 break-words text-fs-xs text-muted-foreground">{step.detail}</p>}
                </div>
                <span className="sr-only">{step.done ? "Completed" : "Upcoming"}</span>
              </li>
            ))}
          </ol>
        </motion.section>
      )}

        </div>

        {/* The ticket and everything you do with it. */}
        <div className="space-y-6 lg:col-span-7">

      {/* ── Your ticket (confirmed only) ────────────────────────────────────── */}
      {variant === 'confirmed' && (
        <motion.section variants={item} aria-labelledby="rd-ticket-h">
          <h2 id="rd-ticket-h" className={sectionLabel}>Your ticket</h2>
          <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
            <div className="flex flex-col items-center border-b border-border px-6 py-6">
              <p className="mb-4 text-fs-2xs font-semibold uppercase tracking-widest text-muted-foreground">Scan to check in</p>
              <div
                className="overflow-hidden rounded-xl border border-border bg-white p-2"
                dangerouslySetInnerHTML={{ __html: qrSvg }}
                role="img"
                aria-label={`QR code for ticket ${ticketCode}`}
              />
            </div>
            <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-4">
              <div className="min-w-0">
                <p className="mb-1 text-fs-2xs font-semibold uppercase tracking-widest text-muted-foreground">Ticket code</p>
                <p className="font-mono text-fs-lg font-bold tracking-[0.14em] text-foreground">{ticketCode}</p>
              </div>
              <button
                type="button"
                onClick={() => void copyCode()}
                className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-card transition-colors hover:bg-muted"
                aria-label="Copy ticket code"
              >
                {copied ? <Check className="size-3.5 text-emerald-600" /> : <Copy className="size-3.5 text-muted-foreground" />}
              </button>
            </div>
            <Link
              href={`/tickets/${registrationId}?success=1`}
              className="flex items-center justify-center gap-1.5 px-5 py-3 text-fs-xs font-medium text-primary transition-colors hover:bg-muted/50"
            >
              <Ticket className="size-3.5" aria-hidden />
              View full ticket
              <ExternalLink className="size-3" aria-hidden />
            </Link>
          </div>
        </motion.section>
      )}

      {/* ── Quick actions ───────────────────────────────────────────────────── */}
      <motion.section variants={item} aria-labelledby="rd-actions-h">
        <h2 id="rd-actions-h" className={sectionLabel}>Quick actions</h2>
        <div className="flex flex-col gap-2.5">
          {/* Primary */}
          {variant === 'confirmed' && (
            <a href={ticketPdfUrl} target="_blank" rel="noopener noreferrer" className={primaryAction}>
              <Download className="size-4" aria-hidden />
              Download Ticket
            </a>
          )}
          {variant === 'confirmed' && calendarData?.startDate && (
            <div className="flex items-center justify-center rounded-xl border border-border bg-card px-4 py-2.5">
              <AddToCalendarButton
                title={eventName}
                startDate={calendarData.startDate}
                endDate={calendarData.endDate}
                startTime={calendarData.startTime}
                endTime={calendarData.endTime}
                location={calendarData.location}
                description={`You're registered for ${eventName}. View your ticket at ${typeof window !== 'undefined' ? window.location.origin : ''}/tickets/${registrationId}`}
                slug={eventSlug}
              />
            </div>
          )}

          {/* Secondary */}
          <div className="grid grid-cols-2 gap-2.5">
            {directionsUrl && variant !== 'problem' && (
              <a href={directionsUrl} target="_blank" rel="noopener noreferrer" className={secondaryAction}>
                <MapPin className="size-4 text-muted-foreground" aria-hidden />
                Get Directions
              </a>
            )}
            {contactHref && (
              <a href={contactHref} className={secondaryAction}>
                {organizerEmail ? <Mail className="size-4 text-muted-foreground" aria-hidden /> : <Phone className="size-4 text-muted-foreground" aria-hidden />}
                Contact Organizer
              </a>
            )}
            <button type="button" onClick={() => void shareEvent()} className={secondaryAction}>
              <Share2 className="size-4 text-muted-foreground" aria-hidden />
              {shared ? 'Link copied!' : 'Share Event'}
            </button>
            {variant === 'confirmed' && receiptUrl && (
              <a href={receiptUrl} target="_blank" rel="noopener noreferrer" className={secondaryAction}>
                <Download className="size-4 text-muted-foreground" aria-hidden />
                Download Receipt
              </a>
            )}
          </div>

          {/* Tertiary */}
          <Link href={`/events/${eventSlug}`} className={cn(secondaryAction, 'w-full')}>
            <ExternalLink className="size-4 text-muted-foreground" aria-hidden />
            View Event Page
          </Link>
        </div>
      </motion.section>

      {/* ── Need help? — rendered only when the organiser published a channel. ── */}
      {(organizerEmail || organizerPhone || faqUrl) && (
        <motion.section variants={item} aria-labelledby="rd-help-h">
          <h2 id="rd-help-h" className={sectionLabel}>Need help?</h2>
          <div className="rounded-2xl border border-border bg-card px-5 py-4 shadow-sm">
            <p className="text-fs-xs text-muted-foreground">
              Questions about your registration? The event organiser can help.
            </p>
            <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2">
              {organizerEmail && (
                <a href={`mailto:${organizerEmail}`} className={helpLink}>
                  <Mail className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                  {organizerEmail}
                </a>
              )}
              {organizerPhone && (
                <a href={`tel:${organizerPhone}`} className={helpLink}>
                  <Phone className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                  {organizerPhone}
                </a>
              )}
              {faqUrl && (
                <a href={faqUrl} target="_blank" rel="noopener noreferrer" className={helpLink}>
                  <ExternalLink className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                  Frequently asked questions
                </a>
              )}
            </div>
          </div>
        </motion.section>
      )}
        </div>
      </div>
    </motion.div>
  )
}
