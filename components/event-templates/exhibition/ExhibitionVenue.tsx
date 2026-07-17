'use client'

import { motion } from 'framer-motion'
import { MapPin, ExternalLink, Navigation, Bus, Train, Car } from 'lucide-react'
import type { PhysicalVenueConfig, VenueMaps } from '@/components/wizard/eventDetailsConfig'
import { VenueMapTabs } from '@/components/event-templates/shared/venue/VenueMapTabs'

// ─── Props ─────────────────────────────────────────────────────────────────────

interface ExhibitionVenueProps {
  venueName:  string
  physical?:  PhysicalVenueConfig
  venueMaps?: VenueMaps | null
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function buildMapsUrl(p: PhysicalVenueConfig, name: string) {
  const parts = [name, p.addressLine1, p.addressLine2, p.city, p.state, p.country]
    .filter(Boolean)
    .join(', ')
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(parts)}`
}

// ─── Component ─────────────────────────────────────────────────────────────────

export function ExhibitionVenue({ venueName, physical, venueMaps }: ExhibitionVenueProps) {
  if (!venueName && !physical) return null

  const mapsUrl = physical?.mapsLink?.trim()
    ?? (physical ? buildMapsUrl(physical, venueName) : null)

  const addressParts = physical
    ? [physical.addressLine1, physical.addressLine2, physical.city, physical.state]
        .filter(Boolean)
        .join(', ')
    : null

  const transport = [
    { Icon: Car,  label: 'By Car',       desc: 'Paid parking available on-site. Shuttle from remote lots every 15 min.' },
    { Icon: Bus,  label: 'By Bus',       desc: 'Multiple bus routes stop outside the main gate. Check local transit.' },
    { Icon: Train,label: 'By Metro/Rail',desc: 'Nearest metro station within walking distance of the venue.' },
  ]

  return (
    <section id="venue" className="bg-gray-50 py-14 sm:py-18">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">

        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.1 }}
          transition={{ duration: 0.45, ease: [0.25, 0, 0, 1] }}
          className="mb-8"
        >
          <p className="mb-1.5 text-[11px] font-bold uppercase tracking-[0.20em] text-teal-600">
            Location
          </p>
          <h2 className="text-2xl font-black tracking-tight text-gray-950 sm:text-[2rem]">
            Venue &amp; Getting There
          </h2>
        </motion.div>

        <div className="grid gap-6 lg:grid-cols-[1fr_300px]">

          {/* Left — venue info */}
          <motion.div
            initial={{ opacity: 0, x: -10 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.45 }}
            className="space-y-5"
          >
            {/* Venue name + address card */}
            <div className="rounded-2xl border border-gray-100 bg-white p-6">
              <div className="mb-3 flex size-10 items-center justify-center rounded-xl bg-teal-50">
                <MapPin className="size-5 text-teal-600" aria-hidden />
              </div>
              <h3 className="text-[1.0625rem] font-black text-gray-950">{venueName}</h3>
              {addressParts && (
                <p className="mt-1 text-sm text-gray-500">{addressParts}</p>
              )}
              {physical?.city && physical.country && (
                <p className="text-sm text-gray-400">{[physical.city, physical.state, physical.country].filter(Boolean).join(', ')}</p>
              )}
              {mapsUrl && (
                <a
                  href={mapsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-4 inline-flex items-center gap-2 rounded-full bg-teal-600 px-4 py-2 text-[0.875rem] font-semibold text-white transition-all hover:bg-teal-700"
                >
                  <Navigation className="size-3.5" aria-hidden />
                  Get Directions
                  <ExternalLink className="size-3" aria-hidden />
                </a>
              )}
            </div>

            {/* Venue instructions */}
            {physical?.instructions?.trim() && (
              <div className="rounded-2xl border border-gray-100 bg-white p-5">
                <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.14em] text-gray-400">
                  Venue Notes
                </p>
                <p className="whitespace-pre-line text-[0.875rem] leading-relaxed text-gray-600">
                  {physical.instructions}
                </p>
              </div>
            )}

            {/* Transport cards */}
            <div className="grid gap-3 sm:grid-cols-3">
              {transport.map(({ Icon, label, desc }, i) => (
                <motion.div
                  key={label}
                  initial={{ opacity: 0, y: 10 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true }}
                  transition={{ duration: 0.3, delay: i * 0.07 }}
                  className="rounded-xl border border-gray-100 bg-white p-4"
                >
                  <div className="mb-2 flex size-8 items-center justify-center rounded-lg bg-teal-50">
                    <Icon className="size-4 text-teal-600" aria-hidden />
                  </div>
                  <p className="mb-1 text-[0.8125rem] font-bold text-gray-800">{label}</p>
                  <p className="text-[12px] leading-relaxed text-gray-500">{desc}</p>
                </motion.div>
              ))}
            </div>
          </motion.div>

          {/* Right — map embed placeholder */}
          <motion.div
            initial={{ opacity: 0, scale: 0.97 }}
            whileInView={{ opacity: 1, scale: 1 }}
            viewport={{ once: true }}
            transition={{ duration: 0.45 }}
            className="overflow-hidden rounded-2xl border border-gray-100 bg-teal-50/40 lg:self-start"
          >
            {mapsUrl ? (
              <a
                href={mapsUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="group flex min-h-[280px] flex-col items-center justify-center gap-3 p-8 text-center transition-colors hover:bg-teal-50"
              >
                <div className="flex size-14 items-center justify-center rounded-2xl bg-teal-600/10 ring-1 ring-teal-200 transition-all group-hover:bg-teal-600/20">
                  <MapPin className="size-7 text-teal-600" aria-hidden />
                </div>
                <div>
                  <p className="text-sm font-bold text-teal-700">Open in Google Maps</p>
                  <p className="text-[12px] text-teal-500">{venueName}</p>
                </div>
                <span className="inline-flex items-center gap-1 rounded-full border border-teal-200 bg-white px-3 py-1 text-[12px] font-semibold text-teal-600 group-hover:bg-teal-50">
                  View Map
                  <ExternalLink className="size-3" aria-hidden />
                </span>
              </a>
            ) : (
              <div className="flex min-h-[280px] flex-col items-center justify-center gap-2 p-8 text-center">
                <MapPin className="size-10 text-teal-200" aria-hidden />
                <p className="text-sm font-semibold text-teal-400">Venue map coming soon</p>
              </div>
            )}
          </motion.div>

        </div>

        <VenueMapTabs venueMaps={venueMaps ?? null} venueName={venueName} />

      </div>
    </section>
  )
}
