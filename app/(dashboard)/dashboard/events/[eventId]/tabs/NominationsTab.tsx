'use client'

import { useState, useEffect, useCallback } from 'react'
import {
  Loader2, AlertCircle, RefreshCw, Download,
  Trophy, Users, ExternalLink,
} from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import type { NominationsApiResponse, NominationSummary } from '@/app/api/organizer/events/[eventId]/nominations/route'

interface NominationsTabProps {
  eventId: string
  token:   string
}

function KpiCard({ label, value, accent }: { label: string; value: number; accent?: boolean }) {
  return (
    <div className={cn(
      'flex flex-col gap-1.5 rounded-xl border border-border p-4',
      accent ? 'bg-primary/5' : 'bg-card',
    )}>
      <span className="text-[12px] font-medium text-muted-foreground">{label}</span>
      <span className="text-[24px] font-bold tabular-nums text-foreground">{value.toLocaleString('en-IN')}</span>
    </div>
  )
}

function NominationRow({ nom }: { nom: NominationSummary }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-[14px] font-semibold text-foreground">{nom.nomineeName}</p>
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800">
              {nom.category}
            </span>
          </div>
          {nom.organization && (
            <p className="mt-0.5 text-[12px] text-muted-foreground">{nom.organization}</p>
          )}
          {nom.description && (
            <p className="mt-2 line-clamp-2 text-[12px] leading-relaxed text-muted-foreground">
              {nom.description}
            </p>
          )}
          {nom.supportingUrl && (
            <a
              href={nom.supportingUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1.5 inline-flex items-center gap-1 text-[11px] text-primary hover:underline"
            >
              <ExternalLink className="size-3 shrink-0" aria-hidden />
              {nom.supportingUrl.replace(/^https?:\/\//, '').slice(0, 50)}
            </a>
          )}
        </div>
        <div className="shrink-0 text-right">
          <span className={cn(
            'rounded-full px-2 py-0.5 text-[11px] font-medium capitalize',
            nom.status === 'shortlisted' ? 'bg-green-100 text-green-700' :
            nom.status === 'rejected'    ? 'bg-red-100 text-red-600' :
            'bg-muted text-muted-foreground',
          )}>
            {nom.status}
          </span>
          {nom.submittedAt && (
            <p className="mt-1 text-[11px] text-muted-foreground">
              {new Date(nom.submittedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

export default function NominationsTab({ eventId, token }: NominationsTabProps) {
  const [data,    setData]    = useState<NominationsApiResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)
  const [filter,  setFilter]  = useState<string>('all')

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/organizer/events/${eventId}/nominations`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error((await res.json() as { error?: string }).error ?? `HTTP ${res.status}`)
      setData(await res.json() as NominationsApiResponse)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load nominations')
    } finally {
      setLoading(false)
    }
  }, [eventId, token])

  useEffect(() => { void load() }, [load])

  function downloadCSV() {
    const a = document.createElement('a')
    a.href = `/api/organizer/events/${eventId}/nominations/export?token=${encodeURIComponent(token)}`
    a.setAttribute('download', '')
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }

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

  const categories  = Object.keys(data?.byCategory ?? {}).sort()
  const allNoms     = data?.nominations ?? []
  const visible     = filter === 'all' ? allNoms : allNoms.filter(n => n.category === filter)

  return (
    <div className="space-y-5">
      {/* KPI cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <KpiCard label="Total Nominations" value={data?.total ?? 0} accent />
        {categories.slice(0, 3).map(cat => (
          <KpiCard key={cat} label={cat} value={data!.byCategory[cat]!} />
        ))}
      </div>

      {/* Per-category breakdown if >3 categories */}
      {categories.length > 3 && (
        <div className="divide-y divide-border rounded-xl border border-border bg-card">
          {categories.map(cat => (
            <div key={cat} className="flex items-center justify-between px-4 py-2.5">
              <div className="flex items-center gap-2">
                <Trophy className="size-3.5 shrink-0 text-amber-500" aria-hidden />
                <span className="text-[13px] font-medium text-foreground">{cat}</span>
              </div>
              <span className="text-[13px] font-bold tabular-nums text-foreground">
                {data!.byCategory[cat]}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Actions bar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        {/* Category filter */}
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => setFilter('all')}
            className={cn(
              'rounded-lg px-3 py-1.5 text-[13px] font-medium capitalize transition-colors',
              filter === 'all'
                ? 'bg-primary text-primary-foreground'
                : 'border border-border bg-background text-muted-foreground hover:text-foreground',
            )}
          >
            All ({data?.total ?? 0})
          </button>
          {categories.map(cat => (
            <button
              key={cat}
              onClick={() => setFilter(cat)}
              className={cn(
                'rounded-lg px-3 py-1.5 text-[13px] font-medium transition-colors',
                filter === cat
                  ? 'bg-primary text-primary-foreground'
                  : 'border border-border bg-background text-muted-foreground hover:text-foreground',
              )}
            >
              {cat} ({data!.byCategory[cat]})
            </button>
          ))}
        </div>

        <div className="flex gap-2">
          <button
            onClick={() => void load()}
            disabled={loading}
            className="flex items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-1.5 text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
          >
            <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
            Refresh
          </button>
          <button
            onClick={downloadCSV}
            className="flex items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-1.5 text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            <Download className="size-3.5" />
            Export CSV
          </button>
        </div>
      </div>

      {/* Nominations list */}
      {visible.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border py-16 text-center">
          <Users className="mx-auto mb-2 size-8 text-muted-foreground/30" aria-hidden />
          <p className="text-[14px] font-semibold text-foreground">
            {allNoms.length === 0 ? 'No nominations yet' : `No nominations in "${filter}"`}
          </p>
          {allNoms.length === 0 && (
            <p className="mt-0.5 text-[13px] text-muted-foreground">
              Nominations submitted through the public event page will appear here.
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          {visible.map(nom => (
            <NominationRow key={nom.id} nom={nom} />
          ))}
        </div>
      )}
    </div>
  )
}
