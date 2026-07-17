'use client'

import { useState, useRef, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  ArrowRight, Check, MapPin, Calendar,
  ChevronDown, Link2, Download,
} from 'lucide-react'
import type { PassPublic } from '@/components/event-templates/types'
import type { PhysicalVenueConfig } from '@/components/wizard/eventDetailsConfig'

// ─── Helpers ───────────────────────────────────────────────────────────────
function fmtDate(d: string) {
  if (!d) return ''
  const [y, mo, day] = d.split('-').map(Number)
  return new Date(y!, mo! - 1, day!).toLocaleDateString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric',
  })
}
function fmtTime(t: string) {
  if (!t) return ''
  const [h, m] = t.split(':').map(Number)
  return `${h! % 12 || 12}:${(m ?? 0).toString().padStart(2, '0')} ${h! < 12 ? 'AM' : 'PM'}`
}
const pad2 = (n: number) => n.toString().padStart(2, '0')

function fmtCal(date: string, time?: string) {
  return `${date.replace(/-/g, '')}T${time ? time.replace(/:/g, '').slice(0, 6).padEnd(6, '0') : '000000'}`
}
const googleCalUrl = (title: string, start: string, end: string, loc: string, url: string) =>
  'https://calendar.google.com/calendar/render?' +
  new URLSearchParams({ action: 'TEMPLATE', text: title, dates: `${start}/${end}`, location: loc, details: `Register: ${url}` })
const outlookCalUrl = (title: string, s: string, e: string, loc: string, url: string) =>
  'https://outlook.live.com/calendar/0/deeplink/compose?' +
  new URLSearchParams({ subject: title, startdt: s, enddt: e, location: loc, body: `Register: ${url}` })

function triggerIcs(title: string, start: string, end: string, loc: string, url: string) {
  const now = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15)
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//RegisterDesk//EN',
    'BEGIN:VEVENT',
    `SUMMARY:${title}`, `DTSTART:${start}`, `DTEND:${end}`,
    `LOCATION:${loc}`, `DESCRIPTION:Register: ${url}`,
    `DTSTAMP:${now}Z`, `UID:${title.replace(/\W/g, '-').slice(0, 40)}-${start}@rd`,
    'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n')
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(new Blob([ics], { type: 'text/calendar;charset=utf-8' })),
    download: `${title.slice(0, 30).trim()}.ics`,
  })
  document.body.appendChild(a); a.click(); document.body.removeChild(a)
}

function useCountdown(target: string, time?: string) {
  const [s, set] = useState({ d: 0, h: 0, m: 0, s: 0, done: false })
  useEffect(() => {
    if (!target) { set({ d: 0, h: 0, m: 0, s: 0, done: true }); return }
    const end = new Date(`${target}T${time ?? '23:59:00'}`)
    const tick = () => {
      const diff = end.getTime() - Date.now()
      if (diff <= 0) { set({ d: 0, h: 0, m: 0, s: 0, done: true }); return }
      const ts = Math.floor(diff / 1000)
      set({ d: Math.floor(ts / 86400), h: Math.floor((ts % 86400) / 3600), m: Math.floor((ts % 3600) / 60), s: ts % 60, done: false })
    }
    tick(); const id = setInterval(tick, 1000); return () => clearInterval(id)
  }, [target, time])
  return s
}

