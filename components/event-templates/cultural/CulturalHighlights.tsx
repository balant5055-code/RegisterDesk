'use client'

import { motion } from 'framer-motion'
import { Sparkles } from 'lucide-react'
import type { CulturalHighlight } from '@/components/wizard/eventDetailsConfig'

// ─── Color palette (cycles) ────────────────────────────────────────────────────

const COLORS = [
  { bg: 'bg-violet-500/10', border: 'border-violet-500/20', fg: 'text-violet-300', from: 'from-violet-500', to: 'to-purple-600' },
  { bg: 'bg-amber-500/10',  border: 'border-amber-500/20',  fg: 'text-amber-300',  from: 'from-amber-500',  to: 'to-orange-500' },
  { bg: 'bg-rose-500/10',   border: 'border-rose-500/20',   fg: 'text-rose-300',   from: 'from-rose-500',   to: 'to-pink-600'   },
  { bg: 'bg-teal-500/10',   border: 'border-teal-500/20',   fg: 'text-teal-300',   from: 'from-teal-500',   to: 'to-cyan-600'   },
  { bg: 'bg-blue-500/10',   border: 'border-blue-500/20',   fg: 'text-blue-300',   from: 'from-blue-500',   to: 'to-indigo-600' },
  { bg: 'bg-emerald-500/10',border: 'border-emerald-500/20',fg: 'text-emerald-300',from: 'from-emerald-500',to: 'to-green-600'  },
]

// ─── Props ─────────────────────────────────────────────────────────────────────

interface CulturalHighlightsProps {
  highlights: CulturalHighlight[]
}

// ─── Component ─────────────────────────────────────────────────────────────────

export function CulturalHighlights({ highlights }: CulturalHighlightsProps) {
  if (!highlights.length) return null

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
            Festival Highlights
          </p>
          <h2 className="text-2xl font-black tracking-tight text-white sm:text-[2rem]">
            What&apos;s at the Festival
          </h2>
          <p className="mt-2 text-base text-white/40">
            A complete cultural experience packed into one spectacular event.
          </p>
        </motion.div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {highlights.map((h, i) => {
            const c = COLORS[i % COLORS.length]!
            return (
              <motion.div
                key={h.id}
                initial={{ opacity: 0, y: 16 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.45, delay: i * 0.08 }}
                className={`relative overflow-hidden rounded-2xl border ${c.border} ${c.bg} p-6`}
              >
                <div className={`absolute -right-8 -top-8 size-28 rounded-full bg-gradient-to-br ${c.from} ${c.to} opacity-[0.07] blur-2xl`} />
                <div className={`relative mb-4 flex size-11 items-center justify-center rounded-xl bg-gradient-to-br ${c.from} ${c.to}`}>
                  <Sparkles className="size-5 text-white" aria-hidden />
                </div>
                <h3 className="mb-2 text-[1.0625rem] font-black text-white">{h.label}</h3>
                <p className={`text-[0.875rem] leading-relaxed ${c.fg} opacity-80`}>{h.desc}</p>
              </motion.div>
            )
          })}
        </div>

      </div>
    </section>
  )
}
