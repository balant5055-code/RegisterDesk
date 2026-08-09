'use client'

// RD-RACEOPS-01 · Race Operations — declared placeholder for a not-yet-built stage.
//
// Sprint 1 ships the Publish Results flow as a navigable shell. Upload, Validation,
// Preview and Publish are placeholders. This component exists so each placeholder is
// HONEST and identical in shape: it states what the stage will do, which sprint
// delivers it, and offers no control that pretends to work. There are no disabled
// "Upload" buttons that silently do nothing.
//
// Composed from the existing Card + StatusChip primitives — no new visual language.

import type { LucideIcon } from 'lucide-react'
import { Card, StatusChip } from '@/components/ui'

export interface PlannedStageProps {
  icon:        LucideIcon
  title:       string
  /** What the organizer will be able to do here, in plain language. */
  description: string
  /** e.g. "Sprint 3" — never vague. */
  sprint:      string
  /** Concrete capabilities this stage will provide. */
  capabilities: string[]
}

export function PlannedStage({
  icon: Icon, title, description, sprint, capabilities,
}: PlannedStageProps) {
  return (
    <Card>
      <div className="flex items-start gap-3.5">
        <div
          className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted"
          aria-hidden
        >
          <Icon className="size-[18px] text-muted-foreground" />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-[15px] font-semibold text-foreground">{title}</h3>
            <StatusChip tone="neutral">Planned · {sprint}</StatusChip>
          </div>

          <p className="mt-1 text-[13.5px] leading-relaxed text-muted-foreground">
            {description}
          </p>

          <ul className="mt-3 space-y-1.5">
            {capabilities.map(cap => (
              <li key={cap} className="flex items-start gap-2 text-[13px] text-muted-foreground">
                <span
                  className="mt-[7px] size-1.5 shrink-0 rounded-full bg-muted-foreground/30"
                  aria-hidden
                />
                <span>{cap}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Card>
  )
}
