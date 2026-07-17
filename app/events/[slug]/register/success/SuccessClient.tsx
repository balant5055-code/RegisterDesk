'use client'

import { useState } from 'react'
import Link         from 'next/link'
import { motion, type Variants } from 'framer-motion'
import { Download, ExternalLink, Copy, Check, Mail, Ticket } from 'lucide-react'
import { cn }       from '@/lib/utils/cn'
import { AddToCalendarButton } from '@/components/event-templates/shared/ui/AddToCalendarButton'

export interface CalendarData {
  startDate: string   // YYYY-MM-DD
  endDate:   string   // YYYY-MM-DD
  startTime: string   // HH:MM or ''
  endTime:   string   // HH:MM or ''
  location:  string
}

// ─── Animated Icons ───────────────────────────────────────────────────────────

function SuccessIcon() {
  return (
    <div className="relative flex size-24 items-center justify-center">
      <motion.div
        className="absolute inset-0 rounded-full bg-emerald-100"
        initial={{ scale: 0, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ duration: 0.4, ease: [0.34, 1.56, 0.64, 1] }}
      />
      <svg viewBox="0 0 52 52" className="relative size-11" fill="none" aria-hidden>
        <motion.circle
          cx="26" cy="26" r="24"
          stroke="#059669"
          strokeWidth="2"
          strokeLinecap="round"
          initial={{ pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ duration: 0.55, ease: 'easeInOut' }}
        />
        <motion.path
          d="M14 27l8 8L38 18"
          stroke="#059669"
          strokeWidth="2.75"
          strokeLinecap="round"
          strokeLinejoin="round"
          initial={{ pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ duration: 0.4, delay: 0.45, ease: 'easeInOut' }}
        />
      </svg>
    </div>
  )
}

