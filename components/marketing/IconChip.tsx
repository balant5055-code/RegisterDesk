// Shared marketing icon container ("chip") — LS2.3C-B.
//
// Owns ONLY the container surface: flex centering + radius + filled brand
// background + ring. The icon, its size/color, the chip size (size-10 / size-11),
// and any layout (shrink-0) stay in the consumer's className / children. Reuses
// the existing tokens + cn — no new visuals, no size normalization.
//
//   <IconChip className="size-11"><Icon className="size-5 text-primary" /></IconChip>

import type { ReactNode } from 'react'
import { cn } from '@/lib/utils/cn'

/** The filled brand icon-chip surface (the appearance the in-scope consumers use). */
export const ICON_CHIP_BASE =
  'flex items-center justify-center rounded-xl bg-primary/10 ring-1 ring-inset ring-primary/20'

export function IconChip({ className, children }: { className?: string; children: ReactNode }) {
  return <span className={cn(ICON_CHIP_BASE, className)}>{children}</span>
}
