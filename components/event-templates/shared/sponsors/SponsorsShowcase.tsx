'use client'

// SponsorsShowcase — a trust-forward, tier-based sponsor experience (not a logo wall).
// Pure, reusable, framework-native: consumes SectionShell/SectionHeader/CARD + motion
// tokens; no new design language, no Sports logic. Three hierarchy levels — Featured
// showcase → Title cards → elegant monochrome logo rows for the remaining tiers.
//
// 100% data-driven from the shared Sponsor[] (no adapter needed). Every optional field
// renders only when present; zero sponsors → the section returns null. Logos are
// monochrome by default and transition to brand colour on hover — on desktop only
// (mobile stays monochrome, via the `lg:` hover guard).

import Link from 'next/link'
import { motion, useReducedMotion } from 'framer-motion'
import { ArrowUpRight, Star, MapPin, Building2, Globe } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import type { Sponsor, SponsorTier } from '@/components/wizard/eventDetailsConfig'
import { SPONSOR_TIER_LABELS } from '@/components/wizard/eventDetailsConfig'
import { SectionShell, SectionHeader, CARD, CARD_HOVER, reveal, hoverLift } from '@/components/event-templates/shared/ui/framework'

const REMAINING_TIERS: SponsorTier[] = ['gold', 'silver', 'bronze', 'partner', 'media']

// Monochrome-by-default logo; colour on desktop hover (mobile stays monochrome).
function Logo({ sponsor, className }: { sponsor: Sponsor; className: string }) {
  if (!sponsor.logoUrl?.trim()) {
    return <span className="text-[15px] font-bold text-muted-foreground">{sponsor.name}</span>
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={sponsor.logoUrl}
      alt={sponsor.name}
      loading="lazy"
      decoding="async"
      className={cn('w-auto object-contain grayscale opacity-70 transition duration-150 lg:group-hover:grayscale-0 lg:group-hover:opacity-100 motion-reduce:transition-none', className)}
    />
  )
}

function SponsorMeta({ sponsor }: { sponsor: Sponsor }) {
  const loc = [sponsor.location?.trim(), sponsor.country?.trim()].filter(Boolean).join(', ')
  const since = sponsor.since != null && String(sponsor.since).trim()
  if (!since && !sponsor.industry?.trim() && !loc) return null
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px] text-muted-foreground">
      {since && <span>Partner since {sponsor.since}</span>}
      {sponsor.industry?.trim() && (
        <span className="inline-flex items-center gap-1.5"><Building2 className="size-3.5 text-primary/60" aria-hidden />{sponsor.industry}</span>
      )}
      {loc && (
        <span className="inline-flex items-center gap-1.5"><MapPin className="size-3.5 text-primary/60" aria-hidden />{loc}</span>
      )}
    </div>
  )
}

function SponsorLinks({ sponsor }: { sponsor: Sponsor }) {
  const web = sponsor.website?.trim()
  const socials = (sponsor.socials ?? []).filter(s => s?.url?.trim())
  const brand = sponsor.brandGuidelines?.trim()
  if (!web && socials.length === 0 && !brand) return null
  return (
    <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px]">
      {web && (
        <Link href={web} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-semibold text-primary hover:underline">
          Visit site<ArrowUpRight className="size-3.5" aria-hidden />
        </Link>
      )}
      {socials.map((s, i) => (
        <Link key={i} href={s.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-medium text-muted-foreground hover:text-foreground">
          <Globe className="size-3.5" aria-hidden />{s.label?.trim() || 'Social'}
        </Link>
      ))}
      {brand && (
        <Link href={brand} target="_blank" rel="noopener noreferrer" className="font-medium text-muted-foreground hover:text-foreground">
          Brand assets
        </Link>
      )}
    </div>
  )
}

