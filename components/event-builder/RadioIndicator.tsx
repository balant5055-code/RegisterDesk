'use client'

// RD-PRODUCT-01G Phase 6 — the shared Event Builder radio dot.
//
// Extracted VERBATIM from the Event Builder monolith. A pure presentational indicator
// SHARED by Step 2 (VisibilityCard) and Step 3 (access-control / confirmation cards), so it
// lives in the shared event-builder folder rather than any single step's file. No state,
// effects, or logic — driven entirely by the `selected` prop.

import { cn } from '@/lib/utils/cn'

export function RadioIndicator({ selected }: { selected: boolean }) {
  return (
    <div
      aria-hidden
      className={cn(
        'flex size-[22px] items-center justify-center rounded-full border-2 transition-all duration-200',
        selected ? 'border-primary bg-primary' : 'border-border bg-card',
      )}
    >
      {selected && <div className="size-2.5 rounded-full bg-white" />}
    </div>
  )
}
