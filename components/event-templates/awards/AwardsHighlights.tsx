'use client'

import { motion } from 'framer-motion'
import { Trophy, Users, Star, HandshakeIcon } from 'lucide-react'

// ─── Props ─────────────────────────────────────────────────────────────────────

interface AwardsHighlightsProps {
  categoryCount: number
  judgesCount:   number
  totalPasses:   number
  sponsorCount:  number
}

// ─── Component ─────────────────────────────────────────────────────────────────

export function AwardsHighlights({
  categoryCount, judgesCount, totalPasses, sponsorCount,
}: AwardsHighlightsProps) {
  const stats = [
    {
      Icon:  Trophy,
      value: categoryCount > 0 ? `${categoryCount}` : '10+',
      label: 'Award Categories',
      sub:   'Across industries',
    },
    {
      Icon:  Users,
      value: judgesCount > 0 ? `${judgesCount}` : '20+',
      label: 'Expert Judges',
      sub:   'Independent jury',
    },
    {
      Icon:  Star,
      value: totalPasses > 0 ? `${totalPasses}+` : '500+',
      label: 'Attendees Expected',
      sub:   'Leaders & decision makers',
    },
    {
      Icon:  HandshakeIcon,
      value: sponsorCount > 0 ? `${sponsorCount}` : '15+',
      label: 'Sponsors & Partners',
      sub:   'Supporting excellence',
    },
  ]

  return (
    <section className="relative overflow-hidden bg-zinc-900 py-14 sm:py-20">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-yellow-400/20 to-transparent" />
        <div className="absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-yellow-400/10 to-transparent" />
      </div>

      <div className="relative mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">

        <motion.div
          initial={{ opacity: 0, y: 18 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.1 }}
          transition={{ duration: 0.6 }}
          className="mb-10 text-center"
        >
          <div className="mb-3 flex items-center justify-center gap-2">
            <div className="h-px w-8 bg-yellow-400/50" />
            <p className="text-[11px] font-bold uppercase tracking-[0.26em] text-yellow-400">
              Event Scale
            </p>
            <div className="h-px w-8 bg-yellow-400/50" />
          </div>
          <h2 className="text-2xl font-black tracking-tight text-white sm:text-[2.25rem]">
            Event Highlights
          </h2>
        </motion.div>

        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {stats.map(({ Icon, value, label, sub }, i) => (
            <motion.div
              key={label}
              initial={{ opacity: 0, y: 18 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5, delay: i * 0.08 }}
              className="flex flex-col items-center rounded-2xl border border-zinc-800 bg-zinc-950 p-6 text-center"
            >
              <div className="mb-4 flex size-12 items-center justify-center rounded-xl border border-yellow-400/20 bg-yellow-400/8">
                <Icon className="size-5.5 text-yellow-400" aria-hidden />
              </div>
              <p className="mb-1 text-[2.5rem] font-black leading-none tracking-tight text-yellow-400">
                {value}
              </p>
              <p className="mb-0.5 text-[0.875rem] font-bold text-white">{label}</p>
              <p className="text-[11.5px] text-zinc-500">{sub}</p>
            </motion.div>
          ))}
        </div>

      </div>
    </section>
  )
}
