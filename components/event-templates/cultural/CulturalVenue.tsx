'use client'

import { motion } from 'framer-motion'
import { MapPin, ExternalLink, Navigation, Car, Bus, Train } from 'lucide-react'
import type { PhysicalVenueConfig, VenueMaps } from '@/components/wizard/eventDetailsConfig'
import { VenueMapTabs } from '@/components/event-templates/shared/venue/VenueMapTabs'

// ─── Props ─────────────────────────────────────────────────────────────────────

interface CulturalVenueProps {
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

export function CulturalVenue({ venueName, physical, venueMaps }: CulturalVenueProps) {
  if (!venueName && !physical) return null

  const mapsUrl = physical?.mapsLink?.trim()
    ?? (physical ? buildMapsUrl(physical, venueName) : null)

  const addressParts = physical
    ? [physical.addressLine1, physical.addressLine2].filter(Boolean).join(', ')
    : null

  const cityLine = physical
    ? [physical.city, physical.state, physical.country].filter(Boolean).join(', ')
    : null

  const transport = [
    { Icon: Car,   label: 'By Car',    desc: 'Parking available on-site and nearby. Festival shuttle from overflow lots.' },
    { Icon: Bus,   label: 'By Bus',    desc: 'Multiple bus routes stop nearby. Check local transit for schedule.' },
    { Icon: Train, label: 'By Train',  desc: 'Nearest rail/metro station within walking or shuttle distance.' },
  ]

  return (
    <section id="venue" className="bg-gray-900 py-14 sm:py-18">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">

        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.1 }}
          transition={{ duration: 0.5 }}
          className="mb-8"
        >
          <p className="mb-1.5 text-[11px] font-bold uppercase tracking-[0.22em] text-amber-400">
            Location
          </p>
          <h2 className="text-2xl font-black tracking-tight text-white sm:text-[2rem]">
            Venue &amp; Directions
          </h2>
        </motion.div>

        <div className="grid gap-6 lg:grid-cols-[1fr_280px]">

          {/* Left */}
          <div className="space-y-5">
            {/* Address card */}
            <motion.div
              initial={{ opacity: 0, x: -10 }}
              whileInView={{ opacity: 1, x: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.45 }}
              className="rounded-2xl border border-white/10 bg-gray-950 p-6"
            >
              <div className="mb-3 flex size-10 items-center justify-center rounded-xl bg-violet-500/20">
                <MapPin className="size-5 text-violet-400" aria-hidden />
              </div>
              <h3 className="text-[1.0625rem] font-black text-white">{venueName}</h3>
              {addressParts && <p className="mt-1 text-sm text-white/40">{addressParts}</p>}
              {cityLine && <p className="text-sm text-white/30">{cityLine}</p>}
              {mapsUrl && (
                <a
                  href={mapsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-4 inline-flex items-center gap-2 rounded-full bg-amber-400 px-5 py-2 text-[0.875rem] font-bold text-gray-950 transition-all hover:bg-amber-300"
                >
                  <Navigation className="size-3.5" aria-hidden />
                  Get Directions
                  <ExternalLink className="size-3" aria-hidden />
                </a>
              )}
            </motion.div>

            {/* Venue notes */}
            {physical?.instructions?.trim() && (
              <motion.div
                initial={{ opacity: 0, x: -10 }}
                whileInView={{ opacity: 1, x: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.4, delay: 0.05 }}
                className="rounded-2xl border border-white/10 bg-gray-950 p-5"
              >
                <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.14em] text-white/30">
                  Entry Notes
                </p>
                <p className="whitespace-pre-line text-[0.875rem] leading-relaxed text-white/50">
                  {physical.instructions}
                </p>
              </motion.div>
            )}

            {/* Transport */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              {transport.map(({ Icon, label, desc }, i) => (
                <motion.div
                  key={label}
                  initial={{ opacity: 0, y: 10 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true }}
                  transition={{ duration: 0.3, delay: i * 0.07 }}
                  className="rounded-xl border border-white/10 bg-gray-950 p-4"
                >
                  <div className="mb-2 flex size-8 items-center justify-center rounded-lg bg-violet-500/15">
                    <Icon className="size-4 text-violet-400" aria-hidden />
                  </div>
                  <p className="mb-1 text-[0.8125rem] font-bold text-white">{label}</p>
                  <p className="text-[12px] leading-relaxed text-white/40">{desc}</p>
                </motion.div>
              ))}
            </div>
          </div>

          {/* Right — map link card */}
          <motion.div
            initial={{ opacity: 0, scale: 0.97 }}
            whileInView={{ opacity: 1, scale: 1 }}
            viewport={{ once: true }}
            transition={{ duration: 0.45 }}
            className="overflow-hidden rounded-2xl border border-white/10 bg-gray-950 lg:self-start"
          >
            {mapsUrl ? (
              <a
                href={mapsUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="group flex min-h-[260px] flex-col items-center justify-center gap-4 p-8 text-center transition-all hover:bg-white/3"
              >
                <div className="flex size-14 items-center justify-center rounded-2xl bg-violet-500/15 ring-1 ring-violet-400/20 transition-all group-hover:bg-violet-500/25">
                  <MapPin className="size-7 text-violet-400" aria-hidden />
                </div>
                <div>
                  <p className="text-sm font-bold text-violet-300">Open in Maps</p>
                  <p className="text-[12px] text-white/30">{venueName}</p>
                </div>
                <span className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[12px] font-semibold text-white/50 group-hover:border-white/20">
                  View Map
                  <ExternalLink className="size-3" aria-hidden />
                </span>
              </a>
            ) : (
              <div className="flex min-h-[260px] flex-col items-center justify-center gap-2 p-8 text-center">
                <MapPin className="size-10 text-white/10" aria-hidden />
                <p className="text-sm font-semibold text-white/20">Venue map coming soon</p>
              </div>
            )}
          </motion.div>

        </div>

        <VenueMapTabs venueMaps={venueMaps ?? null} venueName={venueName} />

      </div>
    </section>
  )
}
