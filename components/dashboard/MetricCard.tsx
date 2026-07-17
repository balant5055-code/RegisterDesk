'use client'

// Phase H.2.1 — Reusable executive metric tile.
//
// Unlike StatCard, MetricCard never fabricates a trend/delta: the delta is
// OPTIONAL and rendered only when the caller has a real value to show. This keeps
// the dashboard honest (no fake "+12%" deltas) while staying visually premium.
//
// Visual scale (workspace spec): 16px radius card, 16px card title, 12px caption.

import { memo } from 'react'
import Link from 'next/link'
import type { LucideIcon } from 'lucide-react'
import { TrendingUp, TrendingDown, ArrowUpRight } from 'lucide-react'
import { KpiCardSkeleton } from './Skeleton'
import { cn } from '@/lib/utils/cn'

export interface MetricCardProps {
  label:      string
  value:      string
  /** Optional caption under the value (e.g. "today", "all-time"). */
  hint?:      string
  /** Optional truthful delta. Omit entirely when no real comparison exists. */
  delta?:     { text: string; trend: 'up' | 'down' | 'flat' }
  icon:       LucideIcon
  iconColor:  string
  iconBg:     string
  /** When set, the whole tile becomes a link with an affordance arrow. */
  href?:      string
  loading?:   boolean
  className?: string
}

function MetricCardImpl({
  label, value, hint, delta, icon: Icon, iconColor, iconBg, href, loading, className,
}: MetricCardProps) {
  if (loading) return <KpiCardSkeleton />

  const body = (
    <>
      <div className="flex items-start justify-between">
        <div className={cn('flex size-9 items-center justify-center rounded-xl', iconBg)}>
          <Icon className={cn('size-[17px]', iconColor)} aria-hidden />
        </div>
        {delta
          ? (
            <span
              className={cn(
                'inline-flex items-center gap-0.5 text-[12px] font-medium',
                delta.trend === 'up' ? 'text-emerald-600'
                  : delta.trend === 'down' ? 'text-destructive'
                  : 'text-muted-foreground',
              )}
            >
              {delta.trend === 'up' && <TrendingUp className="size-3" aria-hidden />}
              {delta.trend === 'down' && <TrendingDown className="size-3" aria-hidden />}
              {delta.text}
            </span>
          )
          : href
            ? <ArrowUpRight className="size-4 text-muted-foreground/50 transition-colors group-hover:text-foreground" aria-hidden />
            : null}
      </div>

      <p className="mt-3 text-[28px] font-bold leading-none tracking-tight text-foreground tabular-nums">
        {value}
      </p>
      <p className="mt-1.5 text-[13px] text-muted-foreground">{label}</p>
      {hint && <p className="mt-0.5 text-[12px] text-muted-foreground/70">{hint}</p>}
    </>
  )

  const base = cn(
    'group block rounded-2xl border border-border bg-card p-4 shadow-sm transition-colors',
    href && 'hover:border-primary/30 hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
    className,
  )

  if (href) {
    return (
      <Link href={href} className={base} aria-label={`${label}: ${value}`}>
        {body}
      </Link>
    )
  }

  return (
    <div className={base} role="figure" aria-label={`${label}: ${value}`}>
      {body}
    </div>
  )
}

export const MetricCard = memo(MetricCardImpl)
