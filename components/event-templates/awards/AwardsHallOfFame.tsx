'use client'

import { motion } from 'framer-motion'
import { Crown, Sparkles } from 'lucide-react'
import type { PastWinner } from '@/components/wizard/eventDetailsConfig'

// ─── Props ─────────────────────────────────────────────────────────────────────

interface AwardsHallOfFameProps {
  pastWinners: PastWinner[]
}

// ─── Component ─────────────────────────────────────────────────────────────────

export function AwardsHallOfFame({ pastWinners }: AwardsHallOfFameProps) {
  if (!pastWinners.length) return null

  return (
    <section className="relative overflow-hidden bg-zinc-900 py-14 sm:py-20">
      {/* Gold glow */}
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute left-0 top-1/2 size-96 -translate-x-1/2 -translate-y-1/2 rounded-full bg-yellow-400/4 blur-3xl" />
        <div className="absolute right-0 top-1/2 size-64 translate-x-1/2 -translate-y-1/2 rounded-full bg-yellow-400/3 blur-3xl" />
      </div>

      <div className="relative mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">

        <motion.div
          initial={{ opacity: 0, y: 18 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.1 }}
          transition={{ duration: 0.6 }}
          className="mb-10 text-center"
        >
          <div className="mb-4 flex items-center justify-center gap-2">
            <Crown className="size-5 text-yellow-400" aria-hidden />
            <p className="text-[11px] font-bold uppercase tracking-[0.26em] text-yellow-400">
              Hall of Fame
            </p>
            <Crown className="size-5 text-yellow-400" aria-hidden />
          </div>
          <h2 className="text-2xl font-black tracking-tight text-white sm:text-[2.25rem]">
            Previous Winners
          </h2>
          <p className="mx-auto mt-3 max-w-xl text-base text-zinc-400">
            Celebrating the extraordinary individuals and organisations recognised at past editions.
          </p>
        </motion.div>

        {/* Winner table */}
        <motion.div
          initial={{ opacity: 0, y: 14 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.55 }}
          className="overflow-hidden rounded-2xl border border-zinc-800"
        >
          {/* Table header */}
          <div className="grid grid-cols-3 border-b border-yellow-400/15 bg-yellow-400/5 px-5 py-3 sm:grid-cols-4">
            {['Year', 'Category', 'Winner', 'Organisation'].map((h, i) => (
              <p key={h} className={`text-[10.5px] font-bold uppercase tracking-[0.18em] text-yellow-400/60 ${
                i >= 2 ? 'hidden sm:block' : ''
              }`}>
                {h}
              </p>
            ))}
          </div>

          {/* Rows */}
          {pastWinners.map((w, i) => (
            <motion.div
              key={w.id}
              initial={{ opacity: 0, x: -8 }}
              whileInView={{ opacity: 1, x: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.3, delay: i * 0.05 }}
              className={`grid grid-cols-3 items-center gap-x-4 px-5 py-3.5 sm:grid-cols-4 ${
                i < pastWinners.length - 1 ? 'border-b border-zinc-800/80' : ''
              } ${i % 2 === 0 ? 'bg-zinc-950' : 'bg-zinc-900'}`}
            >
              <span className="inline-flex items-center gap-1.5 text-[12.5px] font-bold text-zinc-500">
                <Sparkles className="size-3 text-yellow-400/50" aria-hidden />
                {w.year}
              </span>
              <p className="text-[0.8125rem] font-semibold text-white">{w.category}</p>
              <p className="hidden text-[0.8125rem] text-zinc-300 sm:block">{w.winner}</p>
              <p className="hidden text-[0.8125rem] text-zinc-500 sm:block">{w.organisation}</p>
            </motion.div>
          ))}
        </motion.div>

      </div>
    </section>
  )
}
