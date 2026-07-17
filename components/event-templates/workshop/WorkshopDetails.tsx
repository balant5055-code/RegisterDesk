'use client'

import { motion } from 'framer-motion'
import { Calendar, Users, Package, Monitor, Code2, Globe } from 'lucide-react'

// ─── Props ─────────────────────────────────────────────────────────────────────

interface WorkshopDetailsProps {
  startDate:         string
  endDate:           string
  venueType:         'physical' | 'online' | 'hybrid'
  batchSize?:        number | null
  materialsIncluded?: string
  softwareRequired?:  string
  eventSubtype?:     string
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function fmtDate(d: string) {
  if (!d) return ''
  const [y, mo, day] = d.split('-').map(Number)
  return new Date(y!, mo! - 1, day!).toLocaleDateString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric',
  })
}

function daysBetween(start: string, end: string): number {
  if (!start) return 0
  const s = new Date(start)
  const e = end ? new Date(end) : s
  return Math.max(1, Math.round((e.getTime() - s.getTime()) / 86400000) + 1)
}

// ─── Component ─────────────────────────────────────────────────────────────────

export function WorkshopDetails({
  startDate, endDate, venueType,
  batchSize, materialsIncluded, softwareRequired, eventSubtype,
}: WorkshopDetailsProps) {
  const days    = daysBetween(startDate, endDate)
  const modeLabel = venueType === 'online' ? 'Online' : venueType === 'hybrid' ? 'Hybrid' : 'In-Person'

  const cards = [
    { Icon: Calendar, label: 'Duration',    value: days === 1 ? '1 Day' : `${days} Days`, sub: startDate ? `${fmtDate(startDate)}${endDate && endDate !== startDate ? ` – ${fmtDate(endDate)}` : ''}` : '' },
    { Icon: Monitor,  label: 'Format',      value: modeLabel,    sub: '' },
    batchSize && { Icon: Users,  label: 'Batch Size',   value: `${batchSize} seats`,  sub: 'Limited seats' },
    eventSubtype && { Icon: Globe,  label: 'Level',   value: eventSubtype,  sub: '' },
    softwareRequired?.trim() && { Icon: Code2,    label: 'Tools / Software', value: softwareRequired.trim(), sub: '' },
    materialsIncluded?.trim() && { Icon: Package,  label: 'Materials',    value: materialsIncluded.trim(), sub: '' },
  ].filter(Boolean) as { Icon: typeof Calendar; label: string; value: string; sub: string }[]

  if (!cards.length) return null

  return (
    <section className="bg-white py-12 sm:py-16">
      <div className="mx-auto max-w-5xl px-4 sm:px-6 lg:px-8">

        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.1 }}
          transition={{ duration: 0.45, ease: [0.25, 0, 0, 1] }}
          className="mb-8"
        >
          <p className="mb-1.5 text-[11px] font-bold uppercase tracking-[0.20em] text-blue-600">
            Details
          </p>
          <h2 className="text-xl font-black tracking-tight text-gray-950 sm:text-2xl">
            Workshop At a Glance
          </h2>
        </motion.div>

        <div className={`grid grid-cols-2 gap-3 sm:gap-4 ${
          cards.length <= 3 ? 'lg:grid-cols-3' : 'lg:grid-cols-4'
        }`}>
          {cards.map(({ Icon, label, value, sub }, i) => (
            <motion.div
              key={label}
              initial={{ opacity: 0, y: 12 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.38, delay: i * 0.06 }}
              className="rounded-xl border border-gray-100 bg-gray-50 p-4"
            >
              <div className="mb-2.5 flex size-8 items-center justify-center rounded-lg bg-blue-50">
                <Icon className="size-4 text-blue-600" aria-hidden />
              </div>
              <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-gray-400">{label}</p>
              <p className="mt-1 text-[0.9375rem] font-bold leading-snug text-gray-900 line-clamp-2">
                {value}
              </p>
              {sub && (
                <p className="mt-0.5 text-[11.5px] text-gray-400">{sub}</p>
              )}
            </motion.div>
          ))}
        </div>

      </div>
    </section>
  )
}
