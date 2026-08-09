// Race Kit & Logistics — sports logistics on the Public Event Framework (RD-PUBLIC-04).
// Tokenised, no framer (pure/server-safe), consumes SectionShell/SectionHeader/CARD.

import { Package, Briefcase } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { formatDate } from '@/components/event-templates/shared/utils/format'
import { SectionShell, EventSectionHeader, CARD, CARD_PAD, GRID_GAP, TYPE, ICON_TILE, ICON_TILE_ICON } from '@/components/event-templates/shared/ui/framework'

export interface SportsRaceKitProps {
  kitCollectionInfo?: string
  kitCollectionDate?: string
  bagDepositInfo?:    string
}

export function SportsRaceKit({ kitCollectionInfo, kitCollectionDate, bagDepositInfo }: SportsRaceKitProps) {
  const items = [
    (kitCollectionInfo?.trim() || kitCollectionDate?.trim()) && {
      icon:    Package,
      label:   'Kit Collection',
      content: [
        kitCollectionDate?.trim() && formatDate(kitCollectionDate.trim()),
        kitCollectionInfo?.trim(),
      ].filter(Boolean).join('\n'),
    },
    bagDepositInfo?.trim() && { icon: Briefcase, label: 'Bag Deposit', content: bagDepositInfo.trim() },
  ].filter(Boolean) as { icon: typeof Package; label: string; content: string }[]

  if (items.length === 0) return null

  return (
    <SectionShell id="kit" maxW="6xl" bg="muted">
      <EventSectionHeader eyebrow="Race Kit" title="Kit & Logistics" />

      <div className={cn('grid grid-cols-1', GRID_GAP, items.length > 1 ? 'sm:grid-cols-2' : 'max-w-lg')}>
        {items.map(({ icon: Icon, label, content }) => (
          <div key={label} className={cn(CARD, CARD_PAD, 'flex items-start gap-4')}>
            <span className={ICON_TILE}>
              <Icon className={ICON_TILE_ICON} aria-hidden />
            </span>
            <div className="min-w-0">
              <p className={TYPE.label}>{label}</p>
              <p className="mt-1 whitespace-pre-line text-fs-base leading-relaxed text-foreground/80">{content}</p>
            </div>
          </div>
        ))}
      </div>
    </SectionShell>
  )
}
