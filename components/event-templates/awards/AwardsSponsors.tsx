'use client'

import { motion } from 'framer-motion'
import { Building2 } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import type { Sponsor, SponsorTier } from '@/components/wizard/eventDetailsConfig'

// ─── Config ────────────────────────────────────────────────────────────────────

const TIER_ORDER: SponsorTier[] = ['title', 'gold', 'silver', 'bronze', 'partner', 'media']

const TIER_LABEL: Record<SponsorTier, string> = {
  title:   'Presenting Sponsor',
  gold:    'Gold Sponsor',
  silver:  'Silver Sponsor',
  bronze:  'Bronze Sponsor',
  partner: 'Associate Partner',
  media:   'Media Partner',
}

const TIER_STYLE: Record<SponsorTier, { card: string; text: string }> = {
  title:   { card: 'border-yellow-400/30 bg-yellow-400/5',  text: 'text-yellow-300' },
  gold:    { card: 'border-yellow-400/20 bg-yellow-400/4',  text: 'text-yellow-400' },
  silver:  { card: 'border-zinc-700     bg-zinc-900',        text: 'text-zinc-400'   },
  bronze:  { card: 'border-zinc-700     bg-zinc-900',        text: 'text-zinc-400'   },
  partner: { card: 'border-zinc-800     bg-zinc-950',        text: 'text-zinc-500'   },
  media:   { card: 'border-zinc-800     bg-zinc-950',        text: 'text-zinc-600'   },
}

const TIER_GRID: Record<SponsorTier, string> = {
  title:   'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3',
  gold:    'grid-cols-2 sm:grid-cols-3 lg:grid-cols-4',
  silver:  'grid-cols-2 sm:grid-cols-4 lg:grid-cols-5',
  bronze:  'grid-cols-3 sm:grid-cols-4 lg:grid-cols-6',
  partner: 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-4',
  media:   'grid-cols-3 sm:grid-cols-5 lg:grid-cols-6',
}

const LOGO_SIZE: Record<SponsorTier, string> = {
  title:   'h-14 w-24',
  gold:    'h-10 w-20',
  silver:  'h-8  w-16',
  bronze:  'h-7  w-12',
  partner: 'h-8  w-14',
  media:   'h-6  w-10',
}

// ─── Props ─────────────────────────────────────────────────────────────────────

interface AwardsSponsorsProps {
  sponsors: Sponsor[]
}

// ─── Component ─────────────────────────────────────────────────────────────────

export function AwardsSponsors({ sponsors }: AwardsSponsorsProps) {
  if (!sponsors.length) return null

  const sorted = [...sponsors].sort((a, b) =>
    TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier) || a.order - b.order,
  )

  const tiers = TIER_ORDER.filter(t => sorted.some(s => s.tier === t))

  return (
    <section className="bg-zinc-950 py-14 sm:py-20">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">

        <motion.div
          initial={{ opacity: 0, y: 18 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.1 }}
          transition={{ duration: 0.6 }}
          className="mb-10"
        >
          <div className="mb-3 flex items-center gap-2">
            <div className="h-px w-8 bg-yellow-400/50" />
            <p className="text-[11px] font-bold uppercase tracking-[0.26em] text-yellow-400">
              Sponsors
            </p>
          </div>
          <h2 className="text-2xl font-black tracking-tight text-white sm:text-[2.25rem]">
            Sponsors &amp; Partners
          </h2>
          <p className="mt-3 text-base text-zinc-400">
            Proudly supported by industry leaders.
          </p>
        </motion.div>

        <div className="space-y-10">
          {tiers.map((tier, ti) => {
            const items = sorted.filter(s => s.tier === tier)
            const style = TIER_STYLE[tier]
            return (
              <div key={tier}>
                <p className="mb-4 text-[11px] font-bold uppercase tracking-[0.18em] text-zinc-600">
                  {TIER_LABEL[tier]}
                </p>
                <div className={`grid gap-3 ${TIER_GRID[tier]}`}>
                  {items.map((s, si) => {
                    const Inner = (
                      <motion.div
                        key={s.id}
                        initial={{ opacity: 0, scale: 0.96 }}
                        whileInView={{ opacity: 1, scale: 1 }}
                        viewport={{ once: true }}
                        transition={{ duration: 0.3, delay: ti * 0.04 + si * 0.04 }}
                        className={cn(
                          'flex flex-col items-center justify-center gap-2 rounded-xl border p-4 transition-all duration-200',
                          style.card,
                          s.website && 'cursor-pointer hover:border-yellow-400/20',
                        )}
                      >
                        {s.logoUrl?.trim() ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={s.logoUrl}
                            alt={s.name}
                            className={cn('object-contain brightness-0 invert opacity-60', LOGO_SIZE[tier])}
                          />
                        ) : (
                          <Building2 className="size-5 text-zinc-700" aria-hidden />
                        )}
                        <span className={cn('text-[11px] font-semibold', style.text)}>{s.name}</span>
                      </motion.div>
                    )

                    return s.website?.trim() ? (
                      <a key={s.id} href={s.website} target="_blank" rel="noopener noreferrer" aria-label={s.name}>
                        {Inner}
                      </a>
                    ) : <div key={s.id}>{Inner}</div>
                  })}
                </div>
              </div>
            )
          })}
        </div>

      </div>
    </section>
  )
}
