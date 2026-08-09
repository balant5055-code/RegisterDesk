'use client'

// RD-RACEOPS-01 · Race Operations — event selector (Publish Results, stage 1).
//
// Lists the events the caller's workspace owns and lets one be selected. Ownership
// is NOT filtered here: the data comes from GET /api/organizer/events, which is
// already workspace-scoped server-side (see hooks/useRaceOpsEvents.ts). This
// component only presents and selects.
//
// Ineligible events (drafts, cancelled, archived, or no races configured) are still
// LISTED but disabled with the honest reason from utils/eligibility.ts — an event
// never silently disappears.
//
// Reuses: Card, EmptyState, ErrorState, Skeleton, LoadMoreButton, eventLifecycleMeta.

import { CalendarDays, Check, Flag } from 'lucide-react'
import { EmptyState, ErrorState, Skeleton } from '@/components/ui'
// components/admin/* are presentation-only primitives with no admin coupling — the
// repo's barrel comment says to import them rather than re-hand-roll list controls.
import { LoadMoreButton } from '@/components/admin'
import { eventLifecycleMeta } from '@/lib/ui/statusColors'
import { cn } from '@/lib/utils/cn'
import { resolveRaceOpsEligibility } from '@/features/race-operations/utils/eligibility'
import type { RaceOpsEventRow, RaceOpsEventsState } from '@/features/race-operations/hooks/useRaceOpsEvents'

function fmtDate(dateStr: string | null): string {
  if (!dateStr) return 'Date not set'
  const [y, m, d] = dateStr.split('-').map(Number)
  if (!y || !m || !d) return 'Date not set'
  return new Date(y, m - 1, d).toLocaleDateString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric',
  })
}

export interface EventSelectorProps {
  state:            RaceOpsEventsState
  selectedEventId:  string | null
  onSelect:         (event: RaceOpsEventRow) => void
}

export function EventSelector({ state, selectedEventId, onSelect }: EventSelectorProps) {
  const { events, loading, loadingMore, error, hasMore, loadMore } = state

  if (loading) {
    return (
      <div className="space-y-2.5" aria-busy="true" aria-label="Loading your events">
        {[0, 1, 2].map(i => <Skeleton key={i} className="h-[76px] w-full rounded-xl" />)}
      </div>
    )
  }

  if (error) {
    return <ErrorState message={error} />
  }

  if (events.length === 0) {
    return (
      <EmptyState
        icon={CalendarDays}
        title="No events yet"
        description="Create and publish an event before recording race results."
        action={{ label: 'Create event', href: '/dashboard/events/new/visibility' }}
      />
    )
  }

  return (
    <div className="space-y-3">
      <ul className="space-y-2.5">
        {events.map(event => {
          const { eligible, reason } = resolveRaceOpsEligibility(event.lifecycleStatus, event.raceCount)
          const selected = event.eventId === selectedEventId
          const meta     = eventLifecycleMeta[event.lifecycleStatus]
            ?? { label: event.lifecycleStatus, cls: 'bg-muted text-muted-foreground' }

          return (
            <li key={event.eventId}>
              <button
                type="button"
                disabled={!eligible}
                onClick={() => onSelect(event)}
                aria-pressed={selected}
                className={cn(
                  'w-full rounded-xl border bg-card p-4 text-left transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                  eligible
                    ? selected
                      ? 'border-primary/50 bg-primary/[0.04]'
                      : 'border-border hover:border-border-strong hover:bg-muted/40'
                    : 'cursor-not-allowed border-border/60 opacity-60',
                )}
              >
                <div className="flex items-start gap-3">
                  <div
                    className={cn(
                      'flex size-9 shrink-0 items-center justify-center rounded-lg',
                      selected ? 'bg-primary text-primary-foreground' : 'bg-muted',
                    )}
                    aria-hidden
                  >
                    {selected
                      ? <Check className="size-4" />
                      : <Flag className="size-4 text-muted-foreground" />}
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="truncate text-[14.5px] font-semibold text-foreground">
                        {event.name}
                      </p>
                      <span className={cn('rounded-md px-1.5 py-0.5 text-[11px] font-medium', meta.cls)}>
                        {meta.label}
                      </span>
                    </div>

                    <p className="mt-1 text-[13px] text-muted-foreground">
                      {fmtDate(event.startDate)}
                      {' · '}
                      {event.raceCount === 1 ? '1 race' : `${event.raceCount} races`}
                    </p>

                    {!eligible && reason && (
                      <p className="mt-1.5 text-[12.5px] text-muted-foreground/80">{reason}</p>
                    )}
                  </div>
                </div>
              </button>
            </li>
          )
        })}
      </ul>

      {hasMore && <LoadMoreButton onClick={loadMore} loading={loadingMore} label="Load more events" />}
    </div>
  )
}
