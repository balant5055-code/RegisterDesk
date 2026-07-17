'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { motion } from 'framer-motion'
import {
  Calendar, MapPin, MonitorPlay, Globe,
  ArrowRight, Users, Mic2, Layers, ClipboardList,
} from 'lucide-react'
import type { PassPublic } from '@/components/event-templates/types'
import type {
  PhysicalVenueConfig, Speaker, AgendaSession, ConferenceTrack,
} from '@/components/wizard/eventDetailsConfig'

// ─── Helpers ───────────────────────────────────────────────────────────────────

const pad2 = (n: number) => String(n).padStart(2, '0')

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
  return `${h! % 12 || 12}:${String(m ?? 0).padStart(2, '0')} ${h! < 12 ? 'AM' : 'PM'}`
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
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [target, time])
  return s
}

// ─── Props ─────────────────────────────────────────────────────────────────────

export interface ConferenceHeroProps {
  title:            string
  tagline:          string
  eventSubtype?:    string
  bannerUrl:        string
  startDate:        string
  startTime:        string
  endDate:          string
  venueName:        string
  venueType:        'physical' | 'online' | 'hybrid'
  physical?:        PhysicalVenueConfig
  registrationOpen: boolean
  isFreeEvent:      boolean
  passes:           PassPublic[]
  speakers:         Speaker[]
  agenda:           AgendaSession[]
  tracks:           ConferenceTrack[]
  totalAttendees:   number
  showAttendeeCount:boolean
}

// ─── Component ─────────────────────────────────────────────────────────────────

