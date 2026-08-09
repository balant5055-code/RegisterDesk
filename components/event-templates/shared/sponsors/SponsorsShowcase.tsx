'use client'

// SponsorsShowcase — one premium logo wall.
//
// RD-ST12.0 rework. The section previously rendered THREE different presentations of
// the same data: a full-width featured banner, two-up title cards, then loose
// monochrome logo rows floating in flex-wrap with no surface at all. Nothing shared a
// size, a surface or a baseline, so partners read as uploaded images at three arbitrary
// scales rather than as one trusted roster.
//
// It is now a single card language:
//
//   • ONE card — soft surface, subtle border, very soft elevation, fixed height, logo
//     centred on both axes and never stretched (object-contain).
//   • Equal width and equal height for every partner, so the wall has real rhythm.
//   • 2 columns on mobile, 3 on tablet, 4–6 on desktop — the desktop count is chosen to
//     leave the fullest possible last row, and partial rows centre.
//   • Logos sit monochrome at rest and resolve to full colour on desktop hover, which
//     is what stops a wall of clashing brand palettes from looking ragged.
//
// Tiers are NOT invented — `tier` is a required schema field with an organiser-facing
// select in the wizard. But `makeBlankSponsor()` defaults every sponsor to 'gold', so
// most events never differentiate. Tier headings therefore appear ONLY when the
// organiser actually used more than one tier; otherwise the wall renders ungrouped.
//
// 100% data-driven: only enabled, named sponsors render; zero sponsors → null.

import Link from 'next/link'
import { motion, useReducedMotion } from 'framer-motion'
import { Star } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import type { Sponsor, SponsorTier } from '@/components/wizard/eventDetailsConfig'
import { SPONSOR_TIER_LABELS } from '@/components/wizard/eventDetailsConfig'
import {
  SectionShell, EventSectionHeader, TYPE, CARD, CARD_HOVER, reveal, hoverLift,
} from '@/components/event-templates/shared/ui/framework'

// Canonical tier order — the schema's own ranking, used only for grouping.
const TIER_ORDER: SponsorTier[] = ['title', 'gold', 'silver', 'bronze', 'partner', 'media']

const HEX = /^#[0-9a-f]{6}$/i

// ── Wall geometry ───────────────────────────────────────────────────────────────
// Desktop uses 4–6 columns "depending on available logos": pick the count that leaves
// the fullest last row, preferring an exact fit. 9 logos → 5 (5+4), 11 → 6 (6+5).
function columnsFor(count: number): 4 | 5 | 6 {
  if (count <= 4) return 4
  let best: 4 | 5 | 6 = 4
  let bestScore = -1
  for (const c of [6, 5, 4] as const) {
    const rem = count % c
    const score = rem === 0 ? Number.MAX_SAFE_INTEGER : rem
    if (score > bestScore) { bestScore = score; best = c }
  }
  return best
}

// Fixed card width per breakpoint: (100% − (n−1)×gap) / n, with gap-3 on mobile and
// gap-4 above. Widths are explicit so every card matches and partial rows can centre.
const CARD_W: Record<4 | 5 | 6, string> = {
  4: 'w-[calc(50%-0.375rem)] sm:w-[calc(33.333%-0.667rem)] lg:w-[calc(25%-0.75rem)]',
  5: 'w-[calc(50%-0.375rem)] sm:w-[calc(33.333%-0.667rem)] lg:w-[calc(20%-0.8rem)]',
  6: 'w-[calc(50%-0.375rem)] sm:w-[calc(33.333%-0.667rem)] lg:w-[calc(16.666%-0.834rem)]',
}

