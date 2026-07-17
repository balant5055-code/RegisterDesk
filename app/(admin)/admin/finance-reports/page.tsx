'use client'

import { useCallback, useEffect, useState } from 'react'
import { auth } from '@/lib/firebase/auth'
import { Loader2, BarChart3, Download } from 'lucide-react'
import { useToast } from '@/components/ui/Toast'
import { cellToDisplay } from '@/lib/reports/format'
import type { ReportTable } from '@/lib/reports/types'

const today = () => new Date().toISOString().slice(0, 10)
const daysAgo = (n: number) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10) }

export default function AdminFinanceReportsPage() {
  const [from, setFrom] = useState(daysAgo(30))
  const [to,   setTo]   = useState(today())
  const [table,   setTable]   = useState<ReportTable | null>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)
  const [downloading, setDownloading] = useState<string | null>(null)
  const { showToast } = useToast()

  const qs = useCallback(() => { const p = new URLSearchParams(); if (from) p.set('from', from); if (to) p.set('to', to); return p.toString() }, [from, to])

  const load = useCallback(async () => {
    const u = auth.currentUser
    if (!u) { setError('Not authenticated'); setLoading(false); return }
    setLoading(true); setError(null)
    try {
      const token = await u.getIdToken()
      const res = await fetch(`/api/admin/finance-reports?${qs()}&format=json`, { headers: { authorization: `Bearer ${token}` }, cache: 'no-store' })
      if (!res.ok) throw new Error(`Request failed (${res.status})`)
      const data = await res.json()
      setTable(data.table as ReportTable)
    } catch (e) { setError(e instanceof Error ? e.message : 'Failed to load') } finally { setLoading(false) }
  }, [qs])

  useEffect(() => {
    // Defer so the initial setState in load() doesn't run synchronously in the
    // effect body (react-hooks/set-state-in-effect).
    const t = setTimeout(() => void load(), 0)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function download(format: 'csv' | 'xlsx' | 'pdf') {
    const u = auth.currentUser
    if (!u) return
    setDownloading(format)
    try {
      const token = await u.getIdToken()
      const res = await fetch(`/api/admin/finance-reports?${qs()}&format=${format}`, { headers: { authorization: `Bearer ${token}` } })
      if (!res.ok) throw new Error('Export failed')
      const blob = await res.blob()
      const cd = res.headers.get('Content-Disposition') ?? ''
      const fn = /filename="(.+?)"/.exec(cd)?.[1] ?? `platform-finance.${format}`
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = fn
      document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(a.href)
    } catch { showToast('Export failed', 'error') } finally { setDownloading(null) }
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="flex items-center gap-2 text-[20px] font-bold tracking-tight text-foreground"><BarChart3 className="size-5 text-primary" aria-hidden /> Finance Reports</h1>
        <p className="text-[13.5px] text-muted-foreground">Platform-wide GMV, fees, refunds, settlements, and recurring revenue.</p>
      </div>

      <div className="flex flex-wrap items-end gap-3 rounded-2xl border border-border bg-card p-4">
        <label className="flex flex-col gap-1"><span className="text-[11px] font-medium text-muted-foreground">From</span><input type="date" value={from} onChange={e => setFrom(e.target.value)} className="rounded-lg border border-border bg-background px-2.5 py-1.5 text-[13px]" /></label>
        <label className="flex flex-col gap-1"><span className="text-[11px] font-medium text-muted-foreground">To</span><input type="date" value={to} onChange={e => setTo(e.target.value)} className="rounded-lg border border-border bg-background px-2.5 py-1.5 text-[13px]" /></label>
        <button onClick={() => void load()} disabled={loading} className="rounded-lg px-4 py-2 text-[13px] font-semibold text-primary-foreground shadow-sm hover:opacity-90 disabled:opacity-60" style={{ backgroundImage: 'var(--primary-gradient)' }}>{loading ? <Loader2 className="size-4 animate-spin" /> : 'Apply'}</button>
        <div className="ml-auto flex gap-2">
          {(['csv', 'xlsx', 'pdf'] as const).map(fmt => (
            <button key={fmt} onClick={() => void download(fmt)} disabled={downloading !== null || loading} className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-[13px] font-medium text-foreground hover:bg-muted disabled:opacity-60">
              {downloading === fmt ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />} {fmt.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      {error && <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-[13px] text-destructive">{error}</div>}
      {loading && <div className="flex justify-center py-16"><Loader2 className="size-6 animate-spin text-muted-foreground" /></div>}

      {!loading && table && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {table.rows.map((row, i) => (
            <div key={i} className="rounded-2xl border border-border bg-card p-4">
              <p className="text-[12px] text-muted-foreground">{String(row.metric)}</p>
              <p className="mt-1 text-[20px] font-bold text-foreground">{cellToDisplay(row.amount ?? 0, 'money')}</p>
            </div>
          ))}
          {table.summary?.map(s => (
            <div key={s.label} className="rounded-2xl border border-dashed border-border p-4">
              <p className="text-[12px] text-muted-foreground">{s.label}</p>
              <p className="mt-1 text-[20px] font-bold text-foreground">{cellToDisplay(s.value, s.type)}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
