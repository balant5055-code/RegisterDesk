// Marketing product UI kit — StatusBadge. A small status pill used inside product
// surfaces (tables, panels). Reusable across the site. Built from design tokens
// + the Tailwind default success/warning palette. No hardcoded hex.

import { cn } from '@/lib/utils/cn'
import { typography } from '@/lib/ds/typography'

export type BadgeTone = 'success' | 'warning' | 'neutral' | 'brand'

const RING: Record<BadgeTone, string> = {
  success: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  warning: 'bg-amber-50 text-amber-700 ring-amber-600/20',
  neutral: 'bg-muted text-muted-foreground ring-border',
  brand:   'bg-primary/10 text-primary ring-primary/20',
}
const DOT: Record<BadgeTone, string> = {
  success: 'bg-emerald-500',
  warning: 'bg-amber-500',
  neutral: 'bg-muted-foreground/60',
  brand:   'bg-primary',
}

export function StatusBadge({ label, tone = 'neutral', className }: { label: string; tone?: BadgeTone; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 ring-1 ring-inset', typography.badge, RING[tone], className)}>
      <span className={cn('size-1.5 rounded-full', DOT[tone])} aria-hidden />
      {label}
    </span>
  )
}
