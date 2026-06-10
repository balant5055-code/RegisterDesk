'use client'

import { useMemo }                                                from 'react'
import { cn }                                                     from '@/lib/utils/cn'
import { Users, TrendingUp, CheckCircle, XCircle, Percent }       from 'lucide-react'
import type { EventDetailResponse }                               from '@/app/api/organizer/events/[eventId]/route'
import type { SerializedRegistration }                            from '@/app/api/organizer/events/[eventId]/registrations/route'

function fmtINR(paise: number): string {
  if (paise === 0) return '₹0'
  return new Intl.NumberFormat('en-IN', {
    style: 'currency', currency: 'INR', maximumFractionDigits: 0,
  }).format(paise / 100)
}

function Stat({
  icon: Icon, label, value, sub, colorCls,
}: {
  icon: React.ElementType; label: string; value: string; sub?: string; colorCls?: string
}) {
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border bg-card p-4">
      <div className="flex items-center justify-between">
        <span className="text-[13px] text-muted-foreground">{label}</span>
        <div className="flex size-7 items-center justify-center rounded-lg bg-muted">
          <Icon className={cn('size-3.5', colorCls ?? 'text-muted-foreground')} />
        </div>
      </div>
      <p className="text-[22px] font-bold tabular-nums text-foreground">{value}</p>
      {sub && <p className="text-[13px] text-muted-foreground">{sub}</p>}
    </div>
  )
}

interface ReportsTabProps {
  event:         EventDetailResponse
  registrations: SerializedRegistration[]
}

export default function ReportsTab({ event, registrations }: ReportsTabProps) {
  const stats = useMemo(() => {
    const total     = registrations.length
    const confirmed = registrations.filter(r => r.status === 'confirmed').length
    const cancelled = registrations.filter(r => r.status === 'cancelled').length
    const pending   = total - confirmed - cancelled

    // Conversion: confirmed / total (excluding cancelled)
    const eligible  = total - cancelled
    const conversion = eligible > 0 ? Math.round((confirmed / eligible) * 100) : 0

    // Revenue from confirmed only
    const confirmedRevenue = registrations
      .filter(r => r.status === 'confirmed')
      .reduce((sum, r) => sum + (r.amount ?? 0), 0)

    return { total, confirmed, cancelled, pending, conversion, confirmedRevenue }
  }, [registrations])

  // Pass breakdown
  const passBreakdown = useMemo(() => {
    const map = new Map<string, { name: string; confirmed: number; cancelled: number; revenue: number }>()
    event.passes.forEach(p => map.set(p.id, { name: p.name, confirmed: 0, cancelled: 0, revenue: 0 }))
    registrations.forEach(r => {
      const entry = map.get(r.passId ?? '')
      if (!entry) return
      if (r.status === 'confirmed') { entry.confirmed++; entry.revenue += r.amount ?? 0 }
      if (r.status === 'cancelled') entry.cancelled++
    })
    return [...map.values()].filter(e => e.confirmed + e.cancelled > 0)
  }, [registrations, event.passes])

  return (
    <div className="space-y-5">
      {/* Summary stats */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Stat icon={Users}       label="Total Registrations" value={stats.total.toString()} />
        <Stat icon={CheckCircle} label="Confirmed"           value={stats.confirmed.toString()} colorCls="text-emerald-600" />
        <Stat icon={XCircle}     label="Cancelled"           value={stats.cancelled.toString()} colorCls="text-red-500" />
        <Stat icon={TrendingUp}  label="Revenue (Confirmed)" value={event.isFreeEvent ? 'Free' : fmtINR(stats.confirmedRevenue)} />
        <Stat icon={Percent}     label="Conversion Rate"     value={`${stats.conversion}%`} sub="confirmed of non-cancelled" />
        {stats.pending > 0 && (
          <Stat icon={Users} label="Pending" value={stats.pending.toString()} sub="awaiting confirmation" />
        )}
      </div>

      {/* Pass breakdown */}
      {passBreakdown.length > 0 && (
        <div className="rounded-xl border border-border bg-card">
          <div className="border-b border-border px-4 py-3">
            <p className="text-[15px] font-semibold text-foreground">Pass Breakdown</p>
          </div>
          <div className="divide-y divide-border">
            {passBreakdown.map(p => (
              <div key={p.name} className="flex items-center justify-between px-4 py-3">
                <div>
                  <p className="text-[14px] font-medium text-foreground">{p.name}</p>
                  <p className="text-[13px] text-muted-foreground">
                    {p.confirmed} confirmed · {p.cancelled} cancelled
                  </p>
                </div>
                {!event.isFreeEvent && (
                  <span className="text-[14px] font-semibold text-foreground">{fmtINR(p.revenue)}</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {registrations.length === 0 && (
        <div className="rounded-xl border border-dashed border-border py-16 text-center">
          <p className="text-[14px] font-semibold text-foreground">No registrations yet</p>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Reports will populate once attendees register.
          </p>
        </div>
      )}
    </div>
  )
}
