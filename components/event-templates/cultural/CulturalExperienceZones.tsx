'use client'

import { motion } from 'framer-motion'
import { Star } from 'lucide-react'
import type { CulturalZone } from '@/components/wizard/eventDetailsConfig'

// ─── Color palette (cycles) ────────────────────────────────────────────────────

const COLORS = [
  { from: 'from-amber-500',   to: 'to-orange-500',  glow: 'bg-amber-500/10',   fg: 'text-amber-300'   },
  { from: 'from-rose-400',    to: 'to-pink-600',    glow: 'bg-rose-500/10',    fg: 'text-rose-300'    },
  { from: 'from-violet-500',  to: 'to-purple-600',  glow: 'bg-violet-500/10',  fg: 'text-violet-300'  },
  { from: 'from-teal-500',    to: 'to-cyan-600',    glow: 'bg-teal-500/10',    fg: 'text-teal-300'    },
  { from: 'from-blue-500',    to: 'to-indigo-600',  glow: 'bg-blue-500/10',    fg: 'text-blue-300'    },
  { from: 'from-emerald-500', to: 'to-green-600',   glow: 'bg-emerald-500/10', fg: 'text-emerald-300' },
]

// ─── Props ─────────────────────────────────────────────────────────────────────

interface CulturalExperienceZonesProps {
  experienceZones: CulturalZone[]
}

// ─── Component ─────────────────────────────────────────────────────────────────

export function CulturalExperienceZones({ experienceZones }: CulturalExperienceZonesProps) {
  if (!experienceZones.length) return null

  return (
    <section className="bg-gray-900 py-14 sm:py-18">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">

        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.1 }}
          transition={{ duration: 0.5 }}
          className="mb-10"
        >
          <p className="mb-1.5 text-[11px] font-bold uppercase tracking-[0.22em] text-amber-400">
            Explore
          </p>
          <h2 className="text-2xl font-black tracking-tight text-white sm:text-[2rem]">
            Experience Zones
          </h2>
          <p className="mt-2 text-base text-white/40">
            Beyond the stage — there&apos;s something for everyone.
          </p>
        </motion.div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {experienceZones.map((z, i) => {
            const c = COLORS[i % COLORS.length]!
            return (
              <motion.div
                key={z.id}
                initial={{ opacity: 0, y: 14 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.4, delay: i * 0.07 }}
                className={`rounded-2xl border border-white/10 ${c.glow} p-5`}
              >
                <div className={`mb-4 flex size-10 items-center justify-center rounded-xl bg-gradient-to-br ${c.from} ${c.to}`}>
                  <Star className="size-5 text-white" aria-hidden />
                </div>
                <h3 className="mb-1.5 text-[1rem] font-black text-white">{z.name}</h3>
                <p className={`text-[0.875rem] leading-relaxed ${c.fg} opacity-70`}>{z.desc}</p>
              </motion.div>
            )
          })}
        </div>

      </div>
    </section>
  )
}
