'use client'

import Link from 'next/link'
import { motion } from 'framer-motion'
import { Calendar, MapPin, ArrowRight, Sparkles } from 'lucide-react'
import type { PassPublic } from '@/components/event-templates/types'
import type { PhysicalVenueConfig } from '@/components/wizard/eventDetailsConfig'

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

// ─── Props ─────────────────────────────────────────────────────────────────────

export interface CulturalHeroProps {
  title:             string
  tagline:           string
  eventSubtype?:     string
  bannerUrl:         string
  startDate:         string
  endDate:           string
  venueName:         string
  physical?:         PhysicalVenueConfig
  registrationOpen:  boolean
  isFreeEvent:       boolean
  passes:            PassPublic[]
  slug:              string
  performerCount:    number
}

// ─── Component ─────────────────────────────────────────────────────────────────

export function CulturalHero({
  title, tagline, eventSubtype, bannerUrl,
  startDate, endDate, venueName, physical,
  registrationOpen, isFreeEvent, passes, slug,
  performerCount,
}: CulturalHeroProps) {
  const active   = passes.filter(p => p.status !== 'inactive')
  const minPrice = active.length > 0 ? Math.min(...active.map(p => p.price)) : 0
  const locText  = physical?.city ? `${venueName}, ${physical.city}` : venueName

  const dateLabel = endDate && endDate !== startDate
    ? `${fmtDate(startDate)} – ${fmtDate(endDate)}`
    : fmtDate(startDate)

  const priceLabel = isFreeEvent || minPrice === 0 ? 'Free Entry' : `From ${fmtINR(minPrice)}`

  const fi = (delay = 0) => ({
    initial:    { opacity: 0, y: 20 },
    animate:    { opacity: 1, y: 0 },
    transition: { duration: 0.6, delay, ease: [0.22, 1, 0.36, 1] as const },
  })

  return (
    <section className="relative isolate min-h-[560px] overflow-hidden bg-gray-950 sm:min-h-[640px]">

      {/* Banner image with overlay */}
      {bannerUrl?.trim() ? (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={bannerUrl}
            alt={title}
            className="absolute inset-0 h-full w-full object-cover opacity-30"
          />
          <div className="absolute inset-0 bg-gradient-to-b from-gray-950/60 via-gray-950/70 to-gray-950/90" />
        </>
      ) : (
        <div className="absolute inset-0 bg-gradient-to-br from-violet-950 via-purple-950 to-rose-950" />
      )}

      {/* Decorative ambient glow */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -left-40 -top-40 size-[500px] rounded-full bg-violet-600/10 blur-3xl" />
        <div className="absolute -bottom-20 -right-20 size-[400px] rounded-full bg-rose-600/10 blur-3xl" />
        <div className="absolute left-1/2 top-1/4 size-[300px] -translate-x-1/2 rounded-full bg-amber-500/8 blur-2xl" />
      </div>

      <div className="relative mx-auto max-w-7xl px-4 pb-16 pt-16 sm:px-6 sm:pb-20 sm:pt-20 lg:px-8">

        {/* Type badge */}
        <motion.div {...fi(0)} className="mb-5">
          <span className="inline-flex items-center gap-2 rounded-full border border-violet-400/30 bg-violet-400/10 px-4 py-1.5 backdrop-blur-sm">
            <Sparkles className="size-3 text-amber-400" aria-hidden />
            <span className="text-[11px] font-bold uppercase tracking-[0.22em] text-violet-300">
              {eventSubtype ?? 'Cultural Festival'}
            </span>
          </span>
        </motion.div>

        {/* Title */}
        <motion.h1
          {...fi(0.06)}
          className="mb-4 max-w-3xl text-[2.25rem] font-black leading-[1.06] tracking-[-0.03em] text-white sm:text-[3.5rem] lg:text-[4.25rem]"
        >
          {title}
        </motion.h1>

        {tagline && (
          <motion.p {...fi(0.11)} className="mb-7 max-w-xl text-[1.0625rem] leading-relaxed text-white/60">
            {tagline}
          </motion.p>
        )}

        {/* Date + Venue chips */}
        <motion.div {...fi(0.14)} className="mb-6 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
          {dateLabel && (
            <div className="flex items-center gap-2.5 text-sm text-white/70">
              <Calendar className="size-4 shrink-0 text-amber-400" aria-hidden />
              <span className="font-medium">{dateLabel}</span>
            </div>
          )}
          {locText && (
            <div className="flex items-center gap-2.5 text-sm text-white/70 sm:ml-4">
              <MapPin className="size-4 shrink-0 text-rose-400" aria-hidden />
              <span className="font-medium">{locText}</span>
            </div>
          )}
        </motion.div>

        {/* Performer count strip */}
        {performerCount > 0 && (
          <motion.div {...fi(0.17)} className="mb-7">
            <span className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm text-white/60 backdrop-blur-sm">
              <span className="text-base font-black text-amber-400">{performerCount}</span>
              Performing Artists
            </span>
          </motion.div>
        )}

        {/* CTA */}
        <motion.div {...fi(0.20)} className="flex flex-wrap items-center gap-4">
          {registrationOpen && active.length > 0 ? (
            <>
              <Link
                href="#tickets"
                className="inline-flex items-center gap-2.5 rounded-full bg-amber-400 px-7 py-3.5 text-[0.9375rem] font-black text-gray-950 shadow-lg shadow-amber-400/30 transition-all duration-200 hover:bg-amber-300 active:scale-[0.97]"
              >
                Get Tickets
                <ArrowRight className="size-4" aria-hidden />
              </Link>
              <span className="text-sm font-medium text-white/50">{priceLabel}</span>
            </>
          ) : active.length > 0 ? (
            <span className="inline-flex items-center rounded-full border border-white/20 bg-white/10 px-6 py-3 text-sm font-semibold text-white/60 backdrop-blur-sm">
              Tickets Closed
            </span>
          ) : (
            <Link
              href="#lineup"
              className="inline-flex items-center gap-2.5 rounded-full bg-amber-400 px-7 py-3.5 text-[0.9375rem] font-black text-gray-950 transition-all hover:bg-amber-300"
            >
              See Lineup
              <ArrowRight className="size-4" aria-hidden />
            </Link>
          )}
        </motion.div>

      </div>
    </section>
  )
}
