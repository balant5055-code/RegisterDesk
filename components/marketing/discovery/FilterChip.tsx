// Shared discovery filter chip (events + causes). Presentation only — the toggle
// state and handler live in the page. Canonical style: solid-primary when active,
// hairline-outline card when inactive (converged from the /events chip).

import type { ReactNode } from 'react'
import { cn } from '@/lib/utils/cn'

export function FilterChip({
  active,
  onClick,
  className,
  children,
}: {
  active:     boolean
  onClick:    () => void
  className?: string
  children:   ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'shrink-0 cursor-pointer rounded-full px-3.5 py-1.5 text-[12.5px] font-semibold transition-all',
        active
          ? 'bg-primary text-white shadow-sm'
          : 'border border-border/70 bg-card text-foreground hover:border-primary/30 hover:bg-primary/[0.04] hover:text-primary',
        className,
      )}
    >
      {children}
    </button>
  )
}
