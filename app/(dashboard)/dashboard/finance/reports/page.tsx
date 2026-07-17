'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { onAuthStateChanged, type User } from 'firebase/auth'
import { auth } from '@/lib/firebase/auth'
import { cn } from '@/lib/utils/cn'
import { useToast } from '@/components/ui/Toast'
import { FileText, Loader2, Download, AlertCircle } from 'lucide-react'
import { cellToDisplay } from '@/lib/reports/format'
import type { ReportTable, PayoutStatement } from '@/lib/reports/types'
import type { ReportExportJobView } from '@/lib/reports/exportJob'
import type { CreateReportExportResponse } from '@/app/api/organizer/reports/exports/route'
import type { ProcessReportExportResponse } from '@/app/api/organizer/reports/exports/[jobId]/process/route'

interface ReportDef { kind: string; label: string; statement?: boolean }
const REPORTS: ReportDef[] = [
  { kind: 'transactions',    label: 'Transactions' },
  { kind: 'settlements',     label: 'Settlements' },
  { kind: 'wallet-ledger',   label: 'Wallet Ledger' },
  { kind: 'donations',       label: 'Donations' },
  { kind: 'refunds',         label: 'Refunds' },
  { kind: 'broadcast-usage', label: 'Broadcast Usage' },
  { kind: 'gst',             label: 'GST Summary' },
  { kind: 'payout-statement',label: 'Payout Statement', statement: true },
]

const today = () => new Date().toISOString().slice(0, 10)
const daysAgo = (n: number) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10) }

function urlFor(def: ReportDef): string {
  return def.statement ? '/api/organizer/reports/payout-statement' : `/api/organizer/reports/${def.kind}`
}

