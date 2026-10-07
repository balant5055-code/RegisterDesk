// Shared marketing eyebrow pill (Hero + section headers use the SAME component —
// no duplicated styles). White pill, hairline border, soft shadow, gradient dot,
// uppercase 12px/700, 0.18em tracking, 36px tall.

import type { ReactNode } from 'react'
import { cn } from '@/lib/utils/cn'

// The canonical brand gradient, named — never re-typed. One definition, in globals.css
// (.rd-brand-gradient → --action-gradient). It used to hand-roll the retired coral→magenta
// ramp inline, which is how a second opinion about the brand colour gets into the CSS.
export const BRAND_GRADIENT = 'rd-brand-gradient'

export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex h-9 items-center gap-2 rounded-full border border-border/60 bg-card px-4 text-fs-xs font-bold uppercase tracking-[0.18em] text-action shadow-sm',
        className,
      )}
    >
      <span className={cn('size-2 rounded-full', BRAND_GRADIENT)} aria-hidden />
      {children}
    </span>
  )
}
