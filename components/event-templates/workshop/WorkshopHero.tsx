'use client'

import Link from 'next/link'
import { motion } from 'framer-motion'
import { Calendar, Monitor, Users, ArrowRight, Wifi, MapPin, Layers } from 'lucide-react'
import type { PassPublic } from '@/components/event-templates/types'
import type { Speaker } from '@/components/wizard/eventDetailsConfig'

// ─── Helpers ───────────────────────────────────────────────────────────────────

function fmtDate(d: string) {
  if (!d) return ''
  const [y, mo, day] = d.split('-').map(Number)
  return new Date(y!, mo! - 1, day!).toLocaleDateString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric',
  })
}

function fmtINR(n: number) {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(n)
}

function daysBetween(start: string, end: string): number {
  if (!start) return 0
  const s = new Date(start)
  const e = end ? new Date(end) : s
  return Math.max(1, Math.round((e.getTime() - s.getTime()) / 86400000) + 1)
}

// ─── Props ─────────────────────────────────────────────────────────────────────

export interface WorkshopHeroProps {
  title:            string
  tagline:          string
  eventSubtype?:    string
  bannerUrl:        string
  startDate:        string
  endDate:          string
  venueType:        'physical' | 'online' | 'hybrid'
  registrationOpen: boolean
  isFreeEvent:      boolean
  passes:           PassPublic[]
  slug:             string
  leadInstructor?:  Speaker
  batchSize?:       number | null
}

// ─── Component ─────────────────────────────────────────────────────────────────