// ── One partner card ────────────────────────────────────────────────────────────
// One presentation for every partner. The card is a link when the organiser supplied a
// website and a plain figure when they did not — the surface is identical either way,
// so a partner without a site never looks like a lesser partner.
function PartnerCard({ sponsor, reduce }: { sponsor: Sponsor; reduce: boolean | null }) {
  const web   = sponsor.website?.trim()
  const logo  = sponsor.logoUrl?.trim()
  const tint  = sponsor.themeColor && HEX.test(sponsor.themeColor) ? sponsor.themeColor : ''

  const surface = cn(
    'group relative flex h-24 w-full items-center justify-center overflow-hidden px-4 sm:h-28 sm:px-5',
    CARD, CARD_HOVER,
    sponsor.featured && 'ring-1 ring-primary/25',
    web && 'outline-none focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-offset-2',
  )

  const body = (
    <>
      {logo ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={logo}
          // When the card is a link the link already carries the name, so the image is
          // decorative; standalone cards put the name on the image itself.
          alt={web ? '' : sponsor.name}
          loading="lazy"
          decoding="async"
          className="max-h-10 w-auto max-w-full object-contain grayscale opacity-70 transition duration-150 group-hover:scale-[1.04] motion-reduce:transform-none motion-reduce:transition-none sm:max-h-12 lg:group-hover:grayscale-0 lg:group-hover:opacity-100"
        />
      ) : (
        // No logo uploaded — the name becomes the wordmark, same card, same height.
        <span className="line-clamp-2 text-center text-fs-sm font-bold text-muted-foreground transition-colors duration-150 group-hover:text-foreground">
          {sponsor.name}
        </span>
      )}

      {/* Optional brand tint on hover — the organiser's own themeColor, nothing new. */}
      {tint && (
        <span
          aria-hidden
          style={{ backgroundColor: tint }}
          className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-150 group-hover:opacity-[0.07]"
        />
      )}

      {sponsor.featured && (
        <Star className="absolute right-2.5 top-2.5 size-3 text-primary/70" aria-hidden />
      )}
    </>
  )

  return (
    <motion.div whileHover={hoverLift(reduce)} transition={{ duration: 0.16 }} className="h-full">
      {web ? (
        <Link href={web} target="_blank" rel="noopener noreferrer" aria-label={`${sponsor.name} — visit website`} className={surface}>
          {body}
        </Link>
      ) : (
        <figure className={surface} aria-label={sponsor.name}>{body}</figure>
      )}
    </motion.div>
  )
}

// ── One wall (a tier group, or the whole roster) ────────────────────────────────
function Wall({ items, cols, reduce }: { items: Sponsor[]; cols: 4 | 5 | 6; reduce: boolean | null }) {
  return (
    <ul className="flex flex-wrap justify-center gap-3 sm:gap-4">
      {items.map(s => (
        <li key={s.id} className={CARD_W[cols]}>
          <PartnerCard sponsor={s} reduce={reduce} />
        </li>
      ))}
    </ul>
  )
}

// ─── Section ─────────────────────────────────────────────────────────────────────
export interface SponsorsShowcaseProps {
  items:     Sponsor[]
  eyebrow?:  string
  title?:    string
  subtitle?: string
}

export function SponsorsShowcase({ items, eyebrow = 'Partners', title = 'Proudly Supported By', subtitle }: SponsorsShowcaseProps) {
  const reduce = useReducedMotion()

  // Ordering is unchanged: the organiser's displayOrder/order decides, with featured
  // partners kept ahead — exactly the precedence the old three-level layout produced.
  const all = (items ?? [])
    .filter(s => s && s.enabled !== false && s.name?.trim())
    .sort((a, b) => {
      const af = a.featured ? 1 : 0, bf = b.featured ? 1 : 0
      if (af !== bf) return bf - af
      return (a.displayOrder ?? a.order ?? 0) - (b.displayOrder ?? b.order ?? 0)
    })

  if (all.length === 0) return null

  // Group only when the organiser genuinely differentiated. One tier across the whole
  // roster (the wizard default) means the heading would carry no information.
  const usedTiers = TIER_ORDER.filter(t => all.some(s => s.tier === t))
  const grouped   = usedTiers.length > 1
  const groups    = grouped
    ? usedTiers.map(tier => ({ tier, items: all.filter(s => s.tier === tier) }))
    : [{ tier: null, items: all }]

  // One column count for the whole section, taken from the largest group, so card size
  // never changes between groups.
  const cols = columnsFor(Math.max(...groups.map(g => g.items.length)))

  return (
    <SectionShell id="sponsors" maxW="6xl">
      <EventSectionHeader eyebrow={eyebrow} title={title} description={subtitle} />

      <motion.div {...reveal(reduce)} className="flex flex-col gap-9">
        {groups.map(group => (
          <div key={group.tier ?? 'all'}>
            {group.tier && (
              <h3 className={cn('mb-4 text-center', TYPE.groupLabel)}>{SPONSOR_TIER_LABELS[group.tier]}</h3>
            )}
            <Wall items={group.items} cols={cols} reduce={reduce} />
          </div>
        ))}
      </motion.div>
    </SectionShell>
  )
}
