// Shared discovery results grid (events + causes). The canonical responsive grid
// used across the public discovery surfaces: 1 / 2 / 3 columns, gap-5.

import type { ReactNode } from 'react'
import { cn } from '@/lib/utils/cn'

export function DiscoveryGrid({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cn('grid gap-5 sm:grid-cols-2 lg:grid-cols-3', className)}>
      {children}
    </div>
  )
}