// ─── Component ────────────────────────────────────────────────────────────
export function CommunityHero({
  title, tagline, eventSubtype,
  bannerUrl, startDate, startTime, endDate,
  venueName, venueType, physical,
  registrationOpen, isFreeEvent, passes,
  totalAttendees, showAttendeeCount,
}: {
  title: string; tagline: string; eventSubtype?: string
  bannerUrl: string; startDate: string; startTime: string; endDate?: string
  venueName: string; venueType: 'physical' | 'online' | 'hybrid'
  physical?: PhysicalVenueConfig
  registrationOpen: boolean; isFreeEvent: boolean; passes: PassPublic[]
  totalAttendees: number; showAttendeeCount: boolean
}) {
  const [copied, setCopied]   = useState(false)
  const [calOpen, setCalOpen] = useState(false)
  const [busy, setBusy]       = useState(false)
  const calRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!calOpen) return
    const h = (e: MouseEvent) => {
      if (calRef.current && !calRef.current.contains(e.target as Node)) setCalOpen(false)
    }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [calOpen])

  const active   = passes.filter(p => p.status !== 'inactive')
  const minPrice = active.length > 0 ? Math.min(...active.map(p => p.price)) : 0
  const loc      = venueType === 'online' ? 'Online' : physical?.city ?? venueName
  const priceTag = isFreeEvent ? 'Free' : `₹${minPrice.toLocaleString('en-IN')}`

  const closeDate   = active.reduce((a, p) => (!p.salesEndDate ? a : !a || p.salesEndDate < a ? p.salesEndDate : a), '' as string) || startDate
  const hasClose    = active.some(p => p.salesEndDate)
  const cdLabel     = hasClose ? 'Registration closes in' : 'Event starts in'
  const cd          = useCountdown(registrationOpen ? closeDate : '', startTime)

  const calLoc   = venueType === 'online' ? 'Online Event' : [physical?.addressLine1, physical?.city, physical?.state].filter(Boolean).join(', ') || venueName
  const calStart = fmtCal(startDate, startTime)
  const calEnd   = fmtCal(endDate ?? startDate, startTime)

  const copyLink = () => {
    if (typeof window === 'undefined') return
    navigator.clipboard.writeText(window.location.href).catch(() => null)
    setCopied(true); setTimeout(() => setCopied(false), 2000)
  }

  const downloadPoster = async () => {
    if (!bannerUrl) return
    setBusy(true)
    try {
      const res = await fetch(bannerUrl)
      const blob = await res.blob()
      const href = URL.createObjectURL(blob)
      const a = Object.assign(document.createElement('a'), {
        href, download: `${title.slice(0, 30).replace(/[^a-z0-9]/gi, '-')}-poster.${blob.type.includes('png') ? 'png' : 'jpg'}`,
      })
      document.body.appendChild(a); a.click(); document.body.removeChild(a)
      URL.revokeObjectURL(href)
    } catch { window.open(bannerUrl, '_blank') }
    finally { setBusy(false) }
  }

  const pageUrl = typeof window !== 'undefined' ? window.location.href : ''

  return (
    <section className="bg-white">

      {/* Brand accent bar */}
      <div className="h-px w-full" style={{ backgroundImage: 'var(--primary-gradient)' }} aria-hidden />

      {/* ── Banner image ──────────────────────────────────────────────────── */}
      <div className="relative h-[190px] overflow-hidden sm:h-[230px]">

        {/* Image */}
        {bannerUrl ? (
          <motion.img
            initial={{ scale: 1.06 }}
            animate={{ scale: 1 }}
            transition={{ duration: 2.2, ease: [0.25, 0, 0, 1] }}
            src={bannerUrl}
            alt=""
            aria-hidden
            className="absolute inset-0 h-full w-full object-cover"
          />
        ) : (
          <div
            aria-hidden
            className="absolute inset-0"
            style={{ backgroundImage: 'var(--primary-gradient)' }}
          />
        )}

        {/* Inset vignette — depth around all edges */}
        <div
          aria-hidden
          className="absolute inset-0"
          style={{ boxShadow: 'inset 0 0 80px rgba(0,0,0,0.18)' }}
        />

        {/* Top shadow — keeps status badge legible */}
        <div
          aria-hidden
          className="absolute inset-x-0 top-0 h-20"
          style={{ background: 'linear-gradient(to bottom, rgba(0,0,0,0.20), transparent)' }}
        />

        {/* Bottom fade to white — dissolves seamlessly into card */}
        <div
          aria-hidden
          className="absolute inset-x-0 bottom-0 h-[56%]"
          style={{ background: 'linear-gradient(to bottom, transparent, white)' }}
        />

        {/* Status badge */}
        <motion.span
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.4 }}
          className={`absolute right-3.5 top-3.5 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[0.5rem] font-bold uppercase tracking-[0.16em] backdrop-blur-sm ${
            registrationOpen
              ? 'bg-emerald-500/80 text-white'
              : 'bg-black/30 text-white/60'
          }`}
        >
          <span className={`size-1.5 rounded-full ${registrationOpen ? 'animate-pulse bg-white' : 'bg-white/40'}`} aria-hidden />
          {registrationOpen ? 'Open' : 'Closed'}
        </motion.span>
      </div>

      {/* ── Luxury card ────────────────────────────────────────────────────── */}
      <div className="px-4 pb-0 sm:px-6 lg:px-8">
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1], delay: 0.08 }}
          className="relative mx-auto -mt-8 max-w-5xl overflow-hidden rounded-2xl bg-white px-5 py-5 shadow-[0_8px_36px_-6px_rgba(0,0,0,0.13),0_1px_6px_-2px_rgba(0,0,0,0.06)] ring-1 ring-black/[0.06] sm:px-6 sm:py-6"
        >
          {/* 1px gradient top edge on card */}
          <div aria-hidden className="absolute inset-x-0 top-0 h-px" style={{ backgroundImage: 'var(--primary-gradient)' }} />

          {/* ── Campaign label ───────────────────────────────────────────── */}
          <div className="mb-2.5">
            <span className="inline-flex items-center gap-1.5 text-[9px] font-bold uppercase tracking-[0.24em] text-slate-400">
              <span className="size-[5px] rounded-full bg-rose-400" aria-hidden />
              {eventSubtype?.replace(/_/g, ' ') ?? 'Community Awareness'}
            </span>
          </div>

          {/* ── Title (left) + Countdown (right) — same row ─────────────── */}
          <div className="mb-1.5 flex items-start gap-5">
            <h1
              title={title}
              className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[1.25rem] font-black leading-tight tracking-[-0.02em] text-gray-950 sm:text-[1.5rem]"
            >
              {title}
            </h1>

            {registrationOpen && !cd.done && (
              <div className="shrink-0 text-right">
                <p className="mb-1 text-[8px] font-semibold uppercase tracking-[0.18em] text-gray-400">
                  {hasClose ? 'Closes in' : 'Starts in'}
                </p>
                <div className="flex items-end justify-end gap-1.5 sm:gap-2">
                  {[
                    { val: cd.d, label: 'DAYS' },
                    { val: cd.h, label: 'HRS' },
                    { val: cd.m, label: 'MIN' },
                    { val: cd.s, label: 'SEC' },
                  ].map(({ val, label }, i) => (
                    <div key={label} className="flex items-end gap-1.5 sm:gap-2">
                      {i > 0 && (
                        <span className="mb-[9px] text-[0.5rem] text-gray-300" aria-hidden>:</span>
                      )}
                      <div className="flex flex-col items-center">
                        <span className="text-[0.9375rem] font-black tabular-nums leading-none text-gray-900 sm:text-[1.0625rem]">
                          {pad2(val)}
                        </span>
                        <span className="mt-0.5 text-[5.5px] font-bold uppercase tracking-[0.1em] text-gray-400">
                          {label}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* ── Tagline ─────────────────────────────────────────────────── */}
          {tagline && tagline !== title && (
            <p className="mb-4 max-w-[560px] text-[0.8125rem] leading-relaxed text-gray-400">
              {tagline}
            </p>
          )}

          {/* ── Divider ─────────────────────────────────────────────────── */}
          <div className="mb-3 h-px bg-gray-100" aria-hidden />

          {/* ── Meta + CTA ──────────────────────────────────────────────── */}
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1.5 text-[0.8125rem] text-gray-400">
              {startDate && (
                <span className="flex items-center gap-1.5">
                  <Calendar className="size-3.5 shrink-0 text-gray-300" aria-hidden />
                  {fmtDate(startDate)}{startTime ? ` · ${fmtTime(startTime)}` : ''}
                </span>
              )}
              {loc && (
                <span className="flex items-center gap-1.5">
                  <MapPin className="size-3.5 shrink-0 text-gray-300" aria-hidden />
                  {loc}
                </span>
              )}
              <span className={`rounded-full px-2 py-0.5 text-[0.6875rem] font-semibold ${
                isFreeEvent ? 'bg-emerald-50 text-emerald-600 ring-1 ring-emerald-100' : 'bg-slate-50 text-slate-600 ring-1 ring-black/[0.06]'
              }`}>
                {priceTag}
              </span>
            </div>
            {registrationOpen && active.length > 0 && (
              <a
                href="#tickets"
                className="group inline-flex shrink-0 items-center gap-1.5 rounded-full px-4 py-1.5 text-[0.8125rem] font-bold text-white transition-all duration-200 hover:opacity-90 hover:shadow-md active:scale-[0.97]"
                style={{ backgroundImage: 'var(--primary-gradient)' }}
              >
                {isFreeEvent ? 'Join Free' : 'Get Your Pass'}
                <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" aria-hidden />
              </a>
            )}
          </div>

          {/* ── Divider ─────────────────────────────────────────────────── */}
          <div className="mb-3 h-px bg-gray-100" aria-hidden />

          {/* ── Actions row ─────────────────────────────────────────────── */}
          <div className="flex flex-wrap items-center justify-between gap-2.5">

            {/* Action buttons */}
            <div className="flex flex-wrap items-center">

              {/* Add Reminder */}
              <div ref={calRef} className="relative">
                <button
                  onClick={() => setCalOpen(o => !o)}
                  className="inline-flex items-center gap-1.5 rounded-l-full border border-r-0 border-gray-200 px-3 py-1.5 text-[0.75rem] font-medium text-gray-500 transition-colors hover:bg-gray-50 active:scale-[0.97]"
                >
                  <Calendar className="size-3" aria-hidden />
                  Add Reminder
                  <ChevronDown className={`size-3 transition-transform duration-200 ${calOpen ? 'rotate-180' : ''}`} aria-hidden />
                </button>
                <AnimatePresence>
                  {calOpen && (
                    <motion.div
                      initial={{ opacity: 0, y: 6, scale: 0.97 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: 6, scale: 0.97 }}
                      transition={{ duration: 0.13, ease: 'easeOut' }}
                      className="absolute bottom-full left-0 z-20 mb-1.5 min-w-[186px] overflow-hidden rounded-xl bg-white py-1 shadow-[0_8px_30px_-4px_rgba(0,0,0,0.15),0_0_0_1px_rgba(0,0,0,0.06)]"
                    >
                      {(['Google Calendar', 'Outlook', 'Apple Calendar (.ics)'] as const).map((label, i) => {
                        const icons = ['G', 'O', 'A']
                        if (label === 'Apple Calendar (.ics)') {
                          return (
                            <button
                              key={label}
                              onClick={() => { setCalOpen(false); triggerIcs(title, calStart, calEnd, calLoc, pageUrl) }}
                              className="flex w-full items-center gap-2.5 px-3.5 py-2 text-[0.8125rem] text-gray-700 hover:bg-gray-50"
                            >
                              <span className="flex size-5 shrink-0 items-center justify-center rounded-md bg-gray-100 text-[8px] font-black text-gray-500">{icons[i]}</span>
                              {label}
                            </button>
                          )
                        }
                        const href = i === 0
                          ? googleCalUrl(title, calStart, calEnd, calLoc, pageUrl)
                          : outlookCalUrl(title, `${startDate}T${startTime ?? '00:00:00'}`, `${endDate ?? startDate}T${startTime ?? '00:00:00'}`, calLoc, pageUrl)
                        return (
                          <a
                            key={label}
                            href={href}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={() => setCalOpen(false)}
                            className="flex items-center gap-2.5 px-3.5 py-2 text-[0.8125rem] text-gray-700 hover:bg-gray-50"
                          >
                            <span className="flex size-5 shrink-0 items-center justify-center rounded-md bg-gray-100 text-[8px] font-black text-gray-500">{icons[i]}</span>
                            {label}
                          </a>
                        )
                      })}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>

              {/* separator */}
              <span className="h-[28px] w-px bg-gray-200" aria-hidden />

              {/* Copy Link */}
              <button
                onClick={copyLink}
                className="inline-flex items-center gap-1.5 border border-x-0 border-gray-200 px-3 py-1.5 text-[0.75rem] font-medium text-gray-500 transition-colors hover:bg-gray-50 active:scale-[0.97]"
              >
                {copied
                  ? <><Check className="size-3 text-emerald-500" aria-hidden />Copied</>
                  : <><Link2 className="size-3" aria-hidden />Copy Link</>
                }
              </button>

              {/* separator */}
              <span className="h-[28px] w-px bg-gray-200" aria-hidden />

              {/* Download Poster */}
              {bannerUrl && (
                <button
                  onClick={downloadPoster}
                  disabled={busy}
                  className="inline-flex items-center gap-1.5 rounded-r-full border border-l-0 border-gray-200 px-3 py-1.5 text-[0.75rem] font-medium text-gray-500 transition-colors hover:bg-gray-50 active:scale-[0.97] disabled:opacity-40"
                >
                  <Download className="size-3" aria-hidden />
                  {busy ? 'Saving…' : 'Download Poster'}
                </button>
              )}
            </div>

            {/* Social proof */}
            {showAttendeeCount && totalAttendees > 0 && (
              <div className="flex items-center gap-1.5">
                <div className="flex -space-x-0.5" aria-hidden>
                  {['from-rose-400 to-pink-500', 'from-violet-400 to-purple-500', 'from-teal-400 to-emerald-500'].map((g, i) => (
                    <div key={i} className={`size-4 rounded-full bg-gradient-to-br ${g} ring-[1.5px] ring-white`} style={{ opacity: 1 - i * 0.1 }} />
                  ))}
                </div>
                <span className="text-[0.6875rem] text-gray-400">
                  <span className="font-semibold text-gray-600">{totalAttendees.toLocaleString('en-IN')}</span> joined
                </span>
              </div>
            )}

          </div>
        </motion.div>
      </div>

    </section>
  )
}
