'use client'

// RD-RACEOPS-01 · Race Operations — Publish Results stage indicator.
//
// Shows the six stages of the flow and where the organizer currently is. Purely
// presentational; it holds no state and triggers no work. Uses the existing token
// layer (bg-primary, border-border, text-muted-foreground) and `cn` — no new colours.

import { Check } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { RACE_OPS_STAGE_ORDER, type RaceOpsStageKey } from '@/features/race-operations/types'

const STAGE_LABEL: Record<RaceOpsStageKey, string> = {
  event:    'Event',
  race:     'Race',
  upload:   'Upload',
  validate: 'Validate',
  preview:  'Preview',
  publish:  'Publish',
}

export interface StageStepperProps {
  /** The furthest stage the organizer has reached. */
  current: RaceOpsStageKey
}

export function StageStepper({ current }: StageStepperProps) {
  const currentIndex = RACE_OPS_STAGE_ORDER.indexOf(current)

  return (
    <ol
      aria-label="Publish results progress"
      className="flex flex-wrap items-center gap-x-1 gap-y-2"
    >
      {RACE_OPS_STAGE_ORDER.map((stage, i) => {
        const done   = i < currentIndex
        const active = i === currentIndex

        return (
          <li key={stage} className="flex items-center gap-1">
            <div
              className={cn(
                'flex items-center gap-2 rounded-lg border px-2.5 py-1.5',
                active && 'border-primary/40 bg-primary/[0.06]',
                done   && 'border-border bg-muted/50',
                !active && !done && 'border-border/60',
              )}
              aria-current={active ? 'step' : undefined}
            >
              <span
                className={cn(
                  'flex size-[18px] shrink-0 items-center justify-center rounded-full text-[10px] font-bold',
                  active ? 'bg-primary text-primary-foreground'
                    : done ? 'bg-muted-foreground/25 text-foreground'
                    : 'bg-muted text-muted-foreground',
                )}
                aria-hidden
              >
                {done ? <Check className="size-3" /> : i + 1}
              </span>
              <span
                className={cn(
                  'text-[13px] font-medium',
                  active ? 'text-primary' : done ? 'text-foreground' : 'text-muted-foreground',
                )}
              >
                {STAGE_LABEL[stage]}
              </span>
            </div>
            {i < RACE_OPS_STAGE_ORDER.length - 1 && (
              <span className="hidden h-px w-3 bg-border sm:block" aria-hidden />
            )}
          </li>
        )
      })}
    </ol>
  )
}
