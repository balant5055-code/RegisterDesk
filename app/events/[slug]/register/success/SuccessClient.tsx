'use client'

import { useState, useEffect, useRef } from 'react'
import Link         from 'next/link'
import { motion, useReducedMotion, type Variants } from 'framer-motion'
import { Download, ExternalLink, Copy, Check, Mail, Ticket, MapPin, Share2, Phone } from 'lucide-react'
import { cn }       from '@/lib/utils/cn'
import { AddToCalendarButton } from '@/components/event-templates/shared/ui/AddToCalendarButton'
import { formatPaise, type AttendeeFeeBreakdown } from '@/lib/fees/attendeeBreakdown'

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
  amountLabel?:     string | null
  dateLabel?:       string | null
  timeLabel?:       string | null
  venueLabel?:      string | null
  eventTypeLabel?:  string | null
  directionsUrl?:   string | null
  organizerEmail?:  string | null
  organizerPhone?:  string | null
  shareUrl?:        string
  // RD-PAYMENT-05 B1: canonical fee breakdown (attendee_pays only; null otherwise).
  feeBreakdown?:    AttendeeFeeBreakdown | null
}

// ─── Small building blocks ──────────────────────────────────────────────────────

function SummaryField({ label, value, full, mono }: { label: string; value: string; full?: boolean; mono?: boolean }) {
  return (
    <div className={full ? 'col-span-2' : ''}>
      <dt className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</dt>
      <dd className={cn('mt-0.5 text-[13px] font-medium text-foreground', mono ? 'break-all font-mono text-[11px]' : 'line-clamp-2')}>
        {value}
      </dd>
    </div>
  )
}

const primaryAction   = 'flex items-center justify-center gap-2 rounded-xl bg-primary px-4 py-3 text-[14px] font-semibold text-primary-foreground shadow-sm transition-opacity hover:opacity-90'
const secondaryAction = 'flex items-center justify-center gap-2 rounded-xl border border-border bg-card px-3 py-2.5 text-[13px] font-semibold text-foreground transition-colors hover:bg-muted/60'
const sectionLabel    = 'mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground'

// ─── Component ────────────────────────────────────────────────────────────────