// Tags — shown on the richer levels only.
function SponsorTags({ tags }: { tags?: string[] }) {
  const t = (tags ?? []).filter(Boolean)
  if (t.length === 0) return null
  return (
    <div className="mt-3 flex flex-wrap gap-1.5">
      {t.map(tag => <span key={tag} className="rounded-full bg-muted px-2 py-0.5 text-[11.5px] font-medium text-muted-foreground">#{tag}</span>)}
    </div>
  )
}

// Small tier label.
const TierLabel = ({ children }: { children: React.ReactNode }) => (
  <h3 className="mb-4 text-[12px] font-bold uppercase tracking-[0.16em] text-muted-foreground">{children}</h3>
)

// ─── Section ─────────────────────────────────────────────────────────────────────
export interface SponsorsShowcaseProps {
  items:     Sponsor[]
  eyebrow?:  string
  title?:    string
  subtitle?: string
}

export function SponsorsShowcase({ items, eyebrow = 'Partners', title = 'Proudly Supported By', subtitle }: SponsorsShowcaseProps) {
  const reduce = useReducedMotion()

  const all = (items ?? [])
    .filter(s => s && s.enabled !== false && s.name?.trim())
    .sort((a, b) => (a.displayOrder ?? a.order ?? 0) - (b.displayOrder ?? b.order ?? 0))

  if (all.length === 0) return null

  const featured  = all.filter(s => s.featured)
  const rest      = all.filter(s => !s.featured)
  const titleTier = rest.filter(s => s.tier === 'title')
  const tierGroups = REMAINING_TIERS
    .map(tier => ({ tier, items: rest.filter(s => s.tier === tier) }))
    .filter(g => g.items.length > 0)

  return (
    <SectionShell id="sponsors" maxW="6xl">
      <SectionHeader eyebrow={eyebrow} title={title} subtitle={subtitle} />

      {/* ── Level 1 · Featured showcase ── */}
      {featured.length > 0 && (
        <div className="mb-12 flex flex-col gap-4">
          {featured.map(s => (
            <motion.div key={s.id} {...reveal(reduce)}
              className={cn(CARD, 'overflow-hidden')}
              style={s.themeColor && /^#[0-9a-f]{6}$/i.test(s.themeColor) ? { borderColor: `${s.themeColor}55` } : undefined}
            >
              <div className="grid gap-6 p-6 sm:grid-cols-[220px_1fr] sm:items-center sm:p-8">
                <div className="group flex h-20 items-center justify-center sm:justify-start">
                  <Logo sponsor={s} className="max-h-16" />
                </div>
                <div>
                  <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2.5 py-0.5 text-[10.5px] font-bold uppercase tracking-wide text-primary">
                    <Star className="size-3" aria-hidden />Featured Partner
                  </span>
                  <h4 className="mt-2.5 text-[20px] font-bold leading-tight text-foreground">{s.name}</h4>
                  {s.description?.trim() && <p className="mt-1.5 text-[14px] leading-relaxed text-muted-foreground">{s.description}</p>}
                  <SponsorMeta sponsor={s} />
                  <SponsorTags tags={s.tags} />
                  <SponsorLinks sponsor={s} />
                </div>
              </div>
            </motion.div>
          ))}
        </div>
      )}

      {/* ── Level 2 · Title sponsors (premium cards) ── */}
      {titleTier.length > 0 && (
        <div className="mb-12">
          <TierLabel>{SPONSOR_TIER_LABELS.title}</TierLabel>
          <div className="grid gap-4 sm:grid-cols-2">
            {titleTier.map(s => {
              const web = s.website?.trim()
              const body = (
                <>
                  <div className="flex h-14 items-center">
                    <Logo sponsor={s} className="max-h-12" />
                  </div>
                  <div className="mt-3">
                    <h4 className="text-[16px] font-bold text-foreground">{s.name}</h4>
                    {s.description?.trim() && <p className="mt-1 line-clamp-2 text-[13px] leading-relaxed text-muted-foreground">{s.description}</p>}
                    {web && (
                      <span className="mt-2.5 inline-flex items-center gap-1 text-[13px] font-semibold text-primary">
                        Visit site<ArrowUpRight className="size-3.5 transition-transform duration-150 group-hover:translate-x-0.5 motion-reduce:transform-none" aria-hidden />
                      </span>
                    )}
                  </div>
                </>
              )
              const cls = cn('group flex flex-col p-5', CARD, CARD_HOVER,
                web && 'outline-none focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-offset-2')
              return web ? (
                <motion.div key={s.id} whileHover={hoverLift(reduce)} transition={{ duration: 0.16 }}>
                  <Link href={web} target="_blank" rel="noopener noreferrer" aria-label={`Visit ${s.name}`} className={cn(cls, 'h-full')}>{body}</Link>
                </motion.div>
              ) : (
                <motion.div key={s.id} whileHover={hoverLift(reduce)} transition={{ duration: 0.16 }} className={cls}>{body}</motion.div>
              )
            })}
          </div>
        </div>
      )}

      {/* ── Level 3 · Remaining tiers (monochrome logo rows) ── */}
      {tierGroups.length > 0 && (
        <div className="flex flex-col gap-9">
          {tierGroups.map(group => (
            <div key={group.tier}>
              <TierLabel>{SPONSOR_TIER_LABELS[group.tier]}</TierLabel>
              <div className="flex flex-wrap items-center gap-x-8 gap-y-6 sm:gap-x-10">
                {group.items.map(s => {
                  const web = s.website?.trim()
                  const logo = (
                    <span className="flex h-9 items-center">
                      <Logo sponsor={s} className="max-h-8 max-w-[150px]" />
                    </span>
                  )
                  return web ? (
                    <Link key={s.id} href={web} target="_blank" rel="noopener noreferrer" aria-label={`Visit ${s.name}`}
                      className="group rounded outline-none focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-offset-2">
                      {logo}
                    </Link>
                  ) : (
                    <figure key={s.id} className="group" aria-label={s.name}>{logo}</figure>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </SectionShell>
  )
}
