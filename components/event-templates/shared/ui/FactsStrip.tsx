import { Calendar, Clock, MapPin, Globe, ExternalLink } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import type { PhysicalVenueConfig } from '@/components/wizard/eventDetailsConfig'
import { formatDate, formatDateShort, formatTime } from '@/components/event-templates/shared/utils/format'

export function FactsStrip({ startDate, startTime, endDate, endTime, doorsOpenTime,
  venueName, venueType, physical, mapsLink }: {
  startDate:     string
  startTime:     string
  endDate:       string
  endTime:       string
  doorsOpenTime: string
  venueName:     string
  venueType:     string
  physical?:     PhysicalVenueConfig
  mapsLink:      string
}) {
  type Cell = {
    icon:  React.ReactNode
    label: string
    value: string
    sub?:  string
    href?: string
  }

  const cells: Cell[] = [
    startDate ? {
      icon:  <Calendar className="size-4 shrink-0 text-primary" aria-hidden />,
      label: 'DATE',
      value: startDate === endDate
        ? formatDate(startDate)
        : `${formatDateShort(startDate)} – ${formatDateShort(endDate)}`,
      sub: doorsOpenTime ? `Doors open ${formatTime(doorsOpenTime)}` : undefined,
    } : null,
    startTime ? {
      icon:  <Clock className="size-4 shrink-0 text-primary" aria-hidden />,
      label: 'TIME',
      value: `${formatTime(startTime)}${endTime ? ` – ${formatTime(endTime)}` : ''}`,
    } : null,
    venueName ? {
      icon:  venueType === 'online'
        ? <Globe  className="size-4 shrink-0 text-primary" aria-hidden />
        : <MapPin className="size-4 shrink-0 text-primary" aria-hidden />,
      label: venueType === 'online' ? 'PLATFORM' : 'LOCATION',
      value: venueName,
      sub:   physical?.city
        ? [physical.city, physical.state].filter(Boolean).join(', ')
        : undefined,
      href:  mapsLink || undefined,
    } : null,
  ].filter(Boolean) as Cell[]

  if (!cells.length) return null

  const count = cells.length

  function borderClass(i: number): string {
    if (count === 1) return ''
    if (count === 2) {
      return i === 0
        ? 'border-b border-border/50 sm:border-b-0 sm:border-r'
        : ''
    }
    // 3 columns
    if (i === 0) return 'border-b border-border/50 sm:border-b-0 sm:border-r'
    if (i === 1) return 'border-b border-border/50 sm:border-b-0 lg:border-r'
    return 'sm:col-span-2 sm:border-t sm:border-border/50 lg:col-span-1 lg:border-t-0'
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-border/60 bg-card shadow-sm">
      <div className={cn(
        'grid grid-cols-1',
        count >= 2 && 'sm:grid-cols-2',
        count === 3 && 'lg:grid-cols-3',
      )}>
        {cells.map((cell, i) => (
          <div
            key={i}
            className={cn(
              'group flex items-start gap-3 px-5 py-4',
              'transition-colors duration-150 hover:bg-muted/30',
              borderClass(i),
            )}
          >
            <span className="mt-[3px] shrink-0">{cell.icon}</span>
            <div className="min-w-0 flex-1">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">
                {cell.label}
              </p>
              <p className="mt-1 text-[13.5px] font-semibold leading-snug text-foreground">
                {cell.value}
              </p>
              {cell.sub && (
                <p className="mt-0.5 text-xs text-muted-foreground">{cell.sub}</p>
              )}
              {cell.href && (
                <a
                  href={cell.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-1.5 inline-flex items-center gap-1 text-[11px] font-semibold text-primary hover:underline"
                >
                  Get directions
                  <ExternalLink className="size-2.5" aria-hidden />
                </a>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