export function WorkshopHero({
  title, tagline, eventSubtype, bannerUrl,
  startDate, endDate, venueType,
  registrationOpen, isFreeEvent, passes, slug,
  leadInstructor, batchSize,
}: WorkshopHeroProps) {
  const activePasses = passes.filter(p => p.status !== 'inactive')
  const minPrice     = activePasses.length > 0 ? Math.min(...activePasses.map(p => p.price)) : 0
  const priceLabel   = isFreeEvent || minPrice === 0 ? 'Free' : fmtINR(minPrice)
  const days         = daysBetween(startDate, endDate)

  const modeLabel = venueType === 'online' ? 'Online' : venueType === 'hybrid' ? 'Hybrid' : 'Offline'
  const ModeIcon  = venueType === 'online' ? Wifi : venueType === 'hybrid' ? Layers : MapPin

  const chips = [
    { Icon: ModeIcon,  label: modeLabel },
    eventSubtype && { Icon: Monitor, label: eventSubtype },
    days > 0 && { Icon: Calendar, label: days === 1 ? '1 Day' : `${days} Days` },
    batchSize && { Icon: Users, label: `${batchSize} seats` },
  ].filter(Boolean) as { Icon: typeof Wifi; label: string }[]

  const fi = (delay = 0) => ({
    initial:    { opacity: 0, y: 18 },
    animate:    { opacity: 1, y: 0 },
    transition: { duration: 0.5, delay, ease: [0.25, 0, 0, 1] as const },
  })

  return (
    <section className="bg-white">
      <div className="mx-auto max-w-7xl px-4 pb-0 pt-10 sm:px-6 sm:pt-14 lg:px-8">
        <div className="grid items-start gap-8 lg:grid-cols-[1fr_42%] lg:gap-12">

          {/* ── Left ── */}
          <div className="order-2 lg:order-1">

            {/* Category badge */}
            <motion.div {...fi(0)} className="mb-4">
              <span className="inline-flex items-center gap-2 rounded-full border border-blue-200 bg-blue-50 px-3 py-1.5">
                <span className="size-1.5 rounded-full bg-blue-500" aria-hidden />
                <span className="text-[11px] font-bold uppercase tracking-[0.18em] text-blue-600">
                  Workshop
                </span>
              </span>
            </motion.div>

            <motion.h1
              {...fi(0.05)}
              className="mb-3 text-[2rem] font-black leading-[1.09] tracking-[-0.03em] text-gray-950 sm:text-[2.625rem] lg:text-[3rem]"
            >
              {title}
            </motion.h1>

            {/* Instructor attribution */}
            {leadInstructor && (
              <motion.p {...fi(0.09)} className="mb-4 text-[0.9375rem] text-gray-500">
                Taught by{' '}
                <span className="font-semibold text-gray-800">{leadInstructor.name}</span>
                {leadInstructor.title && (
                  <span className="text-gray-400"> · {leadInstructor.title}</span>
                )}
              </motion.p>
            )}

            {tagline && (
              <motion.p {...fi(0.12)} className="mb-6 text-[1rem] leading-relaxed text-gray-500">
                {tagline}
              </motion.p>
            )}

            {/* Info chips */}
            {chips.length > 0 && (
              <motion.div {...fi(0.15)} className="mb-6 flex flex-wrap gap-2">
                {chips.map(({ Icon, label }, i) => (
                  <span
                    key={i}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-gray-100 px-3 py-1.5 text-[12.5px] font-semibold text-gray-600"
                  >
                    <Icon className="size-3.5 text-gray-400" aria-hidden />
                    {label}
                  </span>
                ))}
              </motion.div>
            )}

            {/* Start date */}
            {startDate && (
              <motion.p {...fi(0.18)} className="mb-6 flex items-center gap-2 text-sm text-gray-500">
                <Calendar className="size-4 shrink-0 text-gray-400" aria-hidden />
                <span>
                  Starts <strong className="text-gray-800">{fmtDate(startDate)}</strong>
                  {endDate && endDate !== startDate && (
                    <> · Ends <strong className="text-gray-800">{fmtDate(endDate)}</strong></>
                  )}
                </span>
              </motion.p>
            )}

            <motion.div {...fi(0.19)} className="mb-6 h-px bg-gray-100" />

            {/* CTA */}
            <motion.div {...fi(0.22)} className="flex flex-wrap items-center gap-4">
              {registrationOpen && activePasses.length > 0 ? (
                <>
                  <Link
                    href="#enroll"
                    className="inline-flex items-center gap-2.5 rounded-full bg-blue-600 px-7 py-3 text-[0.9375rem] font-bold text-white shadow-md shadow-blue-600/20 transition-all duration-200 hover:bg-blue-700 active:scale-[0.97]"
                  >
                    {isFreeEvent ? 'Enroll Free' : 'Enroll Now'}
                    <ArrowRight className="size-4" aria-hidden />
                  </Link>
                  {!isFreeEvent && (
                    <span className="text-sm font-medium text-gray-400">From {priceLabel}</span>
                  )}
                </>
              ) : (
                <span className="inline-flex items-center rounded-full bg-gray-100 px-5 py-2.5 text-sm font-semibold text-gray-500">
                  Enrollment Closed
                </span>
              )}
            </motion.div>

          </div>

          {/* ── Right — Banner ── */}
          <motion.div
            initial={{ opacity: 0, scale: 0.97, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            transition={{ duration: 0.65, ease: [0.25, 0, 0, 1] }}
            className="order-1 lg:order-2"
          >
            <div className="relative overflow-hidden rounded-2xl bg-gray-100 shadow-[0_16px_56px_-12px_rgba(0,0,0,0.14)] ring-1 ring-black/[0.05] sm:aspect-[16/10] lg:aspect-video">
              {bannerUrl?.trim() ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={bannerUrl} alt={title} className="h-full min-h-[200px] w-full object-cover" />
              ) : (
                <div className="flex h-full min-h-[200px] w-full items-center justify-center bg-gradient-to-br from-blue-500 to-indigo-600">
                  <Monitor className="size-14 text-white/20" aria-hidden />
                </div>
              )}
              <span className={`absolute left-3 top-3 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold backdrop-blur-sm ${
                registrationOpen ? 'bg-blue-600/90 text-white' : 'bg-black/40 text-white'
              }`}>
                <span className={`size-1.5 rounded-full ${registrationOpen ? 'bg-white/90' : 'bg-gray-300'}`} aria-hidden />
                {registrationOpen ? 'Enrollment Open' : 'Enrollment Closed'}
              </span>
            </div>
          </motion.div>

        </div>

        {/* Bottom separator */}
        <div className="mt-10 border-t border-gray-100" />
      </div>
    </section>
  )
}