export function SuccessClient(props: SuccessClientProps) {
  const {
    registrationId, ticketCode, eventName, passName, attendeeName, attendeeEmail,
    status, qrSvg, ticketPdfUrl, receiptUrl, eventSlug, calendarData,
    amountLabel, dateLabel, timeLabel, venueLabel, eventTypeLabel,
    directionsUrl, organizerEmail, organizerPhone, shareUrl, feeBreakdown,
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
  const statusLabel  = variant === 'confirmed' ? 'Confirmed'
    : variant === 'pending' ? (status === 'waitlisted' ? 'Waitlisted' : 'Pending review')
      : (status === 'rejected' ? 'Not approved' : 'Cancelled')
  const statusDot  = variant === 'confirmed' ? 'bg-emerald-500' : variant === 'pending' ? 'bg-amber-500' : 'bg-rose-500'
  const statusText = variant === 'confirmed' ? 'text-emerald-700' : variant === 'pending' ? 'text-amber-700' : 'text-rose-700'

  const item: Variants = {
    hidden:  { opacity: reduce ? 1 : 0, y: reduce ? 0 : 18 },
    visible: { opacity: 1, y: 0, transition: { duration: 0.38, ease: 'easeOut' } },
  }
  const contactHref = organizerEmail ? `mailto:${organizerEmail}` : organizerPhone ? `tel:${organizerPhone}` : null

  return (
    <motion.main
      className="mx-auto max-w-md px-4 py-10"
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
          className={cn('text-[26px] font-bold tracking-tight outline-none', headingColor)}
        >
          {headline}
        </h1>
        <p className="mt-2 text-[14px] leading-relaxed text-muted-foreground">{subhead}</p>
      </motion.div>

      {/* ── Registration summary (above the fold) ───────────────────────────── */}
      <motion.section variants={item} aria-labelledby="rd-summary-h" className="mb-6">
        <h2 id="rd-summary-h" className={sectionLabel}>Registration summary</h2>
        <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
          <div className="flex items-center gap-1.5 border-b border-border px-5 py-3">
            <span className={cn('size-1.5 rounded-full', statusDot)} aria-hidden />
            <span className={cn('text-[12px] font-semibold', statusText)}>{statusLabel}</span>
          </div>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3.5 px-5 py-4">
            <SummaryField label="Event" value={eventName} full />
            {dateLabel && <SummaryField label="Date" value={dateLabel} />}
            {timeLabel && <SummaryField label="Time" value={timeLabel} />}
            {venueLabel && <SummaryField label="Venue" value={venueLabel} full />}
            <SummaryField label="Pass" value={passName} />
            {eventTypeLabel && <SummaryField label="Type" value={eventTypeLabel} />}
            <SummaryField label="Amount paid" value={amountLabel ?? 'Free'} />
            <SummaryField label="Registration ID" value={registrationId} mono full />
          </dl>
          {/* RD-PAYMENT-05 B1: itemized fee breakdown (attendee_pays) from canonical stored
              financials — the same lines shown at checkout. Total === Amount paid above. */}
          {feeBreakdown && (
            <dl className="space-y-1.5 border-t border-border bg-muted/20 px-5 py-4">
              {feeBreakdown.lines.map(l => (
                <div key={l.label} className="flex items-center justify-between text-[12.5px]">
                  <dt className="text-muted-foreground">{l.label}</dt>
                  <dd className="tabular-nums text-foreground">{formatPaise(l.paise)}</dd>
                </div>
              ))}
              <div className="flex items-center justify-between border-t border-border pt-2 text-[13px] font-semibold">
                <dt className="text-foreground">Total paid</dt>
                <dd className="tabular-nums text-foreground">{formatPaise(feeBreakdown.totalPaise)}</dd>
              </div>
            </dl>
          )}
        </div>
      </motion.section>

      {/* ── Your ticket (confirmed only) ────────────────────────────────────── */}
      {variant === 'confirmed' && (
        <motion.section variants={item} aria-labelledby="rd-ticket-h" className="mb-6">
          <h2 id="rd-ticket-h" className={sectionLabel}>Your ticket</h2>
          <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
            <div className="flex flex-col items-center border-b border-border px-6 py-6">
              <p className="mb-4 text-[10.5px] font-semibold uppercase tracking-widest text-muted-foreground">Scan to check in</p>
              <div
                className="overflow-hidden rounded-xl border border-border bg-white p-2"
                dangerouslySetInnerHTML={{ __html: qrSvg }}
                role="img"
                aria-label={`QR code for ticket ${ticketCode}`}
              />
            </div>
            <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-4">
              <div className="min-w-0">
                <p className="mb-1 text-[10.5px] font-semibold uppercase tracking-widest text-muted-foreground">Ticket code</p>
                <p className="font-mono text-[20px] font-bold tracking-[0.14em] text-foreground">{ticketCode}</p>
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
              href={`/tickets/${registrationId}`}
              className="flex items-center justify-center gap-1.5 px-5 py-3 text-[12.5px] font-medium text-primary transition-colors hover:bg-muted/50"
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

      {/* ── Email note (confirmed only — a confirmation email is actually sent) ── */}
      {variant === 'confirmed' && (
        <motion.div variants={item} className="mt-6 flex items-center justify-center gap-1.5">
          <Mail className="size-3.5 text-muted-foreground" aria-hidden />
          <p className="text-[12px] text-muted-foreground">
            Confirmation email sent to{' '}
            <span className="font-medium text-foreground">{attendeeEmail}</span>
          </p>
        </motion.div>
      )}
    </motion.main>
  )
}
