'use client'

import { motion } from 'framer-motion'
import { Tag } from 'lucide-react'
import type { ExhibitionCategory } from '@/components/wizard/eventDetailsConfig'

// ─── Color palette (cycles) ────────────────────────────────────────────────────

const COLORS = [
  { bg: 'bg-blue-50',    fg: 'text-blue-600'    },
  { bg: 'bg-teal-50',    fg: 'text-teal-600'    },
  { bg: 'bg-rose-50',    fg: 'text-rose-600'    },
  { bg: 'bg-green-50',   fg: 'text-green-600'   },
  { bg: 'bg-violet-50',  fg: 'text-violet-600'  },
  { bg: 'bg-emerald-50', fg: 'text-emerald-600' },
  { bg: 'bg-amber-50',   fg: 'text-amber-600'   },
  { bg: 'bg-orange-50',  fg: 'text-orange-600'  },
]

// ─── Props ─────────────────────────────────────────────────────────────────────

interface ExhibitionCategoriesProps {
  exhibitionCategories: ExhibitionCategory[]
}

// ─── Component ─────────────────────────────────────────────────────────────────

export function ExhibitionCategories({ exhibitionCategories }: ExhibitionCategoriesProps) {
  if (!exhibitionCategories.length) return null

  return (
    <section className="bg-gray-50 py-14 sm:py-18">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">

        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.1 }}
          transition={{ duration: 0.45, ease: [0.25, 0, 0, 1] }}
          className="mb-8"
        >
          <p className="mb-1.5 text-[11px] font-bold uppercase tracking-[0.20em] text-teal-600">
            Categories
          </p>
          <h2 className="text-2xl font-black tracking-tight text-gray-950 sm:text-[2rem]">
            Product &amp; Industry Categories
          </h2>
          <p className="mt-2 text-base text-gray-500">
            Explore a wide range of industries under one roof.
          </p>
        </motion.div>

        <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3">
          {exhibitionCategories.map((cat, i) => {
            const c = COLORS[i % COLORS.length]!
            return (
              <motion.div
                key={cat.id}
                initial={{ opacity: 0, y: 14 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.38, delay: i * 0.06 }}
                className="flex items-start gap-4 rounded-xl border border-gray-100 bg-white p-4 sm:p-5"
              >
                <div className={`flex size-10 shrink-0 items-center justify-center rounded-xl ${c.bg}`}>
                  <Tag className={`size-5 ${c.fg}`} aria-hidden />
                </div>
                <div>
                  <p className="font-bold text-gray-900">{cat.label}</p>
                  <p className="mt-0.5 text-[12.5px] leading-relaxed text-gray-500">{cat.desc}</p>
                </div>
              </motion.div>
            )
          })}
        </div>

      </div>
    </section>
  )
}
