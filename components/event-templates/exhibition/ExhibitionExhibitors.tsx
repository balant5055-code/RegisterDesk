'use client'

import { motion } from 'framer-motion'
import { Globe, ExternalLink, Building2 } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import type { ExhibitorEntry } from '@/components/wizard/eventDetailsConfig'

// ─── Props ─────────────────────────────────────────────────────────────────────

interface ExhibitionExhibitorsProps {
  exhibitors: ExhibitorEntry[]
}

// ─── Component ─────────────────────────────────────────────────────────────────

export function ExhibitionExhibitors({ exhibitors }: ExhibitionExhibitorsProps) {
  if (!exhibitors.length) return null

  const sorted = [...exhibitors].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))

  return (
    <section id="exhibitors" className="bg-gray-50 py-14 sm:py-18">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">

        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.1 }}
          transition={{ duration: 0.45, ease: [0.25, 0, 0, 1] }}
          className="mb-10"
        >
          <p className="mb-1.5 text-[11px] font-bold uppercase tracking-[0.20em] text-teal-600">
            Exhibitors
          </p>
          <h2 className="text-2xl font-black tracking-tight text-gray-950 sm:text-[2rem]">
            Participating Companies
          </h2>
          <p className="mt-2 text-base text-gray-500">
            {exhibitors.length} exhibitor{exhibitors.length !== 1 ? 's' : ''} across industries
          </p>
        </motion.div>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {sorted.map((ex, i) => (
            <ExhibitorCard key={ex.id} exhibitor={ex} delay={i * 0.05} />
          ))}
        </div>

      </div>
    </section>
  )
}

// ─── Exhibitor card ───────────────────────────────────────────────────────────

function ExhibitorCard({ exhibitor: ex, delay }: { exhibitor: ExhibitorEntry; delay: number }) {
  const Inner = (
    <motion.div
      initial={{ opacity: 0, scale: 0.97 }}
      whileInView={{ opacity: 1, scale: 1 }}
      viewport={{ once: true }}
      transition={{ duration: 0.35, delay }}
      className={cn(
        'group flex flex-col rounded-2xl border border-gray-100 bg-white p-5 transition-all duration-200',
        ex.website && 'hover:border-teal-200 hover:shadow-[0_6px_24px_-6px_rgba(0,0,0,0.10)]',
      )}
    >
      <div className="mb-4 flex items-start gap-4">
        {/* Logo */}
        <div className="flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-gray-50">
          {ex.logoUrl?.trim() ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={ex.logoUrl}
              alt={ex.name}
              className="h-full w-full object-contain p-1"
            />
          ) : (
            <Building2 className="size-6 text-gray-300" aria-hidden />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-[1rem] font-bold leading-snug text-gray-900">{ex.name}</p>
          {ex.boothNumber?.trim() && (
            <span className="mt-1 inline-flex items-center rounded-full border border-teal-200 bg-teal-50 px-2 py-0.5 text-[10px] font-semibold text-teal-700">
              Booth {ex.boothNumber}
            </span>
          )}
        </div>
      </div>

      {ex.description?.trim() && (
        <p className="mb-3 text-[0.8125rem] leading-relaxed text-gray-500">{ex.description}</p>
      )}

      {ex.website?.trim() && (
        <div className="mt-auto flex items-center gap-1 text-[12px] font-medium text-teal-600">
          <Globe className="size-3" aria-hidden />
          Visit Website
          <ExternalLink className="size-2.5" aria-hidden />
        </div>
      )}
    </motion.div>
  )

  if (ex.website?.trim()) {
    return (
      <a href={ex.website} target="_blank" rel="noopener noreferrer" aria-label={ex.name}>
        {Inner}
      </a>
    )
  }

  return Inner
}
