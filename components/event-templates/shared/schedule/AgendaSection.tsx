import { MapPin } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import type { AgendaSession } from '@/components/wizard/eventDetailsConfig'
import { SESSION_TYPE_LABELS } from '@/components/wizard/eventDetailsConfig'
import { SectionWrapper } from '@/components/event-templates/shared/ui/SectionWrapper'
import { formatDate, formatTime } from '@/components/event-templates/shared/utils/format'

export function AgendaSection({ agenda }: { agenda: AgendaSession[] }) {
  const sorted = [...agenda]
    .filter(s => s.title?.trim())
    .sort((a, b) => `${a.date}${a.startTime}`.localeCompare(`${b.date}${b.startTime}`))

  const byDate = sorted.reduce<Record<string, AgendaSession[]>>((acc, s) => {
    const key = s.date || ''
    ;(acc[key] ??= []).push(s)
    return acc
  }, {})
  const dates = Object.keys(byDate).sort()

  return (
    <SectionWrapper
      id="schedule"
      title="Event Schedule"
      subtitle={`${sorted.length} session${sorted.length !== 1 ? 's' : ''}`}
    >
      <div className="flex flex-col gap-6">
        {dates.map(date => (
          <div key={date}>
            {date && dates.length > 1 && (
              <p className="mb-3 text-[10.5px] font-bold uppercase tracking-widest text-muted-foreground">
                {formatDate(date)}
              </p>
            )}
            <div className="flex flex-col">
              {byDate[date].map((session, idx) => (
                <div key={session.id} className={cn('flex gap-4', session.isBreak && 'opacity-50')}>
                  {/* Time */}
                  <div className="w-[72px] shrink-0 pt-[9px] text-right">
                    <p className="text-[11px] font-semibold tabular-nums text-muted-foreground">
                      {formatTime(session.startTime)}
                    </p>
                    {session.endTime && (
                      <p className="mt-0.5 text-[10px] text-muted-foreground/60">
                        –{formatTime(session.endTime)}
                      </p>
                    )}
                  </div>
                  {/* Timeline dot + line */}
                  <div className="flex flex-col items-center">
                    <div className={cn(
                      'mt-[9px] size-2.5 shrink-0 rounded-full border-2 border-background',
                      session.isBreak ? 'bg-border' : 'bg-primary',
                    )} />
                    {idx < byDate[date].length - 1 && (
                      <div className="mt-1 w-px flex-1 bg-border/50 pb-4" />
                    )}
                  </div>
                  {/* Content */}
                  <div className="min-w-0 flex-1 pb-5 pt-[5px]">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <p className={cn(
                        'text-sm font-semibold',
                        session.isBreak ? 'text-muted-foreground' : 'text-foreground',
                      )}>
                        {session.title}
                      </p>
                      {!session.isBreak && session.type && (
                        <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary">
                          {SESSION_TYPE_LABELS[session.type] ?? session.type}
                        </span>
                      )}
                      {session.track && (
                        <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                          {session.track}
                        </span>
                      )}
                    </div>
                    {session.description && !session.isBreak && (
                      <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground line-clamp-2">
                        {session.description}
                      </p>
                    )}
                    {session.location && (
                      <p className="mt-0.5 flex items-center gap-1 text-[11px] text-muted-foreground">
                        <MapPin className="size-2.5 shrink-0" aria-hidden />
                        {session.location}
                      </p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </SectionWrapper>
  )
}
