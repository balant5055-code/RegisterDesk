'use client'

import { motion } from 'framer-motion'
import { MapPin, Navigation, Globe, ExternalLink } from 'lucide-react'
import type {
  PhysicalVenueConfig, OnlineVenueConfig, VenueMaps,
} from '@/components/wizard/eventDetailsConfig'
import { ONLINE_PLATFORM_LABELS } from '@/components/wizard/eventDetailsConfig'

type VenueType = 'physical' | 'online' | 'hybrid'

export function CommunityVenue({
  venueType, physical, online, mapsLink, venueMaps,
}: {
  venueType: VenueType
  physical?:  PhysicalVenueConfig
  online?:    OnlineVenueConfig
  mapsLink:   string
  venueMaps:  VenueMaps | null
}) {
  const showPhysical = (venueType === 'physical' || venueType === 'hybrid') && physical?.name?.trim()
  const showOnline   = (venueType === 'online'   || venueType === 'hybrid') && online?.platform

  if (!showPhysical && !showOnline) return null

  const resolvedMapUrl =
    mapsLink?.trim() ||
    venueMaps?.layoutImageUrl?.trim() ||
    physical?.mapsLink?.trim() ||
    (physical?.city
      ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
          [physical.name, physical.addressLine1, physical.city, physical.country]
            .filter(Boolean).join(', ')
        )}`
      : undefined)

  const addressLines = physical
    ? [
        physical.addressLine1,
        physical.addressLine2,
        [physical.city, physical.state, physical.pincode].filter(Boolean).join(' '),
        physical.country,
      ].filter(Boolean)
    : []

  return (
    <section id="venue" className="bg-white py-10 sm:py-14">
      <div className="mx-auto max-w-5xl px-5 sm:px-10">

        <motion.div
          initial={{ opacity: 0, y: 10 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.2 }}
          transition={{ duration: 0.5 }}
          className="mb-7"
        >
          <p className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.2em] text-primary">
            Location
          </p>
          <h2 className="text-[1.25rem] font-black tracking-tight text-gray-900 sm:text-[1.625rem]">
            Where it&apos;s happening
          </h2>
        </motion.div>

        {/* Physical venue */}
        {showPhysical && (
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.5 }}
            className="grid gap-4 sm:grid-cols-[1fr_auto]"
          >
            {/* Info card */}
            <div className="flex gap-4 rounded-2xl bg-gray-50 p-5 ring-1 ring-black/5 sm:p-6">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-white ring-1 ring-black/5">
                <MapPin className="size-4 text-gray-600" aria-hidden />
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="text-[0.9375rem] font-black leading-tight text-gray-900">
                  {physical!.name}
                </h3>
                {addressLines.map((line, i) => (
                  <p key={i} className="mt-0.5 text-[0.8125rem] text-gray-500">{line}</p>
                ))}
                {physical!.instructions?.trim() && (
                  <p className="mt-3 border-t border-gray-200 pt-3 text-[0.8125rem] leading-relaxed text-gray-500">
                    {physical!.instructions}
                  </p>
                )}
                {resolvedMapUrl && (
                  <a
                    href={resolvedMapUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-4 inline-flex items-center gap-1.5 text-[0.8125rem] font-bold text-gray-900 transition-colors hover:text-gray-600"
                  >
                    <Navigation className="size-3.5" aria-hidden />
                    Get Directions
                  </a>
                )}
              </div>
            </div>

            {/* Map placeholder — links to maps */}
            {resolvedMapUrl && (
              <a
                href={resolvedMapUrl}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="View on map"
                className="group hidden sm:flex flex-col items-center justify-center w-[180px] shrink-0 overflow-hidden rounded-2xl bg-gray-50 ring-1 ring-black/5 transition-all hover:ring-black/10 hover:shadow-md"
              >
                {/* Dot grid */}
                <svg
                  aria-hidden
                  className="absolute size-full opacity-30"
                  style={{ position: 'absolute', width: '100%', height: '100%' }}
                  xmlns="http://www.w3.org/2000/svg"
                >
                  <defs>
                    <pattern id="vmap-dots" width="12" height="12" patternUnits="userSpaceOnUse">
                      <circle cx="2" cy="2" r="1" fill="#d1d5db" />
                    </pattern>
                  </defs>
                  <rect width="100%" height="100%" fill="url(#vmap-dots)" />
                </svg>
                <div className="relative z-10 flex flex-col items-center gap-2 p-6 text-center">
                  <div className="flex size-11 items-center justify-center rounded-full bg-white shadow-md ring-1 ring-black/10">
                    <MapPin className="size-5 fill-rose-50 text-rose-500" aria-hidden />
                  </div>
                  <p className="text-[0.75rem] font-bold text-gray-500 transition-colors group-hover:text-gray-900">
                    Open in Maps
                  </p>
                </div>
              </a>
            )}
          </motion.div>
        )}

        {/* Online venue */}
        {showOnline && (
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.5, delay: showPhysical ? 0.1 : 0 }}
            className={showPhysical ? 'mt-4' : ''}
          >
            <div className="flex items-start gap-4 rounded-2xl bg-gray-50 p-5 ring-1 ring-black/5 sm:p-6">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-white ring-1 ring-black/5">
                <Globe className="size-4 text-gray-600" aria-hidden />
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="text-[0.9375rem] font-black text-gray-900">
                  {ONLINE_PLATFORM_LABELS[online!.platform] ?? online!.platform}
                  {online!.platformCustomName?.trim() && ` · ${online!.platformCustomName}`}
                </h3>
                <p className="mt-1 text-[0.8125rem] leading-relaxed text-gray-500">
                  {online!.revealAfterRegistration
                    ? 'Joining link will be sent after registration.'
                    : (online!.joinInstructions?.trim() || 'Link shared ahead of the event.')}
                </p>
                {online!.meetingUrl?.trim() && !online!.revealAfterRegistration && (
                  <a
                    href={online!.meetingUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-white px-3.5 py-2 text-[0.8125rem] font-bold text-gray-700 ring-1 ring-black/8 transition-all hover:ring-black/14 hover:shadow-sm active:scale-[0.98]"
                  >
                    Join Online
                    <ExternalLink className="size-3.5" aria-hidden />
                  </a>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </div>
    </section>
  )
}
