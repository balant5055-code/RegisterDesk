import type { LucideIcon } from 'lucide-react'
import { TrendingDown, TrendingUp } from 'lucide-react'
import { KpiCardSkeleton } from './Skeleton'
import { cn } from '@/lib/utils/cn'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface StatCardProps {
  label:     string
  value:     string
  delta:     string
  trend:     'up' | 'down'
  icon:      LucideIcon
  iconColor: string
  iconBg:    string
  loading?:  boolean
}

// ─── StatCard ─────────────────────────────────────────────────────────────────

export function StatCard({
  label,
  value,
  delta,
  trend,
  icon: Icon,
  iconColor,
  iconBg,
  loading,
}: StatCardProps) {
  if (loading) return <KpiCardSkeleton />

  return (
    <div
      className="rounded-xl border border-border bg-card p-4 shadow-sm"
      role="figure"
      aria-label={`${label}: ${value}. Change: ${delta}`}
    >
      <div className="flex items-start justify-between">
        <div className={cn('flex size-9 items-center justify-center rounded-lg', iconBg)}>
          <Icon className={cn('size-[17px]', iconColor)} aria-hidden />
        </div>
        {trend === 'up'
          ? <TrendingUp   className="size-3.5 text-emerald-500" aria-hidden />
          : <TrendingDown className="size-3.5 text-destructive"  aria-hidden />
        }
      </div>

      <p className="mt-3 text-[28px] font-bold leading-none tracking-tight text-foreground">
        {value}
      </p>
      <p className="mt-1.5 text-[13px] text-muted-foreground">{label}</p>
      <p
        className={cn(
          'mt-1.5 text-[13px] font-medium',
          trend === 'up' ? 'text-emerald-600' : 'text-destructive',
        )}
      >
        {delta}
      </p>
    </div>
  )
}