function PendingIcon() {
  return (
    <div className="relative flex size-24 items-center justify-center">
      <motion.div
        className="absolute inset-0 rounded-full bg-amber-100"
        initial={{ scale: 0, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ duration: 0.4, ease: [0.34, 1.56, 0.64, 1] }}
      />
      <svg viewBox="0 0 52 52" className="relative size-11" fill="none" aria-hidden>
        <motion.circle
          cx="26" cy="26" r="24"
          stroke="#d97706"
          strokeWidth="2"
          strokeLinecap="round"
          initial={{ pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ duration: 0.55, ease: 'easeInOut' }}
        />
        <motion.path
          d="M26 16v10l5 4"
          stroke="#d97706"
          strokeWidth="2.75"
          strokeLinecap="round"
          strokeLinejoin="round"
          initial={{ pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ duration: 0.35, delay: 0.45, ease: 'easeInOut' }}
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
}

// ─── Component ────────────────────────────────────────────────────────────────

export function SuccessClient({
  registrationId,
  ticketCode,
  eventName,
  passName,
  attendeeName,
  attendeeEmail,
  status,
  isPending,
  qrSvg,
  ticketPdfUrl,
  receiptUrl,
  eventSlug,
  calendarData,
}: SuccessClientProps) {
  const [copied, setCopied] = useState(false)

  async function copyCode() {
    await navigator.clipboard.writeText(ticketCode).catch(() => null)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const item: Variants = {
    hidden:  { opacity: 0, y: 18 },
    visible: { opacity: 1, y: 0, transition: { duration: 0.38, ease: 'easeOut' } },
  }

  return (
    <motion.div
      className="mx-auto max-w-md px-4 py-10"
      initial="hidden"
      animate="visible"
      variants={{ hidden: {}, visible: { transition: { staggerChildren: 0.09 } } }}
    >
      {/* Animated icon */}
      <motion.div variants={item} className="mb-6 flex justify-center">
        {isPending ? <PendingIcon /> : <SuccessIcon />}
      </motion.div>

      {/* Heading */}
      <motion.div variants={item} className="mb-6 text-center">
        <h1 className={cn(
          'text-[26px] font-bold tracking-tight',
          isPending ? 'text-amber-700' : 'text-foreground',
        )}>
          {isPending ? 'Registration Received' : "You're all set!"}
        </h1>
        <p className="mt-2 text-[14px] leading-relaxed text-muted-foreground">
          {isPending
            ? "Your registration is pending review. We'll email you once it's confirmed."
            : `Welcome, ${attendeeName}. Your registration is confirmed.`}
        </p>
      </motion.div>

      {/* Confirmed: full ticket card */}
      {!isPending && (
        <motion.div variants={item}>
          <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">

            {/* QR code */}
            <div className="flex flex-col items-center border-b border-border px-6 py-6">
              <p className="mb-4 text-[10.5px] font-semibold uppercase tracking-widest text-muted-foreground">
                Scan to Check In
              </p>
              <div
                className="overflow-hidden rounded-xl border border-border bg-white p-2"
                // eslint-disable-next-line react/no-danger
                dangerouslySetInnerHTML={{ __html: qrSvg }}
                aria-label={`QR code for ticket ${ticketCode}`}
              />
            </div>

            {/* Ticket code with copy */}
            <div className="border-b border-border px-5 py-4">
              <p className="mb-2 text-[10.5px] font-semibold uppercase tracking-widest text-muted-foreground">
                Ticket Code
              </p>
              <div className="flex items-center justify-between gap-3 rounded-xl bg-muted/40 px-4 py-3">
                <p className="font-mono text-[22px] font-bold tracking-[0.15em] text-foreground">
                  {ticketCode}
                </p>
                <button
                  type="button"
                  onClick={() => void copyCode()}
                  className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-card transition-colors hover:bg-muted"
                  aria-label="Copy ticket code"
                >
                  {copied
                    ? <Check className="size-3.5 text-emerald-600" />
                    : <Copy className="size-3.5 text-muted-foreground" />
                  }
                </button>
              </div>
            </div>

            {/* Event + pass summary */}
            <div className="grid grid-cols-2 divide-x divide-border border-b border-border">
              <div className="px-5 py-3">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Event</p>
                <p className="mt-0.5 line-clamp-2 text-[13px] font-medium text-foreground">{eventName}</p>
              </div>
              <div className="px-5 py-3">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Pass</p>
                <p className="mt-0.5 text-[13px] font-medium text-foreground">{passName}</p>
              </div>
            </div>

            {/* Status row */}
            <div className="flex items-center justify-between px-5 py-3">
              <div className="flex items-center gap-1.5">
                <span className="size-1.5 rounded-full bg-emerald-500" aria-hidden />
                <span className="text-[12px] font-semibold text-emerald-700">Confirmed</span>
              </div>
              <Link
                href={`/tickets/${registrationId}`}
                className="flex items-center gap-1 text-[12px] font-medium text-primary hover:underline"
              >
                <Ticket className="size-3" />
                View full ticket
                <ExternalLink className="size-3" />
              </Link>
            </div>
          </div>
        </motion.div>
      )}

      {/* Pending: compact summary card */}
      {isPending && (
        <motion.div variants={item}>
          <div className="rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4">
            <div className="grid grid-cols-2 gap-3">
              {[
                { label: 'Event',  value: eventName },
                { label: 'Pass',   value: passName },
                { label: 'Name',   value: attendeeName },
                { label: 'Status', value: 'Pending Review' },
              ].map(({ label, value }) => (
                <div key={label}>
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-amber-600">{label}</p>
                  <p className="mt-0.5 text-[13px] font-medium text-amber-900">{value}</p>
                </div>
              ))}
            </div>
          </div>
        </motion.div>
      )}

      {/* Actions */}
      <motion.div variants={item} className="mt-5 flex flex-col gap-2.5">
        {!isPending && (
          <>
            <a
              href={ticketPdfUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-center gap-2 rounded-xl bg-primary px-4 py-3 text-[14px] font-semibold text-primary-foreground shadow-sm transition-opacity hover:opacity-90"
            >
              <Download className="size-4" />
              Download Ticket PDF
            </a>
            {receiptUrl && (
              <a
                href={receiptUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-center gap-2 rounded-xl border border-border bg-card px-4 py-3 text-[14px] font-semibold text-foreground transition-colors hover:bg-muted/60"
              >
                <Download className="size-4" />
                Download Receipt
              </a>
            )}
            {calendarData?.startDate && (
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
          </>
        )}
        <Link
          href={`/events/${eventSlug}`}
          className="flex items-center justify-center gap-2 rounded-xl border border-border bg-card px-4 py-3 text-[14px] font-semibold text-foreground transition-colors hover:bg-muted/60"
        >
          <ExternalLink className="size-4" />
          View Event Page
        </Link>
      </motion.div>

      {/* Email footer note */}
      <motion.div variants={item} className="mt-5 flex items-center justify-center gap-1.5">
        <Mail className="size-3.5 text-muted-foreground" aria-hidden />
        <p className="text-[12px] text-muted-foreground">
          Confirmation email sent to{' '}
          <span className="font-medium text-foreground">{attendeeEmail}</span>
        </p>
      </motion.div>

      {/* Status badge (non-standard statuses) */}
      {status !== 'confirmed' && status !== 'pending' && (
        <motion.div variants={item} className="mt-4 flex justify-center">
          <span className="inline-flex rounded-full bg-muted px-3 py-1 text-[12px] font-semibold text-muted-foreground capitalize">
            {status}
          </span>
        </motion.div>
      )}
    </motion.div>
  )
}
