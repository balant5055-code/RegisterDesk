'use client'

// RD-RACEOPS-01 · Race Operations — one stage block in the Publish Results flow.
//
// A labelled <section> with a heading + supporting line, used for every stage so
// their typography and spacing are defined ONCE. This is composition, not a
// duplicate primitive: components/ui/SectionHeader is the marketing-scale section
// heading (--fs-xl/--fs-2xl, scroll-animated) and would compete with the page's h1.
// Type scale and colours come from the existing token layer only.

import type { ReactNode } from 'react'
import { useId } from 'react'

export interface StageSectionProps {
  title:        string
  description?: string
  children:     ReactNode
}

export function StageSection({ title, description, children }: StageSectionProps) {
  const headingId = useId()

  return (
    <section aria-labelledby={headingId} className="space-y-3">
      <div className="space-y-1">
        <h2
          id={headingId}
          className="text-fs-lg font-semibold tracking-tight text-foreground"
        >
          {title}
        </h2>
        {description && (
          <p className="text-fs-sm leading-relaxed text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      {children}
    </section>
  )
}
