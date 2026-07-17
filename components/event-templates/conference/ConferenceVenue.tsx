'use client'

import { motion } from 'framer-motion'
import { MapPin, Navigation, Globe, MonitorPlay, ExternalLink, Info } from 'lucide-react'
import type { PhysicalVenueConfig, OnlineVenueConfig, VenueMaps } from '@/components/wizard/eventDetailsConfig'
import { ONLINE_PLATFORM_LABELS } from '@/components/wizard/eventDetailsConfig'

// ─── Props ─────────────────────────────────────────────────────────────────────

interface ConferenceVenueProps {
  venueType: 'physical' | 'online' | 'hybrid'
  venueName: string
  physical?: PhysicalVenueConfig
  online?:   OnlineVenueConfig
  mapsLink:  string
  venueMaps: VenueMaps | null
}

// ─── Component ─────────────────────────────────────────────────────────────────

export function ConferenceVenue({ venueType, venueName, physical, online, mapsLink, venueMaps }: ConferenceVenueProps) {
  const showPhysical = (venueType === 'physical' || venueType === 'hybrid') && venueName?.trim()
  const showOnline   = (venueType === 'online'   || venueType === 'hybrid') && online?.platform
  if (!showPhysical && !showOnline) return null

  const addressParts = [
    physical?.addressLine1,
    physical?.addressLine2,
    physical?.city,
    physical?.state,
    physical?.pincode,
  ].filter(Boolean)

  const platformLabel = online?.platform
    ? (ONLINE_PLATFORM_LABELS[online.platform] ?? online.platform)
    : ''

  const mapImages = venueMaps ? [
    venueMaps.layoutImageUrl?.trim()  && { label: 'Venue Layout',  url: venueMaps.layoutImageUrl  },
    venueMaps.parkingMapUrl?.trim()   && { label: 'Parking',       url: venueMaps.parkingMapUrl   },
    venueMaps.entryGateMapUrl?.trim() && { label: 'Entry Gates',   url: venueMaps.entryGateMapUrl },
  ].filter(Boolean) as { label: string; url: string }[] : []

  const directionsHref = mapsLink?.trim() || (physical
    ? `https://maps.google.com/?q=${encodeURIComponent([venueName, physical.city, physical.state].filter(Boolean).join(', '))}`
    : '')

  return (
    <section id="venue" className="bg-white py-16 sm:py-20">
      <div className="mx-auto max-w-5xl px-4 sm:px-6 lg:px-8">

        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 18 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.1 }}
          transition={{ duration: 0.5, ease: [0.25, 0, 0, 1] }}
          className="mb-10"
        >
          <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.22em] text-primary">Location</p>
          <h2 className="text-2xl font-black tracking-tight text-gray-950 sm:text-[2rem]">Venue</h2>
        </motion.div>

        <div className="grid gap-5 lg:grid-cols-2">

          {/* Physical venue */}
          {showPhysical && (
            <motion.div
              initial={{ opacity: 0, y: 14 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.45, ease: [0.25, 0, 0, 1] }}
              className="rounded-2xl border border-gray-100 bg-gray-50 p-6"
            >
              <div className="mb-4 flex size-10 items-center justify-center rounded-xl bg-white ring-1 ring-gray-100">
                <MapPin className="size-5 text-primary" aria-hidden />
              </div>
              <h3 className="mb-1 text-[1.0625rem] font-bold text-gray-950">{venueName}</h3>
              {addressParts.length > 0 && (
                <p className="mb-4 text-sm leading-relaxed text-gray-500">
                  {addressParts.join(', ')}
                </p>
              )}
              {directionsHref && (
                <a
                  href={directionsHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-semibold text-gray-700 transition-all hover:border-primary/30 hover:text-primary"
                >
                  <Navigation className="size-3.5" aria-hidden />
                  Get Directions
                  <ExternalLink className="size-3" aria-hidden />
                </a>
              )}
            </motion.div>
          )}

          {/* Online venue */}
          {showOnline && (
            <motion.div
              initial={{ opacity: 0, y: 14 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.45, delay: 0.05, ease: [0.25, 0, 0, 1] }}
              className="rounded-2xl border border-gray-100 bg-gray-50 p-6"
            >
              <div className="mb-4 flex size-10 items-center justify-center rounded-xl bg-white ring-1 ring-gray-100">
                <MonitorPlay className="size-5 text-primary" aria-hidden />
              </div>
              <h3 className="mb-1 text-[1.0625rem] font-bold text-gray-950">Online</h3>
              <p className="mb-4 text-sm text-gray-500">
                Platform: <span className="font-semibold text-gray-700">{platformLabel}</span>
              </p>
              {online?.meetingUrl && !online?.revealAfterRegistration ? (
                <a
                  href={online.meetingUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-semibold text-gray-700 transition-all hover:border-primary/30 hover:text-primary"
                >
                  <Globe className="size-3.5" aria-hidden />
                  Join Link
                  <ExternalLink className="size-3" aria-hidden />
                </a>
              ) : (
                <p className="text-[0.8125rem] leading-relaxed text-gray-500">
                  The event link will be shared with registered attendees via email before the event.
                </p>
              )}
            </motion.div>
          )}

          {/* Getting Here */}
          {showPhysical && physical?.instructions?.trim() && (
            <motion.div
              initial={{ opacity: 0, y: 14 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.45, delay: 0.08, ease: [0.25, 0, 0, 1] }}
              className="rounded-2xl border border-gray-100 bg-gray-50 p-6 lg:col-span-2"
            >
              <div className="mb-4 flex size-10 items-center justify-center rounded-xl bg-white ring-1 ring-gray-100">
                <Info className="size-5 text-primary" aria-hidden />
              </div>
              <h3 className="mb-2 text-[1.0625rem] font-bold text-gray-950">Getting Here</h3>
              <p className="whitespace-pre-line text-[0.875rem] leading-relaxed text-gray-500">
                {physical.instructions}
              </p>
            </motion.div>
          )}

          {/* Venue map images */}
          {mapImages.map((img, i) => (
            <motion.div
              key={img.label}
              initial={{ opacity: 0, y: 14 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.45, delay: (i + 2) * 0.06 }}
              className="overflow-hidden rounded-2xl border border-gray-100"
            >
              <div className="border-b border-gray-100 bg-gray-50 px-4 py-2.5">
                <p className="text-xs font-bold text-gray-600">{img.label}</p>
              </div>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={img.url} alt={img.label} className="h-48 w-full object-cover" loading="lazy" />
            </motion.div>
          ))}

        </div>

      </div>
    </section>
  )
}
