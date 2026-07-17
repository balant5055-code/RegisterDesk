'use client'

import { motion } from 'framer-motion'
import { Clock, Car, Info, ShieldCheck } from 'lucide-react'

// ─── Props ─────────────────────────────────────────────────────────────────────

export interface ExhibitionVisitorInfoProps {
  visitorInstructions?: string
  parkingInfo?:         string
  startTime?:           string
  endTime?:             string
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function fmtTime(t: string) {
  if (!t) return ''
  const [h, m] = t.split(':').map(Number)
  return `${h! % 12 || 12}:${String(m ?? 0).padStart(2, '0')} ${h! < 12 ? 'AM' : 'PM'}`
}

// ─── Component ─────────────────────────────────────────────────────────────────

export function ExhibitionVisitorInfo({
  visitorInstructions, parkingInfo, startTime, endTime,
}: ExhibitionVisitorInfoProps) {
  const hasInfo = !!(visitorInstructions?.trim() || parkingInfo?.trim() || startTime)
  if (!hasInfo) return null

  const timingText = startTime
    ? `${fmtTime(startTime)}${endTime ? ` – ${fmtTime(endTime)}` : ''}`
    : null

  const cards = [
    timingText && {
      Icon:    Clock,
      bg:      'bg-teal-50',
      fg:      'text-teal-600',
      label:   'Entry Timings',
      content: timingText,
    },
    visitorInstructions?.trim() && {
      Icon:    Info,
      bg:      'bg-blue-50',
      fg:      'text-blue-600',
      label:   'Visitor Instructions',
      content: visitorInstructions.trim(),
    },
    parkingInfo?.trim() && {
      Icon:    Car,
      bg:      'bg-gray-100',
      fg:      'text-gray-600',
      label:   'Parking Information',
      content: parkingInfo.trim(),
    },
    {
      Icon:    ShieldCheck,
      bg:      'bg-emerald-50',
      fg:      'text-emerald-600',
      label:   'Health & Safety',
      content: 'All visitors must carry a valid photo ID. Bags are subject to security screening at the entry gates.',
    },
  ].filter(Boolean) as { Icon: typeof Clock; bg: string; fg: string; label: string; content: string }[]

  const gridCols = cards.length <= 2 ? 'sm:grid-cols-2' : cards.length === 3 ? 'sm:grid-cols-3' : 'sm:grid-cols-2 lg:grid-cols-4'

  return (
    <section className="bg-white py-14 sm:py-18">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">

        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.1 }}
          transition={{ duration: 0.45, ease: [0.25, 0, 0, 1] }}
          className="mb-8"
        >
          <p className="mb-1.5 text-[11px] font-bold uppercase tracking-[0.20em] text-teal-600">
            Visitor Guide
          </p>
          <h2 className="text-2xl font-black tracking-tight text-gray-950 sm:text-[2rem]">
            Visitor Information
          </h2>
          <p className="mt-2 text-base text-gray-500">
            Everything you need to know before you arrive.
          </p>
        </motion.div>

        <div className={`grid grid-cols-1 gap-4 ${gridCols}`}>
          {cards.map(({ Icon, bg, fg, label, content }, i) => (
            <motion.div
              key={label}
              initial={{ opacity: 0, y: 14 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.38, delay: i * 0.08 }}
              className="rounded-xl border border-gray-100 bg-gray-50 p-5"
            >
              <div className={`mb-3 flex size-9 items-center justify-center rounded-xl ${bg}`}>
                <Icon className={`size-4.5 ${fg}`} aria-hidden />
              </div>
              <p className="mb-1.5 text-[11px] font-bold uppercase tracking-[0.14em] text-gray-400">
                {label}
              </p>
              <p className="whitespace-pre-line text-[0.875rem] leading-relaxed text-gray-700">
                {content}
              </p>
            </motion.div>
          ))}
        </div>

      </div>
    </section>
  )
}
