'use client'

// Revenue wallet balance summary (Phase H.5.2) — read-only.
// Reuses GET /api/organizer/finance (FinanceOverview). No recalculation: every
// value is a persisted wallet bucket.

import { BarChart3, Clock, DollarSign, Truck, Wallet } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { Card } from '@/components/ui'
import { KpiCardSkeleton } from '@/components/dashboard/Skeleton'
import { formatCompactINR } from '@/lib/finance/format'
import type { FinanceOverview } from '@/app/api/organizer/finance/route'

export function RevenueWalletSummary({ overview, loading }: { overview: FinanceOverview | null; loading: boolean }) {
  const w = overview?.wallet
  const cards = [
    { label: 'Lifetime earnings', value: formatCompactINR(w?.lifetimeNetPaise ?? 0), sub: 'Net, all time',    icon: BarChart3,  color: 'text-violet-600',  bg: 'bg-violet-500/[0.09]'  },
    { label: 'Available',         value: formatCompactINR(w?.availablePaise   ?? 0), sub: 'Ready to settle',  icon: DollarSign, color: 'text-emerald-600', bg: 'bg-emerald-500/[0.09]' },
    { label: 'Pending',           value: formatCompactINR(w?.pendingPaise     ?? 0), sub: 'Awaiting T+2',     icon: Clock,      color: 'text-amber-600',   bg: 'bg-amber-500/[0.09]'   },
    { label: 'In-transit',        value: formatCompactINR(w?.inTransitPaise   ?? 0), sub: 'Payout in progress', icon: Truck,    color: 'text-blue-600',    bg: 'bg-blue-500/[0.09]'    },
    { label: 'Settled',           value: formatCompactINR(w?.settledPaise     ?? 0), sub: 'Paid to bank',     icon: Wallet,     color: 'text-primary',     bg: 'bg-primary/[0.09]'     },
  ]

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5" aria-label="Revenue wallet balances" aria-busy={loading}>
      {loading
        ? Array.from({ length: 5 }).map((_, i) => <KpiCardSkeleton key={i} />)
        : cards.map(({ label, value, sub, icon: Icon, color, bg }) => (
            <Card key={label} padded={false} className="p-4" role="figure" aria-label={`${label}: ${value}`}>
              <div className={cn('flex size-9 items-center justify-center rounded-lg', bg)}>
                <Icon className={cn('size-[17px]', color)} aria-hidden />
              </div>
              <p className="mt-3 text-[26px] font-bold leading-none tracking-tight text-foreground">{value}</p>
              <p className="mt-1.5 text-[13px] font-medium text-foreground">{label}</p>
              <p className="mt-0.5 text-[13px] text-muted-foreground">{sub}</p>
            </Card>
          ))
      }
    </div>
  )
}
