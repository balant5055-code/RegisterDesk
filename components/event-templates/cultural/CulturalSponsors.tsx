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
  partner: 'Partner',
  media:   'Media Partner',
}

const TIER_STYLE: Record<SponsorTier, { border: string; bg: string; text: string }> = {
  title:   { border: 'border-amber-400/30',  bg: 'bg-amber-400/5',   text: 'text-amber-300'  },
  gold:    { border: 'border-yellow-400/20', bg: 'bg-yellow-400/5',  text: 'text-yellow-300' },
  silver:  { border: 'border-white/15',      bg: 'bg-white/5',       text: 'text-white/50'   },
  bronze:  { border: 'border-orange-400/20', bg: 'bg-orange-400/5',  text: 'text-orange-300' },
  partner: { border: 'border-violet-400/20', bg: 'bg-violet-400/5',  text: 'text-violet-300' },
  media:   { border: 'border-white/10',      bg: 'bg-white/3',       text: 'text-white/30'   },
}

// ─── Props ─────────────────────────────────────────────────────────────────────

interface CulturalSponsorsProps {
  sponsors: Sponsor[]
}

// ─── Component ─────────────────────────────────────────────────────────────────

export function CulturalSponsors({ sponsors }: CulturalSponsorsProps) {
  if (!sponsors.length) return null

  const sorted = [...sponsors].sort((a, b) =>
    TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier) || a.order - b.order,
  )

  const tiers = TIER_ORDER.filter(t => sorted.some(s => s.tier === t))

  const tierGridCols: Record<SponsorTier, string> = {
    title:   'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3',
    gold:    'grid-cols-2 sm:grid-cols-3 lg:grid-cols-4',
    silver:  'grid-cols-2 sm:grid-cols-4 lg:grid-cols-5',
    bronze:  'grid-cols-3 sm:grid-cols-4 lg:grid-cols-6',
    partner: 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-4',
    media:   'grid-cols-3 sm:grid-cols-4 lg:grid-cols-6',
  }

  const logoSize: Record<SponsorTier, string> = {
    title:   'h-14 w-24',
    gold:    'h-10 w-18',
    silver:  'h-8 w-14',
    bronze:  'h-6 w-12',
    partner: 'h-8 w-14',
    media:   'h-6 w-10',
  }

  return (
    <section className="bg-gray-950 py-14 sm:py-18">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">

        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.1 }}
          transition={{ duration: 0.5 }}
          className="mb-10"
        >
          <p className="mb-1.5 text-[11px] font-bold uppercase tracking-[0.22em] text-amber-400">
            Sponsors
          </p>
          <h2 className="text-2xl font-black tracking-tight text-white sm:text-[2rem]">
            Our Sponsors &amp; Partners
          </h2>
          <p className="mt-2 text-base text-white/40">
            Making this celebration possible.
          </p>
        </motion.div>

        <div className="space-y-10">
          {tiers.map((tier, ti) => {
            const items = sorted.filter(s => s.tier === tier)
            const style = TIER_STYLE[tier]
            return (
              <div key={tier}>
                <p className="mb-4 text-[11px] font-bold uppercase tracking-[0.16em] text-white/30">
                  {TIER_LABEL[tier]}
                </p>
                <div className={`grid gap-3 ${tierGridCols[tier]}`}>
                  {items.map((s, si) => {
                    const Inner = (
                      <motion.div
                        key={s.id}
                        initial={{ opacity: 0, scale: 0.95 }}
                        whileInView={{ opacity: 1, scale: 1 }}
                        viewport={{ once: true }}
                        transition={{ duration: 0.3, delay: ti * 0.04 + si * 0.03 }}
                        className={cn(
                          'flex flex-col items-center justify-center gap-2 rounded-xl border p-4 transition-all duration-200',
                          style.border, style.bg,
                          s.website && 'hover:border-white/20 cursor-pointer',
                        )}
                      >
                        {s.logoUrl?.trim() ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={s.logoUrl}
                            alt={s.name}
                            className={cn('object-contain brightness-0 invert opacity-70', logoSize[tier])}
                          />
                        ) : (
                          <Building2 className="size-6 text-white/20" aria-hidden />
                        )}
                        <span className={`text-[11px] font-semibold ${style.text}`}>{s.name}</span>
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
