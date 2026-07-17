// Phase P.1.3 — Marketing shell. Server Component.
//
// Provides the white-first canvas for all public marketing pages. Navigation and
// footer are NOT included here (later phases); this is only the page wrapper so
// marketing stays isolated from the application chrome.

import type { ReactNode } from 'react'
import { cn } from '@/lib/utils/cn'

export function MarketingLayout({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cn('min-h-screen bg-white text-foreground antialiased', className)}>
      {children}
    </div>
  )
}
