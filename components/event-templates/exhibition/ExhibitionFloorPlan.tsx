'use client'

import { motion } from 'framer-motion'
import { Grid3X3, ExternalLink, MapPin } from 'lucide-react'

// ─── Props ─────────────────────────────────────────────────────────────────────

export interface ExhibitionFloorPlanProps {
  floorPlanUrl?: string
  boothInfoUrl?: string
}

// ─── Component ─────────────────────────────────────────────────────────────────

export function ExhibitionFloorPlan({ floorPlanUrl, boothInfoUrl }: ExhibitionFloorPlanProps) {
  const hasImage = !!floorPlanUrl?.trim()
  const hasInfo  = !!boothInfoUrl?.trim()

  if (!hasImage && !hasInfo) return null

  return (
    <section id="floor-plan" className="bg-white py-14 sm:py-18">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">

        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.1 }}
          transition={{ duration: 0.45, ease: [0.25, 0, 0, 1] }}
          className="mb-8 flex flex-wrap items-end justify-between gap-4"
        >
          <div>
            <p className="mb-1.5 text-[11px] font-bold uppercase tracking-[0.20em] text-teal-600">
              Floor Plan
            </p>
            <h2 className="text-2xl font-black tracking-tight text-gray-950 sm:text-[2rem]">
              Exhibition Hall Map
            </h2>
            <p className="mt-2 text-base text-gray-500">
              Navigate the halls and locate exhibitor booths.
            </p>
          </div>
          {hasInfo && (
            <a
              href={boothInfoUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-full border border-gray-200 bg-white px-4 py-2 text-sm font-semibold text-gray-600 transition-all hover:border-gray-300 hover:text-gray-900"
            >
              Booth Allocation
              <ExternalLink className="size-3.5" aria-hidden />
            </a>
          )}
        </motion.div>

        {/* Map image or placeholder */}
        <motion.div
          initial={{ opacity: 0, scale: 0.98 }}
          whileInView={{ opacity: 1, scale: 1 }}
          viewport={{ once: true, amount: 0.05 }}
          transition={{ duration: 0.55, ease: [0.25, 0, 0, 1] }}
        >
          {hasImage ? (
            <div className="overflow-hidden rounded-2xl border border-gray-100 bg-gray-50 shadow-[0_12px_48px_-10px_rgba(0,0,0,0.12)]">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={floorPlanUrl}
                alt="Exhibition hall floor plan"
                className="w-full object-contain"
              />
            </div>
          ) : (
            /* Premium placeholder */
            <div className="overflow-hidden rounded-2xl border border-dashed border-teal-200 bg-teal-50/40">
              <div className="flex min-h-[320px] flex-col items-center justify-center py-16">
                {/* Floor plan grid mockup */}
                <div className="mb-6 grid grid-cols-4 gap-2 opacity-20">
                  {Array.from({ length: 16 }).map((_, i) => (
                    <div
                      key={i}
                      className={`h-8 rounded bg-teal-600 ${
                        i % 5 === 0 ? 'col-span-2' : i % 7 === 0 ? 'row-span-1' : ''
                      }`}
                    />
                  ))}
                </div>
                <Grid3X3 className="mb-3 size-10 text-teal-400" aria-hidden />
                <p className="text-sm font-semibold text-teal-700">Floor plan will be published soon</p>
                <p className="mt-1 text-xs text-teal-500">
                  Check back closer to the event date
                </p>
                {hasInfo && (
                  <a
                    href={boothInfoUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-4 inline-flex items-center gap-1.5 rounded-full bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700"
                  >
                    View Booth Allocation
                    <ExternalLink className="size-3.5" aria-hidden />
                  </a>
                )}
              </div>
            </div>
          )}
        </motion.div>

        {/* Legend */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.38, delay: 0.1 }}
          className="mt-5 flex flex-wrap items-center gap-4"
        >
          {[
            { color: 'bg-teal-500',   label: 'Anchor Exhibitor'   },
            { color: 'bg-amber-400',  label: 'Featured Exhibitor' },
            { color: 'bg-gray-300',   label: 'Standard Exhibitor' },
            { color: 'bg-blue-300',   label: 'Food Court'         },
            { color: 'bg-emerald-400',label: 'Registration'       },
          ].map(({ color, label }) => (
            <div key={label} className="flex items-center gap-2 text-[12px] text-gray-500">
              <div className={`size-3 rounded-sm ${color}`} aria-hidden />
              {label}
            </div>
          ))}
          <div className="ml-auto flex items-center gap-1 text-[12px] text-gray-400">
            <MapPin className="size-3" aria-hidden />
            Booth numbers vary by hall
          </div>
        </motion.div>

      </div>
    </section>
  )
}
