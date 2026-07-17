'use client'

import { motion } from 'framer-motion'
import { cn } from '@/lib/utils/cn'
import type { Sponsor, SponsorTier } from '@/components/wizard/eventDetailsConfig'

// ─── Config ────────────────────────────────────────────────────────────────────

const TIER_ORDER: SponsorTier[] = ['title', 'gold', 'silver', 'bronze', 'partner', 'media']

const TIER_CONFIG: Record<SponsorTier, {
  label:      string
  sublabel:   string
  cols:       string
  logoH:      string
  badgeBg:    string
  badgeFg:    string
  badgeBorder:string
  cardHover:  string
}> = {
  title: {
    label:       'Platinum',
    sublabel:    'Premier Partner',
    cols:        'grid-cols-1 sm:grid-cols-2',
    logoH:       'max-h-14',
    badgeBg:     'bg-amber-50',
    badgeFg:     'text-amber-700',
    badgeBorder: 'border-amber-200',
    cardHover:   'hover:border-amber-200 hover:shadow-[0_4px_20px_-4px_rgba(251,191,36,0.18)]',
  },
  gold: {
    label:       'Gold',
    sublabel:    'Gold Sponsors',
    cols:        'grid-cols-2 sm:grid-cols-3',
    logoH:       'max-h-11',
    badgeBg:     'bg-yellow-50',
    badgeFg:     'text-yellow-700',
    badgeBorder: 'border-yellow-200',
    cardHover:   'hover:border-yellow-200 hover:shadow-[0_4px_20px_-4px_rgba(234,179,8,0.14)]',
  },
  silver: {
    label:       'Silver',
    sublabel:    'Silver Sponsors',
    cols:        'grid-cols-3 sm:grid-cols-4',
    logoH:       'max-h-9',
    badgeBg:     'bg-gray-100',
    badgeFg:     'text-gray-600',
    badgeBorder: 'border-gray-200',
    cardHover:   'hover:border-gray-300 hover:shadow-[0_4px_16px_-4px_rgba(0,0,0,0.09)]',
  },
  bronze: {
    label:       'Bronze',
    sublabel:    'Bronze Sponsors',
    cols:        'grid-cols-3 sm:grid-cols-5',
    logoH:       'max-h-8',
    badgeBg:     'bg-orange-50',
    badgeFg:     'text-orange-700',
    badgeBorder: 'border-orange-200',
    cardHover:   'hover:border-orange-200 hover:shadow-sm',
  },
  partner: {
    label:       'Community',
    sublabel:    'Community Partners',
    cols:        'grid-cols-3 sm:grid-cols-5 lg:grid-cols-6',
    logoH:       'max-h-7',
    badgeBg:     'bg-sky-50',
    badgeFg:     'text-sky-700',
    badgeBorder: 'border-sky-200',
    cardHover:   'hover:border-sky-200 hover:shadow-sm',
  },
  media: {
    label:       'Media',
    sublabel:    'Media Partners',
    cols:        'grid-cols-3 sm:grid-cols-5 lg:grid-cols-6',
    logoH:       'max-h-7',
    badgeBg:     'bg-gray-50',
    badgeFg:     'text-gray-500',
    badgeBorder: 'border-gray-200',
    cardHover:   'hover:border-gray-200 hover:shadow-sm',
  },
}

// ─── Component ─────────────────────────────────────────────────────────────────

export function ConferenceSponsors({ sponsors }: { sponsors: Sponsor[] }) {
  if (!sponsors.length) return null

  const byTier = TIER_ORDER.reduce<Record<string, Sponsor[]>>((acc, tier) => {
    const list = sponsors.filter(s => s.tier === tier).sort((a, b) => a.order - b.order)
    if (list.length) acc[tier] = list
    return acc
  }, {})

  if (!Object.keys(byTier).length) return null

  return (
    <section className="bg-gray-50 py-16 sm:py-20">
      <div className="mx-auto max-w-5xl px-4 sm:px-6 lg:px-8">

        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 18 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.1 }}
          transition={{ duration: 0.5, ease: [0.25, 0, 0, 1] }}
          className="mb-12 text-center"
        >
          <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.22em] text-primary">Partners</p>
          <h2 className="text-2xl font-black tracking-tight text-gray-950 sm:text-[2rem]">
            Our Sponsors
          </h2>
          <p className="mt-2 text-base text-gray-500">
            Proudly supported by leading organisations.
          </p>
        </motion.div>

        {/* Tier sections */}
        <div className="flex flex-col gap-12">
          {TIER_ORDER.filter(t => byTier[t]).map((tier, tIdx) => {
            const cfg  = TIER_CONFIG[tier]
            const list = byTier[tier]!

            return (
              <motion.div
                key={tier}
                initial={{ opacity: 0, y: 14 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, amount: 0.05 }}
                transition={{ duration: 0.45, delay: tIdx * 0.06, ease: [0.25, 0, 0, 1] }}
              >
                {/* Tier label */}
                <div className="mb-5 flex items-center gap-3">
                  <span className={cn(
                    'inline-flex items-center rounded-full border px-3 py-1 text-[10.5px] font-bold uppercase tracking-[0.16em]',
                    cfg.badgeBg, cfg.badgeFg, cfg.badgeBorder,
                  )}>
                    {cfg.label}
                  </span>
                  <span className="text-[11.5px] text-gray-400">{cfg.sublabel}</span>
                </div>

                {/* Logo grid */}
                <div className={cn('grid gap-3', cfg.cols)}>
                  {list.map((sponsor, sIdx) => (
                    <motion.a
                      key={sponsor.id}
                      href={sponsor.website || undefined}
                      target={sponsor.website ? '_blank' : undefined}
                      rel="noopener noreferrer"
                      aria-label={sponsor.name}
                      initial={{ opacity: 0, scale: 0.97 }}
                      whileInView={{ opacity: 1, scale: 1 }}
                      viewport={{ once: true }}
                      transition={{ duration: 0.35, delay: sIdx * 0.04 }}
                      className={cn(
                        'group flex items-center justify-center rounded-xl border border-gray-100 bg-white p-4 transition-all duration-200',
                        sponsor.website ? cn('cursor-pointer', cfg.cardHover) : 'cursor-default',
                      )}
                    >
                      {sponsor.logoUrl?.trim() ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={sponsor.logoUrl}
                          alt={sponsor.name}
                          className={cn(
                            'w-auto object-contain transition-opacity duration-200',
                            tier === 'title' ? 'opacity-80 group-hover:opacity-100' : 'opacity-60 group-hover:opacity-90',
                            cfg.logoH,
                          )}
                        />
                      ) : (
                        <span className="text-xs font-bold text-gray-500">{sponsor.name}</span>
                      )}
                    </motion.a>
                  ))}
                </div>
              </motion.div>
            )
          })}
        </div>

      </div>
    </section>
  )
}
