'use client'

import { motion } from 'framer-motion'
import { Mic2, ClipboardList, Layers, Users } from 'lucide-react'

interface ConferenceHighlightsProps {
  speakerCount:  number
  sessionCount:  number
  trackCount:    number
  attendeeCount: number
  showAttendees: boolean
}

export function ConferenceHighlights({
  speakerCount, sessionCount, trackCount, attendeeCount, showAttendees,
}: ConferenceHighlightsProps) {
  const items = [
    speakerCount > 0 && {
      icon: Mic2, val: `${speakerCount}+`, label: 'Expert Speakers',
      bg: 'bg-violet-50', fg: 'text-violet-600',
    },
    sessionCount > 0 && {
      icon: ClipboardList, val: `${sessionCount}`, label: 'Curated Sessions',
      bg: 'bg-sky-50', fg: 'text-sky-600',
    },
    trackCount > 0 && {
      icon: Layers, val: `${trackCount}`, label: 'Parallel Tracks',
      bg: 'bg-teal-50', fg: 'text-teal-600',
    },
    (showAttendees && attendeeCount > 0) && {
      icon: Users, val: `${attendeeCount.toLocaleString('en-IN')}+`, label: 'Attendees',
      bg: 'bg-amber-50', fg: 'text-amber-600',
    },
  ].filter(Boolean) as { icon: typeof Mic2; val: string; label: string; bg: string; fg: string }[]

  if (items.length < 2) return null

  const lgCols: Record<number, string> = { 2: 'lg:grid-cols-2', 3: 'lg:grid-cols-3', 4: 'lg:grid-cols-4' }

  return (
    <section className="bg-white py-12">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className={`grid grid-cols-2 gap-4 sm:gap-5 ${lgCols[items.length] ?? 'lg:grid-cols-4'}`}>
          {items.map(({ icon: Icon, val, label, bg, fg }, i) => (
            <motion.div
              key={label}
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, amount: 0.1 }}
              transition={{ duration: 0.45, delay: i * 0.07, ease: [0.25, 0, 0, 1] }}
              className="flex flex-col items-center rounded-2xl border border-gray-100 bg-gray-50 px-4 py-7 text-center"
            >
              <div className={`mb-3 flex size-10 items-center justify-center rounded-xl ${bg}`}>
                <Icon className={`size-5 ${fg}`} aria-hidden />
              </div>
              <p className="text-[2rem] font-black leading-none tracking-tight text-gray-950">
                {val}
              </p>
              <p className="mt-1.5 text-[0.8125rem] font-medium text-gray-500">{label}</p>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  )
}
