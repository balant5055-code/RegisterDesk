// Marketing product UI kit — MetricTile. A compact metric card (icon + label +
// value) used in product surfaces. Reusable. Hairline border + soft card shadow.
// No fake charts.

import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { typography } from '@/lib/ds/typography'

export function MetricTile({ icon: Icon, label, value, className }: {
  icon?: LucideIcon; label: string; value: string; className?: string
}) {
  return (
    <div className={cn('rounded-xl border border-border/60 bg-white p-3', className)}>
      <div className="flex items-center gap-2">
        {Icon && (
          <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
            <Icon className="size-3.5" strokeWidth={1.8} aria-hidden />
          </span>
        )}
        <span className={cn('truncate text-muted-foreground', typography.metricLabel)}>{label}</span>
      </div>
      <div className="mt-2 text-[22px] font-bold leading-none tracking-tight text-foreground">{value}</div>
    </div>
  )
}