export function ConferenceHero({
  title, tagline, eventSubtype, bannerUrl,
  startDate, startTime, endDate,
  venueName, venueType, physical,
  registrationOpen, isFreeEvent, passes,
  speakers, agenda, tracks,
  totalAttendees, showAttendeeCount,
}: ConferenceHeroProps) {

  const activePasses  = passes.filter(p => p.status !== 'inactive')
  const minPrice      = activePasses.length > 0 ? Math.min(...activePasses.map(p => p.price)) : 0
  const locationText  = venueType === 'online' ? 'Online Event'
    : physical?.city ? `${venueName}, ${physical.city}` : venueName
  const formatLabel   = venueType === 'physical' ? 'In-Person'
    : venueType === 'online' ? 'Online' : 'Hybrid'
  const FormatIcon    = venueType === 'online' ? MonitorPlay : Globe

  const closeDate = activePasses.find(p => p.salesEndDate)?.salesEndDate
  const hasClose  = !!closeDate
  const cd        = useCountdown(closeDate ?? startDate, hasClose ? undefined : startTime)

  const dateLabel = endDate && endDate !== startDate
    ? `${fmtDate(startDate)} – ${fmtDate(endDate)}`
    : fmtDate(startDate)
  const timeLabel = startTime ? fmtTime(startTime) : ''

  const priceLabel = isFreeEvent || minPrice === 0
    ? 'Free Entry'
    : `From ${new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(minPrice)}`

  const stats = [
    speakers.length > 0 && { icon: Mic2,          val: speakers.length,                                label: speakers.length === 1 ? 'Speaker' : 'Speakers'   },
    agenda.filter(s => !s.isBreak).length > 0 && { icon: ClipboardList,  val: agenda.filter(s => !s.isBreak).length, label: 'Sessions' },
    tracks.length > 0 && { icon: Layers,         val: tracks.length,                                   label: tracks.length === 1 ? 'Track' : 'Tracks'         },
    showAttendeeCount && totalAttendees > 0 && { icon: Users, val: totalAttendees, label: 'Attending' },
  ].filter(Boolean) as { icon: typeof Mic2; val: number; label: string }[]

  const fadein = (delay = 0) => ({
    initial:    { opacity: 0, y: 20 },
    animate:    { opacity: 1, y: 0  },
    transition: { duration: 0.55, delay, ease: [0.25, 0, 0, 1] as const },
  })

  return (
    <section className="bg-white">
      <div className="mx-auto max-w-7xl px-4 pb-0 pt-10 sm:px-6 sm:pt-14 lg:px-8">

        <div className="grid items-start gap-8 lg:grid-cols-[1fr_42%] lg:gap-14">

          {/* ── Left column ──────────────────────────────────────────────────── */}
          <div className="order-2 lg:order-1">

            {/* Category badge */}
            <motion.div {...fadein(0)} className="mb-5">
              <span className="inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/[0.05] px-3.5 py-1.5">
                <span className="size-1.5 rounded-full bg-primary" aria-hidden />
                <span className="text-[11px] font-bold uppercase tracking-[0.20em] text-primary">
                  {eventSubtype ?? 'Conference'}
                </span>
              </span>
            </motion.div>

            {/* Title */}
            <motion.h1
              {...fadein(0.06)}
              className="mb-4 text-[2.125rem] font-black leading-[1.07] tracking-[-0.03em] text-gray-950 sm:text-[2.875rem] lg:text-[3.5rem]"
            >
              {title}
            </motion.h1>

            {/* Tagline */}
            {tagline && (
              <motion.p
                {...fadein(0.12)}
                className="mb-7 text-[1.0625rem] leading-relaxed text-gray-500 sm:text-lg"
              >
                {tagline}
              </motion.p>
            )}

            {/* Info rows */}
            <motion.div {...fadein(0.16)} className="mb-6 flex flex-col gap-3">
              {[
                { Icon: Calendar,   text: `${dateLabel}${timeLabel ? ` · ${timeLabel}` : ''}` },
                locationText ? { Icon: MapPin, text: locationText } : null,
                { Icon: FormatIcon, text: formatLabel },
              ].filter(Boolean).map(({ Icon, text }: any, i) => (
                <div key={i} className="flex items-center gap-3 text-sm text-gray-600">
                  <div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-gray-50 ring-1 ring-gray-100">
                    <Icon className="size-3.5 text-gray-400" aria-hidden />
                  </div>
                  <span className="font-medium">{text}</span>
                </div>
              ))}
            </motion.div>

            {/* Divider */}
            <motion.div {...fadein(0.18)} className="mb-6 h-px bg-gray-100" />

            {/* Countdown */}
            {registrationOpen && !cd.done && (
              <motion.div {...fadein(0.22)} className="mb-7">
                <p className="mb-3 text-[11px] font-bold uppercase tracking-[0.18em] text-gray-400">
                  {hasClose ? 'Registration closes in' : 'Event starts in'}
                </p>
                <div className="flex items-end gap-2">
                  {[
                    { val: cd.d, label: 'Days' },
                    { val: cd.h, label: 'Hrs'  },
                    { val: cd.m, label: 'Min'  },
                    { val: cd.s, label: 'Sec'  },
                  ].map(({ val, label }, i) => (
                    <div key={label} className="flex items-end gap-2">
                      {i > 0 && <span className="mb-[14px] text-[11px] font-light text-gray-300">:</span>}
                      <div className="flex min-w-[48px] flex-col items-center rounded-xl bg-gray-50 px-2 py-2.5 ring-1 ring-gray-100">
                        <span className="text-[1.375rem] font-black tabular-nums leading-none text-gray-900">
                          {pad2(val)}
                        </span>
                        <span className="mt-1 text-[9px] font-semibold uppercase tracking-[0.14em] text-gray-400">
                          {label}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </motion.div>
            )}

            {/* CTA row */}
            <motion.div {...fadein(0.26)} className="flex flex-wrap items-center gap-4">
              {registrationOpen && activePasses.length > 0 ? (
                <>
                  <Link
                    href="#tickets"
                    className="inline-flex items-center gap-2.5 rounded-full px-8 py-3.5 text-[0.9375rem] font-bold text-white shadow-lg shadow-primary/20 transition-all duration-200 hover:opacity-90 hover:shadow-xl hover:shadow-primary/30 active:scale-[0.97]"
                    style={{ backgroundImage: 'var(--primary-gradient)' }}
                  >
                    {isFreeEvent ? 'Register Free' : 'Get Your Pass'}
                    <ArrowRight className="size-4" aria-hidden />
                  </Link>
                  <span className="text-sm font-medium text-gray-400">{priceLabel}</span>
                </>
              ) : (
                <span className="inline-flex items-center gap-2 rounded-full bg-gray-100 px-5 py-2.5 text-sm font-semibold text-gray-500">
                  Registration Closed
                </span>
              )}
            </motion.div>

          </div>

          {/* ── Right column — Banner image ───────────────────────────────────── */}
          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: 12 }}
            animate={{ opacity: 1, scale: 1,    y: 0  }}
            transition={{ duration: 0.7, ease: [0.25, 0, 0, 1] }}
            className="order-1 lg:order-2"
          >
            <div className="relative overflow-hidden rounded-3xl bg-gray-100 shadow-[0_24px_72px_-12px_rgba(0,0,0,0.18)] ring-1 ring-black/[0.06] sm:aspect-[16/10] lg:aspect-[3/4]">
              {bannerUrl?.trim() ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={bannerUrl}
                  alt={title}
                  className="h-full min-h-[220px] w-full object-cover"
                />
              ) : (
                <div
                  className="flex h-full min-h-[220px] w-full items-center justify-center"
                  style={{ backgroundImage: 'var(--primary-gradient)' }}
                >
                  <span className="text-6xl font-black text-white/20">{title.charAt(0)}</span>
                </div>
              )}

              {/* Registration status badge */}
              <span className={`absolute left-3.5 top-3.5 inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[11px] font-bold backdrop-blur-sm ${
                registrationOpen
                  ? 'bg-emerald-500/90 text-white'
                  : 'bg-black/40 text-white'
              }`}>
                <span className={`size-1.5 rounded-full ${registrationOpen ? 'bg-white/90' : 'bg-gray-300'}`} aria-hidden />
                {registrationOpen ? 'Registration Open' : 'Registration Closed'}
              </span>
            </div>
          </motion.div>

        </div>

        {/* ── Stats bar ──────────────────────────────────────────────────────── */}
        {stats.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0  }}
            transition={{ duration: 0.5, delay: 0.3, ease: [0.25, 0, 0, 1] }}
            className="mt-10 border-t border-gray-100 py-7"
          >
            <div className="flex flex-wrap items-center gap-8 sm:gap-12">
              {stats.map(({ icon: Icon, val, label }, i) => (
                <div key={label} className="flex items-center gap-3">
                  {i > 0 && <div className="hidden h-7 w-px bg-gray-150 sm:block" aria-hidden />}
                  <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/[0.06]">
                    <Icon className="size-4 text-primary" aria-hidden />
                  </div>
                  <div>
                    <p className="text-[1.125rem] font-black leading-tight text-gray-900">
                      {val.toLocaleString('en-IN')}
                    </p>
                    <p className="text-[11px] font-medium text-gray-400">{label}</p>
                  </div>
                </div>
              ))}
            </div>
          </motion.div>
        )}

      </div>
    </section>
  )
}
