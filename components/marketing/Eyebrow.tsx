// Shared marketing eyebrow pill (Hero + section headers use the SAME component —
// no duplicated styles). White pill, hairline border, soft shadow, gradient dot,
// uppercase 12px/700, 0.18em tracking, 36px tall.

import type { ReactNode } from 'react'
import { cn } from '@/lib/utils/cn'

// The RegisterDesk brand gradient utility (#fb5a6a → #e5277e — matches --primary-gradient).
export const BRAND_GRADIENT = 'bg-[linear-gradient(90deg,#fb5a6a,#e5277e)]'

export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex h-9 items-center gap-2 rounded-full border border-border/60 bg-white px-4 text-[var(--fs-xs)] font-bold uppercase tracking-[0.18em] text-primary shadow-sm',
        className,
      )}
    >
      <span className={cn('size-2 rounded-full', BRAND_GRADIENT)} aria-hidden />
      {children}
    </span>
  )
}
