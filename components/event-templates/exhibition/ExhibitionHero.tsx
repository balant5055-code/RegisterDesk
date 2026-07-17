'use client'

import Link from 'next/link'
import { motion } from 'framer-motion'
import { Calendar, MapPin, ArrowRight, Building2, Users, Layers } from 'lucide-react'
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

export interface ExhibitionHeroProps {
  title:             string
  tagline:           string
  eventSubtype?:     string
  bannerUrl:         string
  startDate:         string
  endDate:           string
  venueName:         string
  physical?:         PhysicalVenueConfig
  exhibitorCount:    number
  totalAttendees:    number
  showAttendeeCount: boolean
  registrationOpen:  boolean
  isFreeEvent:       boolean
  passes:            PassPublic[]
  slug:              string
}

// ─── Component ─────────────────────────────────────────────────────────────────

export function ExhibitionHero({
  title, tagline, eventSubtype, bannerUrl,
  startDate, endDate, venueName, physical,
  exhibitorCount, totalAttendees, showAttendeeCount,
  registrationOpen, isFreeEvent, passes, slug,
}: ExhibitionHeroProps) {
  const activePasses = passes.filter(p => p.status !== 'inactive')
  const minPrice     = activePasses.length > 0 ? Math.min(...activePasses.map(p => p.price)) : 0
  const locationText = physical?.city ? `${venueName}, ${physical.city}` : venueName

  const dateLabel = endDate && endDate !== startDate
    ? `${fmtDate(startDate)} – ${fmtDate(endDate)}`
    : fmtDate(startDate)

  const priceLabel = isFreeEvent || minPrice === 0 ? 'Free Entry' : `From ${fmtINR(minPrice)}`

  const scalePills = [
    exhibitorCount > 0 && { icon: Building2, val: `${exhibitorCount}+`, label: 'Exhibitors' },
    (showAttendeeCount && totalAttendees > 0) && { icon: Users, val: totalAttendees.toLocaleString('en-IN'), label: 'Visitors' },
  ].filter(Boolean) as { icon: typeof Building2; val: string; label: string }[]

  const fi = (delay = 0) => ({
    initial:    { opacity: 0, y: 18 },
    animate:    { opacity: 1, y: 0 },
    transition: { duration: 0.5, delay, ease: [0.25, 0, 0, 1] as const },
  })

  return (
    <section className="bg-white">
      <div className="mx-auto max-w-7xl px-4 pb-0 pt-10 sm:px-6 sm:pt-14 lg:px-8">

        <div className="grid items-center gap-8 lg:grid-cols-[1fr_45%] lg:gap-12">

          {/* ── Left ── */}
          <div className="order-2 lg:order-1">

            {/* Category badge */}
            <motion.div {...fi(0)} className="mb-4">
              <span className="inline-flex items-center gap-2 rounded-full border border-teal-200 bg-teal-50 px-3.5 py-1.5">
                <Layers className="size-3 text-teal-500" aria-hidden />
                <span className="text-[11px] font-bold uppercase tracking-[0.20em] text-teal-600">
                  {eventSubtype ?? 'Exhibition'}
                </span>
              </span>
            </motion.div>

            <motion.h1
              {...fi(0.06)}
              className="mb-3 text-[2rem] font-black leading-[1.08] tracking-[-0.03em] text-gray-950 sm:text-[2.75rem] lg:text-[3.25rem]"
            >
              {title}
            </motion.h1>

            {tagline && (
              <motion.p {...fi(0.10)} className="mb-6 text-[1.0625rem] leading-relaxed text-gray-500">
                {tagline}
              </motion.p>
            )}

            {/* Date + Venue */}
            <motion.div {...fi(0.13)} className="mb-5 flex flex-col gap-3">
              <div className="flex items-center gap-3 text-sm text-gray-600">
                <div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-teal-50">
                  <Calendar className="size-3.5 text-teal-600" aria-hidden />
                </div>
                <span className="font-medium">{dateLabel}</span>
              </div>
              {locationText && (
                <div className="flex items-center gap-3 text-sm text-gray-600">
                  <div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-teal-50">
                    <MapPin className="size-3.5 text-teal-600" aria-hidden />
                  </div>
                  <span className="font-medium">{locationText}</span>
                </div>
              )}
            </motion.div>

            {/* Scale pills */}
            {scalePills.length > 0 && (
              <motion.div {...fi(0.16)} className="mb-6 flex flex-wrap gap-3">
                {scalePills.map(({ icon: Icon, val, label }) => (
                  <div
                    key={label}
                    className="flex items-center gap-2.5 rounded-xl border border-gray-100 bg-gray-50 px-4 py-2.5"
                  >
                    <Icon className="size-4 text-teal-500" aria-hidden />
                    <div>
                      <p className="text-[1.125rem] font-black leading-none text-gray-900">{val}</p>
                      <p className="text-[11px] text-gray-400">{label}</p>
                    </div>
                  </div>
                ))}
              </motion.div>
            )}

            <motion.div {...fi(0.18)} className="mb-5 h-px bg-gray-100" />

            {/* CTA */}
            <motion.div {...fi(0.21)} className="flex flex-wrap items-center gap-4">
              {registrationOpen && activePasses.length > 0 ? (
                <>
                  <Link
                    href="#register"
                    className="inline-flex items-center gap-2.5 rounded-full bg-teal-600 px-7 py-3.5 text-[0.9375rem] font-bold text-white shadow-md shadow-teal-600/20 transition-all duration-200 hover:bg-teal-700 active:scale-[0.97]"
                  >
                    Register to Visit
                    <ArrowRight className="size-4" aria-hidden />
                  </Link>
                  <span className="text-sm font-medium text-gray-400">{priceLabel}</span>
                </>
              ) : activePasses.length > 0 ? (
                <span className="inline-flex items-center rounded-full bg-gray-100 px-5 py-2.5 text-sm font-semibold text-gray-500">
                  Registration Closed
                </span>
              ) : (
                <Link
                  href="#floor-plan"
                  className="inline-flex items-center gap-2 rounded-full bg-teal-600 px-7 py-3.5 text-[0.9375rem] font-bold text-white transition-all hover:bg-teal-700"
                >
                  Explore Exhibition
                  <ArrowRight className="size-4" aria-hidden />
                </Link>
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
            <div className="relative overflow-hidden rounded-2xl bg-gray-100 shadow-[0_16px_56px_-12px_rgba(0,0,0,0.14)] ring-1 ring-black/[0.05] sm:aspect-[16/10] lg:aspect-[4/3]">
              {bannerUrl?.trim() ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={bannerUrl} alt={title} className="h-full min-h-[200px] w-full object-cover" />
              ) : (
                <div className="flex h-full min-h-[200px] w-full flex-col items-center justify-center bg-gradient-to-br from-teal-500 to-teal-700">
                  <Building2 className="size-14 text-white/20" aria-hidden />
                </div>
              )}
              <span className={`absolute left-3 top-3 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold backdrop-blur-sm ${
                registrationOpen ? 'bg-teal-600/90 text-white' : 'bg-black/40 text-white'
              }`}>
                <span className={`size-1.5 rounded-full ${registrationOpen ? 'bg-white/90' : 'bg-gray-300'}`} aria-hidden />
                {registrationOpen ? 'Registration Open' : 'Registration Closed'}
              </span>
            </div>
          </motion.div>

        </div>

        <div className="mt-10 border-t border-gray-100" />
      </div>
    </section>
  )
}
