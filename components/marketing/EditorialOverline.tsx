// The public site's editorial section label — a bronze hairline, then widely tracked
// small caps (and, centred, a second hairline after). The luxury replacement for the pill
// Eyebrow on the pages that have moved to the editorial voice. Server Component.

import type { ReactNode } from 'react'
import { cn } from '@/lib/utils/cn'

export function EditorialOverline({
  children, align = 'center', className,
}: {
  children: ReactNode
  align?: 'center' | 'left'
  className?: string
}) {
  const rule = <span aria-hidden className="h-px w-8 shrink-0 bg-hero-accent-rule" />
  return (
    <p
      className={cn(
        'flex items-center gap-3 text-fs-2xs font-semibold uppercase tracking-[0.22em] text-hero-eyebrow',
        align === 'center' && 'justify-center',
        className,
      )}
    >
      {rule}
      {children}
      {align === 'center' && rule}
    </p>
  )
}
