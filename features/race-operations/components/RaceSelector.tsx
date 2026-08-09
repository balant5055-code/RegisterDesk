'use client'

// RD-RACEOPS-01 · Race Operations — race / distance selector (Publish Results, stage 2).
//
// Per the approved Phase 0 decision (D2): a race DISTANCE is a PASS on the event
// (`events/{slug}.pricing.passes[]`). RegisterDesk has no separate distance field and
// this module does not invent one. The list therefore comes from the `passes` array
// that GET /api/organizer/events already returns — no extra request, no new schema.
//
// Presentational + selection only.

import { Check, Timer } from 'lucide-react'
import { EmptyState } from '@/components/ui'
import { cn } from '@/lib/utils/cn'
import type { RaceOpsRaceSelection } from '@/features/race-operations/types'

export interface RaceSelectorProps {
  races:          RaceOpsRaceSelection[]
  selectedPassId: string | null
  onSelect:       (race: RaceOpsRaceSelection) => void
}

export function RaceSelector({ races, selectedPassId, onSelect }: RaceSelectorProps) {
  if (races.length === 0) {
    return (
      <EmptyState
        icon={Timer}
        size="sm"
        title="No races configured"
        description="Each race distance is a pass on the event. Add at least one pass to record results."
      />
    )
  }

  return (
    <ul className="grid gap-2.5 sm:grid-cols-2">
      {races.map(race => {
        const selected = race.passId === selectedPassId
        return (
          <li key={race.passId}>
            <button
              type="button"
              onClick={() => onSelect(race)}
              aria-pressed={selected}
              className={cn(
                'w-full rounded-xl border bg-card p-3.5 text-left transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                selected
                  ? 'border-primary/50 bg-primary/[0.04]'
                  : 'border-border hover:border-border-strong hover:bg-muted/40',
              )}
            >
              <div className="flex items-center gap-3">
                <div
                  className={cn(
                    'flex size-8 shrink-0 items-center justify-center rounded-lg',
                    selected ? 'bg-primary text-primary-foreground' : 'bg-muted',
                  )}
                  aria-hidden
                >
                  {selected
                    ? <Check className="size-3.5" />
                    : <Timer className="size-3.5 text-muted-foreground" />}
                </div>
                <div className="min-w-0">
                  <p className="truncate text-[14px] font-semibold text-foreground">{race.name}</p>
                  <p className="mt-0.5 text-[12.5px] text-muted-foreground">
                    {race.registrations === 1
                      ? '1 confirmed participant'
                      : `${race.registrations.toLocaleString('en-IN')} confirmed participants`}
                  </p>
                </div>
              </div>
            </button>
          </li>
        )
      })}
    </ul>
  )
}
