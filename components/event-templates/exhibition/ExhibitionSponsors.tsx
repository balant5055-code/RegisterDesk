'use client'

import { motion } from 'framer-motion'
import { Building2 } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import type { Sponsor, SponsorTier } from '@/components/wizard/eventDetailsConfig'

// ─── Config ────────────────────────────────────────────────────────────────────

const TIER_ORDER: SponsorTier[] = ['title', 'gold', 'silver', 'bronze', 'partner', 'media']

const TIER_LABEL: Record<SponsorTier, string> = {
  title:   'Title Sponsor',
  gold:    'Gold Sponsor',
  silver:  'Silver Sponsor',
  bronze:  'Bronze Sponsor',
  partner: 'Partner',
  media:   'Media Partner',
}

const TIER_STYLE: Record<SponsorTier, string> = {
  title:   'border-teal-200 bg-teal-50',
  gold:    'border-amber-200 bg-amber-50',
  silver:  'border-gray-200 bg-gray-50',
  bronze:  'border-orange-200 bg-orange-50',
  partner: 'border-blue-100 bg-blue-50',
  media:   'border-gray-100 bg-gray-50',
}

// ─── Props ─────────────────────────────────────────────────────────────────────

interface ExhibitionSponsorsProps {
  sponsors: Sponsor[]
}

// ─── Component ─────────────────────────────────────────────────────────────────

export function ExhibitionSponsors({ sponsors }: ExhibitionSponsorsProps) {
  if (!sponsors.length) return null

  const sorted = [...sponsors].sort((a, b) =>
    TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier) || a.order - b.order,
  )

  const tiers = TIER_ORDER.filter(t => sorted.some(s => s.tier === t))

  const tierGridCols: Record<SponsorTier, string> = {
    title:   'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3',
    gold:    'grid-cols-2 sm:grid-cols-3 lg:grid-cols-4',
    silver:  'grid-cols-2 sm:grid-cols-3 lg:grid-cols-5',
    bronze:  'grid-cols-3 sm:grid-cols-4 lg:grid-cols-6',
    partner: 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-4',
    media:   'grid-cols-3 sm:grid-cols-4 lg:grid-cols-6',
  }

  const logoSize: Record<SponsorTier, string> = {
    title:   'h-16 w-28',
    gold:    'h-12 w-20',
    silver:  'h-9 w-16',
    bronze:  'h-7 w-12',
    partner: 'h-9 w-16',
    media:   'h-7 w-12',
  }

  return (
    <section className="bg-white py-14 sm:py-18">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">

        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.1 }}
          transition={{ duration: 0.45, ease: [0.25, 0, 0, 1] }}
          className="mb-10"
        >
          <p className="mb-1.5 text-[11px] font-bold uppercase tracking-[0.20em] text-teal-600">
            Sponsors
          </p>
          <h2 className="text-2xl font-black tracking-tight text-gray-950 sm:text-[2rem]">
            Sponsors &amp; Partners
          </h2>
          <p className="mt-2 text-base text-gray-500">
            Organisations powering this exhibition.
          </p>
        </motion.div>

        <div className="space-y-10">
          {tiers.map((tier, ti) => {
            const items = sorted.filter(s => s.tier === tier)
            return (
              <div key={tier}>
                <p className="mb-4 text-[11px] font-bold uppercase tracking-[0.16em] text-gray-400">
                  {TIER_LABEL[tier]}
                </p>
                <div className={`grid gap-3 ${tierGridCols[tier]}`}>
                  {items.map((s, si) => (
                    <motion.div
                      key={s.id}
                      initial={{ opacity: 0, scale: 0.97 }}
                      whileInView={{ opacity: 1, scale: 1 }}
                      viewport={{ once: true }}
                      transition={{ duration: 0.3, delay: ti * 0.05 + si * 0.04 }}
                    >
                      {s.website?.trim() ? (
                        <a
                          href={s.website}
                          target="_blank"
                          rel="noopener noreferrer"
                          aria-label={s.name}
                          className={cn(
                            'flex flex-col items-center justify-center gap-2 rounded-xl border p-4 transition-all duration-200 hover:shadow-sm',
                            TIER_STYLE[tier],
                          )}
                        >
                          <SponsorLogo sponsor={s} logoSize={logoSize[tier]} />
                          <span className="text-[11px] font-semibold text-gray-500">{s.name}</span>
                        </a>
                      ) : (
                        <div className={cn(
                          'flex flex-col items-center justify-center gap-2 rounded-xl border p-4',
                          TIER_STYLE[tier],
                        )}>
                          <SponsorLogo sponsor={s} logoSize={logoSize[tier]} />
                          <span className="text-[11px] font-semibold text-gray-500">{s.name}</span>
                        </div>
                      )}
                    </motion.div>
                  ))}
                </div>
              </div>
            )
          })}
        </div>

      </div>
    </section>
  )
}

// ─── Sponsor logo sub-component ───────────────────────────────────────────────

function SponsorLogo({ sponsor, logoSize }: { sponsor: Sponsor; logoSize: string }) {
  if (sponsor.logoUrl?.trim()) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={sponsor.logoUrl}
        alt={sponsor.name}
        className={cn('object-contain', logoSize)}
      />
    )
  }
  return <Building2 className="size-6 text-gray-300" aria-hidden />
}
