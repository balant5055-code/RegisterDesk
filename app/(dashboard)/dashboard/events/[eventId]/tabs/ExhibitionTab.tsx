'use client'

import { useState, useEffect, useCallback } from 'react'
import { Loader2, AlertCircle, RefreshCw, Building2, Users, Star, Tv2, Crown } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import type { ExhibitionKpiResponse } from '@/app/api/organizer/events/[eventId]/exhibition/route'

interface ExhibitionTabProps {
  eventId: string
  token:   string
}

function KpiCard({
  label, value, icon: Icon, accent,
}: {
  label: string
  value: number
  icon:  React.ElementType
  accent?: boolean
}) {
  return (
    <div className={cn(
      'flex flex-col gap-1.5 rounded-xl border border-border p-4',
      accent ? 'bg-primary/5' : 'bg-card',
    )}>
      <div className="flex items-center gap-2 text-muted-foreground">
        <Icon className="size-4 shrink-0" aria-hidden />
        <span className="text-[12px] font-medium">{label}</span>
      </div>
      <span className="text-[24px] font-bold tabular-nums text-foreground">{value.toLocaleString('en-IN')}</span>
    </div>
  )
}

export default function ExhibitionTab({ eventId, token }: ExhibitionTabProps) {
  const [data,    setData]    = useState<ExhibitionKpiResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/organizer/events/${eventId}/exhibition`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error((await res.json() as { error?: string }).error ?? `HTTP ${res.status}`)
      setData(await res.json() as ExhibitionKpiResponse)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load exhibition data')
    } finally {
      setLoading(false)
    }
  }, [eventId, token])

  useEffect(() => { void load() }, [load])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-20 text-center">
        <AlertCircle className="size-6 text-destructive" />
        <p className="text-[14px] text-muted-foreground">{error}</p>
        <button onClick={load} className="text-[13px] text-primary hover:underline">Retry</button>
      </div>
    )
  }

  const companies = data?.topCompanies ?? []

  return (
    <div className="space-y-6">
      {/* KPI grid */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <KpiCard label="Total Registrations" value={data?.total     ?? 0} icon={Users}    accent />
        <KpiCard label="Visitors"            value={data?.visitors  ?? 0} icon={Users}    />
        <KpiCard label="Exhibitors"          value={data?.exhibitors ?? 0} icon={Building2} />
        <KpiCard label="Sponsors"            value={data?.sponsors  ?? 0} icon={Star}     />
        <KpiCard label="Media"               value={data?.media     ?? 0} icon={Tv2}      />
      </div>

      {/* VIP count if any */}
      {(data?.vip ?? 0) > 0 && (
        <div className="flex items-center gap-2 rounded-xl border border-border bg-card p-4">
          <Crown className="size-4 shrink-0 text-amber-500" aria-hidden />
          <span className="text-[13px] font-medium text-foreground">{data!.vip} VIP</span>
          <span className="text-[13px] text-muted-foreground">attendees registered</span>
        </div>
      )}

      {/* Registered companies */}
      {companies.length > 0 && (
        <div>
          <h3 className="mb-3 text-[13px] font-semibold text-muted-foreground uppercase tracking-wide">
            Registered Companies ({companies.length})
          </h3>
          <div className="divide-y divide-border rounded-xl border border-border bg-card">
            {companies.map((c, i) => (
              <div key={i} className="flex items-center justify-between px-4 py-3">
                <div className="flex items-center gap-3">
                  <div className="flex size-8 items-center justify-center rounded-full bg-primary/10 text-[12px] font-bold text-primary">
                    {c.companyName.charAt(0).toUpperCase()}
                  </div>
                  <span className="text-[13px] font-medium text-foreground">{c.companyName}</span>
                </div>
                <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                  {c.passType}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {companies.length === 0 && (data?.total ?? 0) === 0 && (
        <div className="rounded-2xl border border-dashed border-border py-16 text-center">
          <Building2 className="mx-auto mb-2 size-8 text-muted-foreground/30" aria-hidden />
          <p className="text-[14px] font-semibold text-foreground">No confirmed registrations yet</p>
          <p className="mt-0.5 text-[13px] text-muted-foreground">Exhibition KPIs will appear once attendees register.</p>
        </div>
      )}

      {/* Refresh */}
      <div className="flex justify-end">
        <button
          onClick={() => void load()}
          disabled={loading}
          className="flex items-center gap-1.5 text-[13px] text-muted-foreground hover:text-foreground disabled:opacity-50"
        >
          <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
          Refresh
        </button>
      </div>
    </div>
  )
}
