// Course / Route — sports logistics on the Public Event Framework (RD-PUBLIC-04).
// Tokenised, no framer (pure/server-safe), consumes SectionShell/SectionHeader/CARD.

import { Droplets, HeartPulse, ExternalLink } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { SectionShell, SectionHeader, CARD } from '@/components/event-templates/shared/ui/framework'

export interface SportsRouteMapProps {
  routeMapUrl?:      string
  hydrationPoints?:  string
  medicalSupport?:   string
  rulesUrl?:         string
  eyebrow?:          string
  sectionTitle?:     string
  sectionSubtitle?:  string
  hydrationLabel?:   string
}

export function SportsRouteMap({
  routeMapUrl, hydrationPoints, medicalSupport, rulesUrl,
  eyebrow, sectionTitle, hydrationLabel,
}: SportsRouteMapProps) {
  const hasMap  = !!routeMapUrl?.trim()
  const rules   = rulesUrl?.trim()
  const infoCards = [
    hydrationPoints?.trim() && { icon: Droplets,   label: hydrationLabel ?? 'Hydration Points', text: hydrationPoints.trim() },
    medicalSupport?.trim()  && { icon: HeartPulse, label: 'Medical Support',                    text: medicalSupport.trim() },
  ].filter(Boolean) as { icon: typeof Droplets; label: string; text: string }[]

  if (!hasMap && infoCards.length === 0 && !rules) return null

  return (
    <SectionShell id="route" maxW="6xl">
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <SectionHeader eyebrow={eyebrow ?? 'The Course'} title={sectionTitle ?? 'Course & Route'} className="mb-0" />
        {rules && (
          <a href={rules} target="_blank" rel="noopener noreferrer"
            className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border/80 bg-card px-4 py-2 text-[13.5px] font-semibold text-foreground transition-colors hover:border-primary/40 hover:text-primary">
            Event Rules<ExternalLink className="size-3.5" aria-hidden />
          </a>
        )}
      </div>

      {hasMap && (
        <div className={cn(CARD, 'overflow-hidden', infoCards.length > 0 && 'mb-6')}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={routeMapUrl} alt="Course route map" loading="lazy" decoding="async" className="w-full object-contain" />
        </div>
      )}

      {infoCards.length > 0 && (
        <div className={cn('grid grid-cols-1 gap-4', infoCards.length === 2 ? 'sm:grid-cols-2' : 'sm:grid-cols-1')}>
          {infoCards.map(({ icon: Icon, label, text }) => (
            <div key={label} className={cn(CARD, 'p-5')}>
              <span className="mb-3 inline-flex size-9 items-center justify-center rounded-xl bg-primary/10 text-primary">
                <Icon className="size-[18px]" aria-hidden />
              </span>
              <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-muted-foreground">{label}</p>
              <p className="mt-1 whitespace-pre-line text-[14px] leading-relaxed text-foreground/80">{text}</p>
            </div>
          ))}
        </div>
      )}
    </SectionShell>
  )
}
