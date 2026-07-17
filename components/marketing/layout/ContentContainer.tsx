// Phase P.1.3 — Reading-width container (820px) for prose / legal / docs. Server Component.

import type { ReactNode } from 'react'
import { cn } from '@/lib/utils/cn'
import { MARKETING_CONTAINER } from '@/lib/marketing/layout'

export function ContentContainer({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn(MARKETING_CONTAINER.content, className)}>{children}</div>
}
