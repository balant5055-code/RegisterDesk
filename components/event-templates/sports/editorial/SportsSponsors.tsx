// ─── SportsSponsors — the partners, in their actual order ───────────────────
//
// SPORTS-ONLY Server Component. The shared showcase drew every tier the same way: a
// centred row of equal bordered tiles, so a title sponsor and a media partner carried
// identical weight — the one thing a sponsor hierarchy must never do.
//
// Here the hierarchy IS the layout. Each tier is its own centred row under a flanked
// label, and the logo scale steps down with the tier:
//
//            ────────  TITLE SPONSOR  ────────
//                 [ ———— large logo ———— ]
//            ───────────  GOLD  ───────────
//              [  medium  ]    [  medium  ]
//
// Order within a tier is the organiser's own (featured first, then displayOrder), and
// the tier order is the schema's. No sponsor is added, promoted, renamed or counted.

import { ArrowUpRight } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import type { Sponsor, SponsorTier } from '@/components/wizard/eventDetailsConfig'
import { SPONSOR_TIER_LABELS } from '@/components/wizard/eventDetailsConfig'
import { BODY, SectionHead, SportsSection, ColumnHead, SPORTS_SCROLL_MT } from './primitives'

const TIER_ORDER: SponsorTier[] = ['title', 'gold', 'silver', 'bronze', 'partner', 'media']

/** Logo scale per tier — the hierarchy, expressed as size. */
const TIER_SCALE: Record<SponsorTier, { box: string; img: string; cols: string }> = {
  title:   { box: 'h-28 sm:h-36', img: 'max-h-20 sm:max-h-28', cols: 'w-full max-w-sm' },
  gold:    { box: 'h-20 sm:h-24', img: 'max-h-12 sm:max-h-16', cols: 'w-[calc(50%-0.625rem)] max-w-[15rem]' },
  silver:  { box: 'h-16 sm:h-20', img: 'max-h-10 sm:max-h-12', cols: 'w-[calc(50%-0.625rem)] max-w-[12rem]' },
  bronze:  { box: 'h-16',         img: 'max-h-9',               cols: 'w-[calc(33.333%-0.834rem)] max-w-[10rem]' },
  partner: { box: 'h-16',         img: 'max-h-9',               cols: 'w-[calc(33.333%-0.834rem)] max-w-[10rem]' },
  media:   { box: 'h-16',         img: 'max-h-9',               cols: 'w-[calc(33.333%-0.834rem)] max-w-[10rem]' },
}

export interface SportsSponsorsProps {
  items?:    Sponsor[]
  eyebrow?:  string
  title?:    string
  subtitle?: string
  /** 'band' — the full-width section (default). 'column' — the right half of the shared
   *  Hosted By | Proudly Supported By band. */
  layout?:   'band' | 'column'
}