export default function FinanceReportsPage() {
  const { showToast } = useToast()
  const userRef = useRef<User | null>(null)
  const [kind,    setKind]    = useState<string>('transactions')
  const [from,    setFrom]    = useState(daysAgo(30))
  const [to,      setTo]      = useState(today())
  const [event,   setEvent]   = useState('')
  const [campaign,setCampaign]= useState('')
  const [status,  setStatus]  = useState('')

  const [table,     setTable]     = useState<ReportTable | null>(null)
  const [statement, setStatement] = useState<PayoutStatement | null>(null)
  const [loading,   setLoading]   = useState(false)
  const [error,     setError]     = useState<string | null>(null)
  const [downloading, setDownloading] = useState<string | null>(null)
  // OE-3 — background report export (large datasets).
  const [exportJob,  setExportJob]  = useState<ReportExportJobView | null>(null)
  const [exporting,  setExporting]  = useState(false)
  const exportRunning = useRef(false)

  const def = REPORTS.find(r => r.kind === kind)!

  const queryString = useCallback(() => {
    const p = new URLSearchParams()
    if (from) p.set('from', from)
    if (to) p.set('to', to)
    if (!def.statement) {
      if (event) p.set('event', event)
      if (campaign) p.set('campaign', campaign)
      if (status) p.set('status', status)
    }
    return p.toString()
  }, [from, to, event, campaign, status, def])

  const loadPreview = useCallback(async () => {
    const u = userRef.current
    if (!u) return
    setLoading(true); setError(null); setTable(null); setStatement(null)
    try {
      const token = await u.getIdToken()
      const res = await fetch(`${urlFor(def)}?${queryString()}&format=json`, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' })
      if (res.status === 403) throw new Error('You do not have permission to view this report.')
      if (!res.ok) { const e = await res.json().catch(() => null) as { error?: string } | null; throw new Error(e?.error ?? 'Failed to load report.') }
      const data = await res.json()
      if (def.statement) setStatement(data.statement as PayoutStatement)
      else setTable(data.table as ReportTable)
    } catch (e) { setError(e instanceof Error ? e.message : 'Failed to load') } finally { setLoading(false) }
  }, [def, queryString])

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, u => { userRef.current = u; if (u) void loadPreview() })
    return unsub
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Reload when switching report type.
  useEffect(() => {
    if (userRef.current) void loadPreview()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind])

  async function download(format: 'csv' | 'xlsx' | 'pdf') {
    const u = userRef.current
    if (!u) return
    setDownloading(format)
    try {
      const token = await u.getIdToken()
      const res = await fetch(`${urlFor(def)}?${queryString()}&format=${format}`, { headers: { Authorization: `Bearer ${token}` } })
      if (!res.ok) { const e = await res.json().catch(() => null) as { error?: string } | null; throw new Error(e?.error ?? 'Export failed.') }
      const blob = await res.blob()
      const cd = res.headers.get('Content-Disposition') ?? ''
      const fn = /filename="(.+?)"/.exec(cd)?.[1] ?? `${kind}.${format}`
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob); a.download = fn
      document.body.appendChild(a); a.click(); a.remove()
      URL.revokeObjectURL(a.href)
    } catch (e) { showToast(e instanceof Error ? e.message : 'Export failed', 'error') } finally { setDownloading(null) }
  }

  // ── OE-3: background export (build off the request; poll → download) ──────────
  const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

  async function generateBackground(format: 'csv' | 'xlsx' | 'pdf') {
    const u = userRef.current
    if (!u) return
    setExporting(true); setExportJob(null)
    try {
      const token = await u.getIdToken()
      const filters = { from, to, ...(event ? { event } : {}), ...(campaign ? { campaign } : {}), ...(status ? { status } : {}) }
      const res = await fetch('/api/organizer/reports/exports', {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, format, filters }),
      })
      const data = await res.json() as CreateReportExportResponse
      if (!res.ok || !data.success) { showToast((!data.success && data.error) || 'Could not start export', 'error'); return }
      setExportJob(data.job)
      void driveExport(data.jobId)
    } catch { showToast('Network error', 'error') } finally { setExporting(false) }
  }

  async function driveExport(jobId: string) {
    if (exportRunning.current) return
    exportRunning.current = true
    try {
      for (let i = 0; i < 100_000; i++) {
        const token = await userRef.current?.getIdToken()
        const res  = await fetch(`/api/organizer/reports/exports/${jobId}/process`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })
        const json = await res.json() as ProcessReportExportResponse
        if (!res.ok || !json.success) break
        if (json.job) setExportJob(json.job)
        if (json.result.done) break
        if (json.result.reason === 'busy') { await sleep(1500); continue }
        await sleep(400)
      }
    } catch { /* the cron finishes it; user can re-open */ }
    finally { exportRunning.current = false }
  }

  async function cancelExport(jobId: string) {
    const token = await userRef.current?.getIdToken()
    if (!token) return
    try {
      await fetch(`/api/organizer/reports/exports/${jobId}/cancel`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })
      setExportJob(prev => prev ? { ...prev, status: 'cancelled' } : prev)
    } catch { /* next poll reflects it */ }
  }

  async function downloadExport(jobId: string) {
    const token = await userRef.current?.getIdToken()
    if (!token) return
    window.open(`/api/organizer/reports/exports/${jobId}/download?token=${encodeURIComponent(token)}`, '_blank')
  }

  // Payout statement exports PDF only.
  const formats: ('csv' | 'xlsx' | 'pdf')[] = def.statement ? ['pdf'] : ['csv', 'xlsx', 'pdf']

  return (
    <div className="space-y-6 p-5 sm:p-6">
      <div className="flex items-center gap-3">
        <div className="flex size-9 items-center justify-center rounded-xl bg-primary/[0.09] text-primary"><FileText className="size-5" aria-hidden /></div>
        <div>
          <h1 className="text-[20px] font-bold tracking-tight text-foreground">Finance &amp; Compliance Reports</h1>
          <p className="text-[13.5px] text-muted-foreground">Filter, preview, and export financial records as CSV, Excel, or PDF.</p>
        </div>
      </div>

      {/* Report type tabs */}
      <div className="flex flex-wrap gap-2">
        {REPORTS.map(r => (
          <button key={r.kind} onClick={() => setKind(r.kind)}
            className={cn('rounded-lg border px-3 py-1.5 text-[13px] font-medium transition-colors',
              kind === r.kind ? 'border-primary bg-primary/[0.08] text-primary' : 'border-border text-muted-foreground hover:bg-muted')}>
            {r.label}
          </button>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-end gap-3 rounded-2xl border border-border bg-card p-4">
        <Field label="From"><input type="date" value={from} onChange={e => setFrom(e.target.value)} className="rounded-lg border border-border bg-background px-2.5 py-1.5 text-[13px]" /></Field>
        <Field label="To"><input type="date" value={to} onChange={e => setTo(e.target.value)} className="rounded-lg border border-border bg-background px-2.5 py-1.5 text-[13px]" /></Field>
        {!def.statement && <>
          <Field label="Event (slug)"><input value={event} onChange={e => setEvent(e.target.value)} placeholder="any" className="w-32 rounded-lg border border-border bg-background px-2.5 py-1.5 text-[13px]" /></Field>
          <Field label="Campaign (slug)"><input value={campaign} onChange={e => setCampaign(e.target.value)} placeholder="any" className="w-32 rounded-lg border border-border bg-background px-2.5 py-1.5 text-[13px]" /></Field>
          <Field label="Status"><input value={status} onChange={e => setStatus(e.target.value)} placeholder="any" className="w-28 rounded-lg border border-border bg-background px-2.5 py-1.5 text-[13px]" /></Field>
        </>}
        <button onClick={() => void loadPreview()} disabled={loading}
          className="rounded-lg px-4 py-2 text-[13px] font-semibold text-primary-foreground shadow-sm hover:opacity-90 disabled:opacity-60" style={{ backgroundImage: 'var(--primary-gradient)' }}>
          {loading ? <Loader2 className="size-4 animate-spin" /> : 'Apply'}
        </button>
        <div className="ml-auto flex gap-2">
          {formats.map(fmt => (
            <button key={fmt} onClick={() => void download(fmt)} disabled={downloading !== null || loading}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-[13px] font-medium text-foreground hover:bg-muted disabled:opacity-60">
              {downloading === fmt ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />} {fmt.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      {/* OE-3 — background export for large datasets */}
      {!def.statement && (
        <div className="rounded-2xl border border-border bg-card p-4 text-[13px]">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-foreground">Large dataset?</span>
            <span className="text-muted-foreground">Generate in the background —</span>
            {formats.map(fmt => (
              <button key={fmt} onClick={() => void generateBackground(fmt)} disabled={exporting || loading}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 font-medium text-foreground hover:bg-muted disabled:opacity-60">
                {exporting ? <Loader2 className="size-3.5 animate-spin" /> : <FileText className="size-3.5" />} {fmt.toUpperCase()}
              </button>
            ))}
          </div>

          {exportJob && (() => {
            const j = exportJob
            const active = j.status === 'pending' || j.status === 'processing'
            const failed = j.status === 'failed' || (j.status === 'completed' && !j.ready)
            const label: Record<string, string> = { pending: 'Queued', processing: 'Generating…', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled' }
            return (
              <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-border pt-3">
                <span className="font-semibold text-foreground">{j.format.toUpperCase()} export — {label[j.status] ?? j.status}</span>
                {active && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
                {j.ready && j.output && (
                  <>
                    <button onClick={() => void downloadExport(j.jobId)}
                      className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 font-semibold text-primary-foreground shadow-sm hover:opacity-90" style={{ backgroundImage: 'var(--primary-gradient)' }}>
                      <Download className="size-3.5" /> Download
                    </button>
                    <span className="text-muted-foreground">{j.output.rowCount.toLocaleString()} rows{j.output.truncated ? ' (capped)' : ''}</span>
                  </>
                )}
                {failed && <span className="text-destructive">{j.error || 'Generation failed.'}</span>}
                {active && <button onClick={() => void cancelExport(j.jobId)} className="text-muted-foreground hover:text-foreground underline">Cancel</button>}
              </div>
            )
          })()}
        </div>
      )}

      {error && <div className="flex items-center gap-2 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-[13px] text-destructive"><AlertCircle className="size-4" /> {error}</div>}

      {loading && <div className="flex justify-center py-16"><Loader2 className="size-6 animate-spin text-muted-foreground" /></div>}

      {/* Payout statement preview */}
      {!loading && statement && <StatementPreview s={statement} />}

      {/* Table preview */}
      {!loading && table && <TablePreview table={table} />}
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="flex flex-col gap-1"><span className="text-[11px] font-medium text-muted-foreground">{label}</span>{children}</label>
}

function StatementPreview({ s }: { s: PayoutStatement }) {
  const line = (label: string, paise: number, neg = false, total = false) => (
    <div className={cn('flex justify-between py-2', total && 'border-t border-border font-bold text-foreground', !total && 'text-muted-foreground')}>
      <span>{label}</span><span>{neg ? `(${cellToDisplay(paise, 'money')})` : cellToDisplay(paise, 'money')}</span>
    </div>
  )
  return (
    <div className="max-w-md rounded-2xl border border-border bg-card p-5 text-[13.5px]">
      <p className="mb-1 text-[15px] font-bold text-foreground">{s.organizerName}</p>
      <p className="mb-3 text-[12px] text-muted-foreground">
        {cellToDisplay(s.period.from, 'date')} — {cellToDisplay(s.period.to, 'date')} · {s.transactionCount} transactions
      </p>
      {s.truncated && (
        <p className="mb-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] font-medium text-amber-700">
          Partial statement — this period exceeds the record cap; the totals below cover only the most recent {s.transactionCount} transactions. Narrow the date range for a complete statement.
        </p>
      )}
      {line('Gross Revenue', s.grossRevenuePaise)}
      {line('Platform Fees', s.platformFeesPaise, true)}
      {line('GST on Fees', s.gstPaise, true)}
      {line('Refunds', s.refundsPaise, true)}
      {line('Net Settlement', s.netSettlementPaise, false, true)}
      <div className="mt-3 text-[12px] text-muted-foreground">
        <p>Settlement Ref: <span className="text-foreground">{s.settlementReference ?? '—'}</span></p>
        <p>Settlement Date: <span className="text-foreground">{cellToDisplay(s.settlementDate, 'date')}</span></p>
      </div>
    </div>
  )
}

function TablePreview({ table }: { table: ReportTable }) {
  return (
    <div className="space-y-3">
      {table.summary && table.summary.length > 0 && (
        <div className="flex flex-wrap gap-3">
          {table.summary.map(s => (
            <div key={s.label} className="rounded-xl border border-border bg-card px-4 py-2.5">
              <p className="text-[11px] text-muted-foreground">{s.label}</p>
              <p className="text-[16px] font-bold text-foreground">{cellToDisplay(s.value, s.type)}</p>
            </div>
          ))}
        </div>
      )}
      {table.truncated && <p className="text-[12px] text-amber-600">Showing the most recent {table.rows.length} records. Narrow the date range for a complete export.</p>}
      <div className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full min-w-[640px] text-[13px]">
          <thead><tr className="border-b border-border bg-muted/40 text-left text-[12px] font-semibold text-muted-foreground">
            {table.columns.map(c => <th key={c.key} className={cn('px-3 py-2.5', (c.align === 'right' || c.type === 'money' || c.type === 'number') && 'text-right')}>{c.label}</th>)}
          </tr></thead>
          <tbody className="divide-y divide-border">
            {table.rows.length === 0 ? (
              <tr><td colSpan={table.columns.length} className="px-4 py-12 text-center text-muted-foreground">No records for the selected filters.</td></tr>
            ) : table.rows.slice(0, 200).map((row, i) => (
              <tr key={i} className="hover:bg-muted/20">
                {table.columns.map(c => {
                  const right = c.align === 'right' || c.type === 'money' || c.type === 'number'
                  return <td key={c.key} className={cn('px-3 py-2.5', right ? 'text-right tabular-nums' : '', c.type === 'text' && 'text-foreground')}>{cellToDisplay(row[c.key] ?? null, c.type)}</td>
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {table.rows.length > 200 && <p className="text-[12px] text-muted-foreground">Preview limited to 200 rows — export for the full {table.rows.length} rows.</p>}
    </div>
  )
}
