'use client'

import Link from 'next/link'
import { motion } from 'framer-motion'
import { Calendar, MapPin, ArrowRight, Award, Trophy } from 'lucide-react'
import type { PassPublic } from '@/components/event-templates/types'
import type { PhysicalVenueConfig } from '@/components/wizard/eventDetailsConfig'

// ─── Helpers ───────────────────────────────────────────────────────────────────

function fmtDate(d: string) {
  if (!d) return ''
  const [y, mo, day] = d.split('-').map(Number)
  return new Date(y!, mo! - 1, day!).toLocaleDateString('en-IN', {
    day: 'numeric', month: 'long', year: 'numeric',
  })
}

function fmtINR(n: number) {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(n)
}

// ─── Props ─────────────────────────────────────────────────────────────────────

export interface AwardsHeroProps {
  title:              string
  tagline:            string
  eventSubtype?:      string
  bannerUrl:          string
  startDate:          string
  endDate:            string
  venueName:          string
  physical?:          PhysicalVenueConfig
  registrationOpen:   boolean
  isFreeEvent:        boolean
  passes:             PassPublic[]
  slug:               string
  categoryCount:      number
  judgesCount:        number
}

// ─── Component ─────────────────────────────────────────────────────────────────

export function AwardsHero({
  title, tagline, eventSubtype, bannerUrl,
  startDate, endDate, venueName, physical,
  registrationOpen, isFreeEvent, passes, slug,
  categoryCount, judgesCount,
}: AwardsHeroProps) {
  const active   = passes.filter(p => p.status !== 'inactive')
  const minPrice = active.length > 0 ? Math.min(...active.map(p => p.price)) : 0
  const locText  = physical?.city ? `${venueName}, ${physical.city}` : venueName

  const dateLabel = endDate && endDate !== startDate
    ? `${fmtDate(startDate)} – ${fmtDate(endDate)}`
    : fmtDate(startDate)

  const priceLabel = isFreeEvent || minPrice === 0 ? 'Free Attendance' : `From ${fmtINR(minPrice)}`

  const fi = (delay = 0) => ({
    initial:    { opacity: 0, y: 20 },
    animate:    { opacity: 1, y: 0 },
    transition: { duration: 0.65, delay, ease: [0.22, 1, 0.36, 1] as const },
  })

  return (
    <section className="relative isolate overflow-hidden bg-zinc-950">

      {/* Banner image */}
      {bannerUrl?.trim() && (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={bannerUrl}
            alt={title}
            className="absolute inset-0 h-full w-full object-cover opacity-15"
          />
          <div className="absolute inset-0 bg-gradient-to-b from-zinc-950/50 via-zinc-950/80 to-zinc-950" />
        </>
      )}

      {/* Decorative gold radial */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute left-1/2 top-0 h-px w-full max-w-2xl -translate-x-1/2 bg-gradient-to-r from-transparent via-yellow-400/30 to-transparent" />
        <div className="absolute left-1/4 top-0 size-[600px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-yellow-400/5 blur-3xl" />
        <div className="absolute right-1/4 top-1/2 size-[400px] translate-x-1/2 -translate-y-1/2 rounded-full bg-yellow-500/4 blur-3xl" />
      </div>

      <div className="relative mx-auto max-w-7xl px-4 pb-20 pt-16 sm:px-6 sm:pt-20 lg:px-8">

        {/* Category badge */}
        <motion.div {...fi(0)} className="mb-5">
          <span className="inline-flex items-center gap-2 rounded-full border border-yellow-400/30 bg-yellow-400/8 px-4 py-1.5">
            <Award className="size-3.5 text-yellow-400" aria-hidden />
            <span className="text-[11px] font-bold uppercase tracking-[0.24em] text-yellow-400">
              {eventSubtype ?? 'Awards & Recognition'}
            </span>
          </span>
        </motion.div>

        {/* Title */}
        <motion.h1
          {...fi(0.07)}
          className="mb-4 max-w-4xl text-[2.5rem] font-black leading-[1.04] tracking-[-0.03em] text-white sm:text-[3.75rem] lg:text-[4.5rem]"
        >
          {title}
        </motion.h1>

        {tagline && (
          <motion.p {...fi(0.12)} className="mb-8 max-w-2xl text-[1.0625rem] leading-relaxed text-zinc-400">
            {tagline}
          </motion.p>
        )}

        {/* Date + Venue */}
        <motion.div {...fi(0.15)} className="mb-6 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
          {dateLabel && (
            <div className="flex items-center gap-2.5 text-sm text-zinc-400">
              <Calendar className="size-4 shrink-0 text-yellow-400/70" aria-hidden />
              <span className="font-semibold text-zinc-300">{dateLabel}</span>
            </div>
          )}
          {locText && (
            <div className="flex items-center gap-2.5 text-sm text-zinc-400 sm:ml-5">
              <MapPin className="size-4 shrink-0 text-yellow-400/70" aria-hidden />
              <span className="font-semibold text-zinc-300">{locText}</span>
            </div>
          )}
        </motion.div>

        {/* Stats row */}
        <motion.div {...fi(0.18)} className="mb-8 flex flex-wrap items-center gap-3">
          {categoryCount > 0 && (
            <div className="flex items-center gap-3 rounded-xl border border-yellow-400/15 bg-yellow-400/5 px-4 py-2.5">
              <Award className="size-4 text-yellow-400" aria-hidden />
              <div>
                <p className="text-[1.125rem] font-black leading-none text-yellow-400">{categoryCount}</p>
                <p className="text-[10.5px] text-zinc-500">Award Categories</p>
              </div>
            </div>
          )}
          {judgesCount > 0 && (
            <div className="flex items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-2.5">
              <div className="size-4 rounded-full border border-yellow-400/40 bg-yellow-400/10" />
              <div>
                <p className="text-[1.125rem] font-black leading-none text-white">{judgesCount}</p>
                <p className="text-[10.5px] text-zinc-500">Expert Judges</p>
              </div>
            </div>
          )}
        </motion.div>

        {/* Divider */}
        <motion.div {...fi(0.20)} className="mb-7 h-px max-w-md bg-gradient-to-r from-yellow-400/20 via-yellow-400/10 to-transparent" />

        {/* CTA */}
        <motion.div {...fi(0.22)} className="flex flex-wrap items-center gap-4">
          {registrationOpen && active.length > 0 ? (
            <>
              <Link
                href="#tickets"
                className="inline-flex items-center gap-2.5 rounded-full bg-yellow-400 px-7 py-3.5 text-[0.9375rem] font-black text-zinc-950 shadow-[0_8px_32px_-8px_rgba(234,179,8,0.5)] transition-all duration-200 hover:bg-yellow-300 active:scale-[0.97]"
              >
                Secure Your Seat
                <ArrowRight className="size-4" aria-hidden />
              </Link>
              <Link
                href="#nominate"
                className="inline-flex items-center gap-2 rounded-full border border-yellow-400/30 bg-yellow-400/10 px-6 py-3 text-[0.875rem] font-bold text-yellow-400 transition-all hover:bg-yellow-400/15"
              >
                <Trophy className="size-3.5" aria-hidden />
                Nominate Now
              </Link>
              <span className="text-sm font-medium text-zinc-500">{priceLabel}</span>
            </>
          ) : active.length > 0 ? (
            <>
              <span className="inline-flex items-center rounded-full border border-zinc-700 bg-zinc-800 px-6 py-3 text-sm font-semibold text-zinc-400">
                Registration Closed
              </span>
              <Link
                href="#nominate"
                className="inline-flex items-center gap-2 rounded-full border border-yellow-400/30 bg-yellow-400/10 px-6 py-3 text-[0.875rem] font-bold text-yellow-400 transition-all hover:bg-yellow-400/15"
              >
                <Trophy className="size-3.5" aria-hidden />
                Nominate Now
              </Link>
            </>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <Link
                href="#categories"
                className="inline-flex items-center gap-2.5 rounded-full bg-yellow-400 px-7 py-3.5 text-[0.9375rem] font-black text-zinc-950 transition-all hover:bg-yellow-300"
              >
                View Categories
                <ArrowRight className="size-4" aria-hidden />
              </Link>
              <Link
                href="#nominate"
                className="inline-flex items-center gap-2 rounded-full border border-yellow-400/30 bg-yellow-400/10 px-6 py-3 text-[0.875rem] font-bold text-yellow-400 transition-all hover:bg-yellow-400/15"
              >
                <Trophy className="size-3.5" aria-hidden />
                Nominate Now
              </Link>
            </div>
          )}
        </motion.div>

      </div>

      {/* Bottom border */}
      <div className="h-px w-full bg-gradient-to-r from-transparent via-yellow-400/20 to-transparent" />
    </section>
  )
}