export function SportsSponsors({
  items, eyebrow = 'Partners', title = 'Proudly Supported By', subtitle, layout = 'band',
}: SportsSponsorsProps) {
  const all = (items ?? [])
    .filter(s => s && s.enabled !== false && s.name?.trim())
    .sort((a, b) => {
      const af = a.featured ? 1 : 0, bf = b.featured ? 1 : 0
      if (af !== bf) return bf - af
      return (a.displayOrder ?? a.order ?? 0) - (b.displayOrder ?? b.order ?? 0)
    })

  if (all.length === 0) return null

  const tiers = TIER_ORDER
    .map(tier => ({ tier, list: all.filter(s => (s.tier ?? 'gold') === tier) }))
    .filter(t => t.list.length > 0)

  if (layout === 'column') {
    return (
      <section id="sponsors" className={cn(SPORTS_SCROLL_MT, 'min-w-0')}>
        <ColumnHead eyebrow={eyebrow} title={title} />
        {subtitle && <p className={cn('mt-3', BODY)}>{subtitle}</p>}

        {/* 2026-09-25 (owner: "still needs to improve"): the title sponsor is a FEATURED
            card — the logo on a quiet plate beside its name, tier and link — and every
            other tier is an even grid that fills the column (no half-empty rows). Each
            tile carries the sponsor's name, so a logo is never the only identification. */}
        <div className="mt-7 space-y-7">
          {tiers.map(({ tier, list }) => {
            const featured = tier === 'title'
            return (
              <section key={tier}>
                <h3 className="flex items-center justify-center gap-2.5 text-fs-2xs font-semibold uppercase tracking-[0.14em] text-hero-eyebrow sm:justify-start">
                  <span aria-hidden className="h-px w-5 bg-hero-accent-rule" />
                  {SPONSOR_TIER_LABELS[tier]}
                  <span aria-hidden className="h-px w-5 bg-hero-accent-rule sm:hidden" />
                </h3>
                <ul className={cn('mt-3 grid gap-3', featured ? 'grid-cols-1' : list.length === 1 ? 'grid-cols-1 sm:max-w-[16rem]' : list.length === 2 || list.length === 4 ? 'grid-cols-2' : 'grid-cols-2 xl:grid-cols-3')}>
                  {list.map(s => {
                    const site = s.website?.trim()
                    const logo = s.logoUrl?.trim()
                    const host = site ? site.replace(/^https?:\/\//, '').replace(/\/.*$/, '') : ''
                    const plate = (
                      <span className={cn('flex shrink-0 items-center justify-center overflow-hidden rounded-surface bg-white', featured ? 'size-28 border border-border/60 p-2 sm:size-32' : 'h-20 w-full p-3')}>
                        {logo ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={logo}
                            alt={s.name}
                            loading="lazy"
                            decoding="async"
                            className="max-h-full w-auto max-w-full object-contain transition-transform duration-300 group-hover:scale-[1.04] motion-reduce:transform-none"
                          />
                        ) : (
                          <span className="text-balance text-center text-fs-2xs font-semibold uppercase tracking-[0.14em] text-hero-ink">{s.name}</span>
                        )}
                      </span>
                    )
                    const inner = featured ? (
                      <figure className="flex flex-col items-center gap-4 rounded-panel border border-hero-accent-rule/35 bg-hero-accent-rule/[0.05] p-4 text-center transition-colors group-hover:border-hero-accent-rule/70 sm:flex-row sm:text-left">
                        {plate}
                        <figcaption className="min-w-0">
                          <p className="text-fs-2xs font-semibold uppercase tracking-[0.14em] text-hero-accent-rule">Presented by</p>
                          <p className="mt-1 text-balance text-fs-lg font-semibold leading-snug text-hero-ink">{s.name}</p>
                          {s.description?.trim() && <p className="mt-1 line-clamp-2 text-fs-sm text-muted-foreground">{s.description.trim()}</p>}
                          {host && <p className="mt-2 inline-flex items-center gap-1 text-fs-xs font-semibold text-action">{host}<ArrowUpRight className="size-3.5" aria-hidden /></p>}
                        </figcaption>
                      </figure>
                    ) : (
                      <figure className="flex h-full flex-col overflow-hidden rounded-panel border border-border/60 bg-background transition-colors group-hover:border-action/40">
                        {plate}
                        <figcaption className="border-t border-border/60 px-3 py-2 text-center">
                          <p className="line-clamp-2 text-balance text-fs-xs font-semibold leading-snug text-hero-ink">{s.name}</p>
                        </figcaption>
                      </figure>
                    )
                    return (
                      <li key={s.id || s.name} className="min-w-0">
                        {site ? (
                          <a href={site} target="_blank" rel="noopener noreferrer" aria-label={s.name} className="group block h-full outline-none focus-visible:rounded-panel focus-visible:ring-2 focus-visible:ring-action focus-visible:ring-offset-2">
                            {inner}
                          </a>
                        ) : (
                          <div className="group h-full">{inner}</div>
                        )}
                      </li>
                    )
                  })}
                </ul>
              </section>
            )
          })}
        </div>
      </section>
    )
  }

  return (
    <SportsSection id="sponsors">
      <SectionHead eyebrow={eyebrow} title={title} lead={subtitle} />

      <div className="mx-auto mt-8 max-w-5xl border-t border-border/60">
        {tiers.map(({ tier, list }) => {
          const scale = TIER_SCALE[tier] ?? TIER_SCALE.partner
          return (
            <section key={tier} className="border-b border-border/60 py-8 last:border-b-0">
              <h3 className="flex items-center justify-center gap-4 text-fs-2xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">
                <span aria-hidden className="h-px w-8 bg-border-strong sm:w-16" />
                {SPONSOR_TIER_LABELS[tier]}
                <span aria-hidden className="h-px w-8 bg-border-strong sm:w-16" />
              </h3>

              <ul className="mt-5 flex flex-wrap items-center justify-center gap-4 sm:gap-5">
                {list.map(s => {
                  const site = s.website?.trim()
                  const logo = s.logoUrl?.trim()
                  const inner = (
                    <figure className={cn('flex w-full items-center justify-center overflow-hidden rounded-panel border border-border/60 bg-background px-5 transition-colors group-hover:border-border-strong', scale.box)}>
                      {logo ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={logo}
                          alt={s.name}
                          loading="lazy"
                          decoding="async"
                          className={cn('w-auto max-w-full object-contain transition-transform duration-200 group-hover:scale-[1.03] motion-reduce:transform-none', scale.img)}
                        />
                      ) : (
                        <figcaption className="text-balance px-2 text-center text-fs-2xs font-semibold uppercase tracking-[0.14em] text-hero-ink">{s.name}</figcaption>
                      )}
                    </figure>
                  )
                  return (
                    <li key={s.id || s.name} className={cn('min-w-0', scale.cols)}>
                      {site ? (
                        <a href={site} target="_blank" rel="noopener noreferrer" aria-label={s.name} className="group block outline-none focus-visible:rounded-panel focus-visible:ring-2 focus-visible:ring-action focus-visible:ring-offset-2">
                          {inner}
                        </a>
                      ) : (
                        <div className="group">{inner}</div>
                      )}
                      {s.description?.trim() && (
                        <p className={cn('mt-2 line-clamp-2 text-center', BODY, 'text-fs-sm')}>{s.description.trim()}</p>
                      )}
                    </li>
                  )
                })}
              </ul>
            </section>
          )
        })}
      </div>
    </SportsSection>
  )
}
