'use client'

import { motion } from 'framer-motion'
import { Trophy, Star } from 'lucide-react'

// ─── Props ─────────────────────────────────────────────────────────────────────

interface AwardCategoriesProps {
  categories: { id: string; name: string; description: string }[]
}

// ─── Static fallbacks ─────────────────────────────────────────────────────────

const FALLBACK_CATEGORIES = [
  { id: '1', name: 'Best Innovation',        description: 'Recognising groundbreaking ideas that solve real problems and create meaningful impact.' },
  { id: '2', name: 'Best Leader',            description: 'Honouring visionary leaders who inspire teams and drive transformational change.' },
  { id: '3', name: 'Best Startup',           description: 'Celebrating early-stage ventures that demonstrate exceptional growth and potential.' },
  { id: '4', name: 'Best NGO / Social Impact', description: 'Recognising organisations making a measurable difference in communities and society.' },
  { id: '5', name: 'Excellence in Education', description: 'Honouring educators, institutions, and initiatives reshaping learning and development.' },
  { id: '6', name: 'Lifetime Achievement',   description: 'A special recognition for individuals whose lifetime of work has left a lasting legacy.' },
]

// ─── Component ─────────────────────────────────────────────────────────────────

export function AwardCategories({ categories }: AwardCategoriesProps) {
  const items = categories.length > 0 ? categories : FALLBACK_CATEGORIES

  return (
    <section id="categories" className="bg-zinc-950 py-14 sm:py-20">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">

        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 18 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.1 }}
          transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
          className="mb-12"
        >
          <div className="mb-3 flex items-center gap-2">
            <div className="h-px w-8 bg-yellow-400/50" />
            <p className="text-[11px] font-bold uppercase tracking-[0.26em] text-yellow-400">
              Award Categories
            </p>
          </div>
          <h2 className="text-2xl font-black tracking-tight text-white sm:text-[2.25rem]">
            This Year's Categories
          </h2>
          <p className="mt-3 max-w-xl text-base text-zinc-400">
            {items.length} award{items.length !== 1 ? 's' : ''} honouring exceptional achievement across industries.
          </p>
        </motion.div>

        {/* Category grid */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((cat, i) => (
            <motion.div
              key={cat.id}
              initial={{ opacity: 0, y: 18 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, amount: 0.05 }}
              transition={{ duration: 0.5, delay: i * 0.07, ease: [0.22, 1, 0.36, 1] }}
              className="group relative overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900 p-6 transition-all duration-300 hover:border-yellow-400/30 hover:bg-zinc-800"
            >
              {/* Top gold line that appears on hover */}
              <div className="absolute inset-x-0 top-0 h-[2px] bg-gradient-to-r from-yellow-400/0 via-yellow-400 to-yellow-400/0 opacity-0 transition-opacity duration-300 group-hover:opacity-100" />

              {/* Trophy icon */}
              <div className="mb-5 flex size-11 items-center justify-center rounded-xl border border-yellow-400/20 bg-yellow-400/8">
                <Trophy className="size-5 text-yellow-400" aria-hidden />
              </div>

              {/* Category number */}
              <p className="mb-1 text-[10.5px] font-bold uppercase tracking-[0.20em] text-zinc-600">
                Category {String(i + 1).padStart(2, '0')}
              </p>

              <h3 className="mb-2 text-[1.0625rem] font-black text-white">{cat.name}</h3>

              {cat.description?.trim() && (
                <p className="text-[0.875rem] leading-relaxed text-zinc-400">{cat.description}</p>
              )}

              {/* Bottom star accent */}
              <div className="mt-5 flex items-center gap-1.5">
                {[...Array(5)].map((_, si) => (
                  <Star
                    key={si}
                    className={`size-2.5 transition-colors duration-300 ${
                      si === 0 ? 'text-yellow-400' : 'text-zinc-700 group-hover:text-zinc-600'
                    }`}
                    fill="currentColor"
                    aria-hidden
                  />
                ))}
              </div>
            </motion.div>
          ))}
        </div>

      </div>
    </section>
  )
}
