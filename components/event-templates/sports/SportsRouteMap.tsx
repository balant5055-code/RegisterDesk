// Course / Route — sports logistics on the Public Event Framework (RD-PUBLIC-04).
// Tokenised, no framer (pure/server-safe), consumes SectionShell/SectionHeader/CARD.

import { Droplets, HeartPulse, ExternalLink } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import {
  SectionShell, EventSectionHeader, CARD, CARD_PAD, GRID_GAP, TYPE, ICON_TILE, ICON_TILE_ICON,
} from '@/components/event-templates/shared/ui/framework'

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
      {/* ST41-F01: the header-level CTA now uses EventSectionHeader's `actions` slot
          instead of a hand-rolled flex row wrapping a mb-0 header. */}
      <EventSectionHeader
        eyebrow={eyebrow ?? 'The Course'}
        title={sectionTitle ?? 'Course & Route'}
        actions={rules && (
          <a href={rules} target="_blank" rel="noopener noreferrer"
            className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border/80 bg-card px-4 py-2 text-fs-sm font-semibold text-foreground outline-none transition-colors hover:border-primary/40 hover:text-primary focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-offset-2">
            Event Rules<ExternalLink className="size-3.5" aria-hidden />
          </a>
        )}
      />

      {hasMap && (
        <div className={cn(CARD, 'overflow-hidden', infoCards.length > 0 && 'mb-6')}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={routeMapUrl} alt="Course route map" loading="lazy" decoding="async" className="w-full object-contain" />
        </div>
      )}

      {infoCards.length > 0 && (
        <div className={cn('grid grid-cols-1', GRID_GAP, infoCards.length === 2 ? 'sm:grid-cols-2' : 'sm:grid-cols-1')}>
          {infoCards.map(({ icon: Icon, label, text }) => (
            <div key={label} className={cn(CARD, CARD_PAD)}>
              <span className={cn('mb-3.5', ICON_TILE)}>
                <Icon className={ICON_TILE_ICON} aria-hidden />
              </span>
              <p className={TYPE.label}>{label}</p>
              <p className="mt-1 whitespace-pre-line text-fs-base leading-relaxed text-foreground/80">{text}</p>
            </div>
          ))}
        </div>
      )}
    </SectionShell>
  )
}
