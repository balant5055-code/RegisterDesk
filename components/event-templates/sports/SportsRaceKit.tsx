// Race Kit & Logistics — sports logistics on the Public Event Framework (RD-PUBLIC-04).
// Tokenised, no framer (pure/server-safe), consumes SectionShell/SectionHeader/CARD.

import { Package, Briefcase } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { formatDate } from '@/components/event-templates/shared/utils/format'
import { SectionShell, SectionHeader, CARD } from '@/components/event-templates/shared/ui/framework'

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
      <SectionHeader eyebrow="Race Kit" title="Kit & Logistics" />

      <div className={cn('grid grid-cols-1 gap-4', items.length > 1 ? 'sm:grid-cols-2' : 'max-w-lg')}>
        {items.map(({ icon: Icon, label, content }) => (
          <div key={label} className={cn(CARD, 'flex items-start gap-3.5 p-5')}>
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <Icon className="size-5" aria-hidden />
            </span>
            <div className="min-w-0">
              <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-muted-foreground">{label}</p>
              <p className="mt-1 whitespace-pre-line text-[14px] leading-relaxed text-foreground/80">{content}</p>
            </div>
          </div>
        ))}
      </div>
    </SectionShell>
  )
}
