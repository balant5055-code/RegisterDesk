// Shared gradient text — applies the RegisterDesk brand gradient (the same
// BRAND_GRADIENT the Hero/Journey use) as clipped text. One component, no
// duplicated styles.

import type { ReactNode } from 'react'
import { cn } from '@/lib/utils/cn'
import { BRAND_GRADIENT } from './Eyebrow'

export function GradientText({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn(BRAND_GRADIENT, 'bg-clip-text text-transparent [-webkit-background-clip:text]', className)}>
      {children}
    </span>
  )
}
