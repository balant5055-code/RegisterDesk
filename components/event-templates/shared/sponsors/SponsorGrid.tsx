import { cn } from '@/lib/utils/cn'
import type { Sponsor, SponsorTier } from '@/components/wizard/eventDetailsConfig'
import { SPONSOR_TIER_LABELS } from '@/components/wizard/eventDetailsConfig'
import { SectionWrapper } from '@/components/event-templates/shared/ui/SectionWrapper'

export const TIER_ORDER: SponsorTier[] = ['title', 'gold', 'silver', 'bronze', 'partner', 'media']

export function SponsorGrid({ sponsors }: { sponsors: Sponsor[] }) {
  const byTier = TIER_ORDER.reduce<Record<string, Sponsor[]>>((acc, tier) => {
    const list = sponsors.filter(s => s.tier === tier)
    if (list.length) acc[tier] = list
    return acc
  }, {})

  return (
    <SectionWrapper title="Sponsors">
      <div className="flex flex-col gap-5">
        {Object.entries(byTier).map(([tier, list]) => (
          <div key={tier}>
            <p className="mb-2 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
              {SPONSOR_TIER_LABELS[tier as SponsorTier]}
            </p>
            <div className={cn(
              'grid gap-2',
              tier === 'title'  ? 'grid-cols-1 sm:grid-cols-2'
                : tier === 'gold' ? 'grid-cols-2 sm:grid-cols-3'
                : 'grid-cols-3 sm:grid-cols-4',
            )}>
              {list.map(sponsor => (
                <a
                  key={sponsor.id}
                  href={sponsor.website || '#'}
                  target={sponsor.website ? '_blank' : undefined}
                  rel="noopener noreferrer"
                  aria-label={sponsor.name}
                  className={cn(
                    'flex items-center justify-center rounded-xl border border-border/60 bg-card p-3 transition-all hover:border-primary/30 hover:bg-primary/5',
                    !sponsor.website && 'pointer-events-none',
                  )}
                >
                  {sponsor.logoUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={sponsor.logoUrl} alt={sponsor.name} className="max-h-10 w-auto object-contain" />
                  ) : (
                    <span className="text-xs font-semibold text-foreground">{sponsor.name}</span>
                  )}
                </a>
              ))}
            </div>
          </div>
        ))}
      </div>
    </SectionWrapper>
  )
}
