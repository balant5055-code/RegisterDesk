// "The Platform" — reusable preview panel. A hairline white card with an optional
// title + action row, used to compose the module previews.

import type { ReactNode } from 'react'
import { cn } from '@/lib/utils/cn'

export function PlatformPreviewCard({ title, action, className, children }: {
  title?: string; action?: ReactNode; className?: string; children: ReactNode
}) {
  return (
    <div className={cn('rounded-xl border border-border/60 bg-white p-3', className)}>
      {(title || action) && (
        <div className="mb-2.5 flex items-center justify-between gap-2">
          {title && <span className="text-[var(--fs-xs)] font-semibold text-foreground">{title}</span>}
          {action}
        </div>
      )}
      {children}
    </div>
  )
}
