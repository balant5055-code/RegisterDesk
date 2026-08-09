'use client'

// Enterprise Operations Center / NOC (GA-2 S4).
// The operational heart of RegisterDesk: monitor, investigate and operate every
// background process (print, certificate, import, export, broadcast, bulk) from one
// workspace over a permanent Health Panel. Six workspaces, all lazy-loaded.
// Purely additive + reuse-first: reads hit thin admin endpoints over the EXISTING
// job engine; the ONLY mutation is CANCEL (reuses the kernel's cancelJob). There is
// NO retry/restart engine — those are surfaced honestly as unsupported.

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { auth } from '@/lib/firebase/auth'
import { cn } from '@/lib/utils/cn'
import {
  Loader2, RefreshCw, Activity, AlertTriangle, CheckCircle2, Clock, ScrollText,
  Gauge, Cog, ExternalLink, Ban, Printer, Award, Upload, Download, Send, Layers,
  ListChecks, XCircle,
} from 'lucide-react'
import { StatusPill, ErrorBanner, SearchInput, FilterTabs } from '@/components/admin'
import type { PillTone } from '@/components/admin'
import { useConfirm } from '@/components/ui/ConfirmDialog'
import { Bars, HBars } from '@/components/analytics/Charts'
import type {
  OpsOverview, OpsOverviewResponse, OpsJobView, OpsJobsResponse, OpsMonitoring,
  OpsMonitoringResponse, OpsTimelineEntry, OpsTimelineResponse, EngineKey,
  HealthIndicator, HealthLevel, JobStatus, EngineStatus,
} from '@/lib/admin/operationsCenterTypes'

// ─── Utilities ──────────────────────────────────────────────────────────────

async function getToken(): Promise<string> {
  const u = auth.currentUser
  if (!u) throw new Error('Not authenticated')
  return u.getIdToken()
}
async function authedGet<T>(url: string): Promise<T> {
  const token = await getToken()
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` }, cache: 'no-store' })
  if (!res.ok) { const b = await res.json().catch(() => null) as { error?: string } | null; throw new Error(b?.error ?? `Request failed (${res.status})`) }
  return await res.json() as T
}

const num = (n: number): string => n.toLocaleString('en-IN')
const fmtDate = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'
function fmtDuration(ms: number | null): string {
  if (ms == null) return '—'
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.round(ms / 60000)}m`
}

const HEALTH_DOT: Record<HealthLevel, string> = {
  green: 'bg-emerald-500', yellow: 'bg-amber-500', red: 'bg-red-500', neutral: 'bg-muted-foreground/40',
}
const STATUS_TONE: Record<JobStatus, PillTone> = {
  pending: 'neutral', processing: 'info', completed: 'success', failed: 'danger', cancelled: 'neutral',
}
const ENGINE_ICON: Record<EngineKey, typeof Printer> = {
  print: Printer, certificate: Award, import: Upload, export: Download, broadcast: Send, bulk: Layers,
}
const ENGINES: { key: EngineKey; label: string }[] = [
  { key: 'print', label: 'Print' }, { key: 'certificate', label: 'Certificate' }, { key: 'import', label: 'Import' },
  { key: 'export', label: 'Reports & Exports' }, { key: 'broadcast', label: 'Broadcast' }, { key: 'bulk', label: 'Bulk' },
]

type TabKey = 'overview' | 'operations' | 'monitoring' | 'failures' | 'audit' | 'settings'
const TABS: { key: TabKey; label: string }[] = [
  { key: 'overview', label: 'Overview' }, { key: 'operations', label: 'Operations' },
  { key: 'monitoring', label: 'Monitoring' }, { key: 'failures', label: 'Failures' },
  { key: 'audit', label: 'Audit' }, { key: 'settings', label: 'Settings' },
]

// ─── Page ───────────────────────────────────────────────────────────────────

export default function OperationsCenterPage() {
  const [tab, setTab] = useState<TabKey>('overview')
  const [overview, setOverview] = useState<OpsOverview | null>(null)
  const [overviewErr, setOverviewErr] = useState<string | null>(null)
  const [ovKey, setOvKey] = useState(0)

  useEffect(() => {
    let alive = true
    void (async () => {
      try { const d = await authedGet<OpsOverviewResponse>('/api/admin/operations-center/overview'); if (alive) { setOverviewErr(null); setOverview(d.overview) } }
      catch (e) { if (alive) setOverviewErr(e instanceof Error ? e.message : 'Failed to load overview') }
    })()
    return () => { alive = false }
  }, [ovKey])

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link href="/admin/operations" className="mb-1 inline-flex items-center gap-1.5 text-[12.5px] font-medium text-muted-foreground transition-colors hover:text-foreground">
            <Activity className="size-3.5" /> Platform Operations
          </Link>
          <h1 className="text-[20px] font-bold tracking-tight text-foreground">Operations Center</h1>
          <p className="mt-0.5 text-[12.5px] text-muted-foreground">Monitor, investigate and operate every background job across the platform.</p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/admin/platform-monitor" className={btnOutline}><Gauge className="size-3.5" /> Platform Monitoring</Link>
          <button onClick={() => setOvKey(k => k + 1)} className={btnOutline}><RefreshCw className="size-3.5" /> Refresh</button>
        </div>
      </div>

      {overviewErr && <ErrorBanner>{overviewErr}</ErrorBanner>}
      <HealthPanel indicators={overview?.health ?? []} />

      <div className="flex flex-wrap gap-1 border-b border-border">
        {TABS.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)} aria-current={tab === t.key ? 'page' : undefined}
            className={cn('rounded-t-md px-3.5 py-2 text-[13.5px] font-medium transition-colors',
              tab === t.key ? 'border-b-2 border-primary text-primary' : 'text-muted-foreground hover:text-foreground')}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'overview' && (overview ? <OverviewWorkspace o={overview} onGoto={setTab} /> : !overviewErr && <CenterSpin />)}
      {tab === 'operations' && <JobsWorkspace mode="operations" />}
      {tab === 'monitoring' && <MonitoringWorkspace />}
      {tab === 'failures' && <JobsWorkspace mode="failures" />}
      {tab === 'audit' && <AuditWorkspace />}
      {tab === 'settings' && <SettingsWorkspace />}
    </div>
  )
}

// ─── Health Panel ─────────────────────────────────────────────────────────────

function HealthPanel({ indicators }: { indicators: HealthIndicator[] }) {
  if (!indicators.length) return <div className="flex items-center gap-2 rounded-xl border border-border bg-card p-4 text-[13px] text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Evaluating queue health…</div>
  return (
    <div className="rounded-xl border border-border bg-card p-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
        {indicators.map(h => (
          <div key={h.key} className="rounded-lg border border-border bg-muted/30 px-3 py-2">
            <div className="flex items-center gap-1.5"><span className={cn('size-2 shrink-0 rounded-full', HEALTH_DOT[h.level])} aria-hidden /><span className="truncate text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{h.label}</span></div>
            <p className="mt-1 truncate text-[12.5px] font-medium text-foreground" title={h.detail}>{h.detail}</p>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Overview ──────────────────────────────────────────────────────────────────

function OverviewWorkspace({ o, onGoto }: { o: OpsOverview; onGoto: (t: TabKey) => void }) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Kpi icon={Activity} label="Running" value={num(o.overall.running)} />
        <Kpi icon={Clock} label="Queued" value={num(o.overall.waiting)} />
        <Kpi icon={CheckCircle2} label="Completed" value={num(o.overall.completed)} />
        <Kpi icon={AlertTriangle} label="Failed" value={num(o.overall.failed)} />
        <Kpi icon={Ban} label="Cancelled" value={num(o.overall.cancelled)} />
        <Kpi icon={ListChecks} label="Total" value={num(o.overall.total)} />
      </div>

      <Card title="Engines" icon={Gauge}>
        <div className="grid gap-px overflow-hidden bg-border sm:grid-cols-2 lg:grid-cols-3">
          {o.engines.map(e => <EngineCard key={e.key} e={e} />)}
        </div>
      </Card>

      <Card title="Quick actions" icon={Cog}>
        <div className="flex flex-wrap gap-2 p-4">
          <button onClick={() => onGoto('operations')} className={btnOutline}><Activity className="size-3.5" /> Operations</button>
          <button onClick={() => onGoto('failures')} className={btnOutline}><AlertTriangle className="size-3.5" /> Failures</button>
          <button onClick={() => onGoto('monitoring')} className={btnOutline}><Gauge className="size-3.5" /> Monitoring</button>
          <DeepLink href="/admin/operations" label="Platform Health & Recovery" />
          <DeepLink href="/admin/communications" label="Communications" />
          <DeepLink href="/admin/finance-reports" label="Reports" />
        </div>
      </Card>
    </div>
  )
}

function EngineCard({ e }: { e: EngineStatus }) {
  const Icon = ENGINE_ICON[e.key]
  return (
    <div className="bg-card p-4">
      <div className="flex items-center gap-2"><Icon className="size-4 text-muted-foreground" aria-hidden /><span className="text-[13.5px] font-semibold text-foreground">{e.label}</span></div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12.5px] text-muted-foreground">
        <span>Running <strong className="text-foreground">{num(e.running)}</strong></span>
        <span>Queued <strong className="text-foreground">{num(e.waiting)}</strong></span>
        <span>Failed <strong className={e.failed > 0 ? 'text-red-600' : 'text-foreground'}>{num(e.failed)}</strong></span>
        <span>Done <strong className="text-foreground">{num(e.completed)}</strong></span>
      </div>
    </div>
  )
}

// ─── Jobs (Operations + Failures) ───────────────────────────────────────────

const STATUS_FILTERS = [
  { value: '', label: 'All' }, { value: 'processing', label: 'Running' }, { value: 'pending', label: 'Queued' },
  { value: 'completed', label: 'Completed' }, { value: 'failed', label: 'Failed' }, { value: 'cancelled', label: 'Cancelled' },
]

function JobsWorkspace({ mode }: { mode: 'operations' | 'failures' }) {
  const [jobs, setJobs] = useState<OpsJobView[] | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [engine, setEngine] = useState<EngineKey | ''>('')
  const [status, setStatus] = useState(mode === 'failures' ? 'failed' : '')
  const [reloadKey, setReloadKey] = useState(0)
  const { confirm } = useConfirm()

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const qs = new URLSearchParams({ limit: '150' })
        if (mode === 'failures') qs.set('status', 'failed')
        const d = await authedGet<OpsJobsResponse>(`/api/admin/operations-center/jobs?${qs.toString()}`)
        if (alive) { setErr(null); setJobs(d.jobs); setTruncated(d.truncated) }
      } catch (e) { if (alive) setErr(e instanceof Error ? e.message : 'Failed to load jobs') }
    })()
    return () => { alive = false }
  }, [mode, reloadKey])

  const reload = useCallback(() => setReloadKey(k => k + 1), [])

  async function cancel(j: OpsJobView) {
    if (!(await confirm({ message: `Cancel ${j.engineLabel} job ${j.jobId.slice(0, 12)}…?`, tone: 'danger' }))) return
    try { await authedSend('/api/admin/operations-center/jobs/cancel', { collection: j.collection, jobId: j.jobId }); reload() }
    catch (e) { setErr(e instanceof Error ? e.message : 'Cancel failed') }
  }

  const filtered = (jobs ?? []).filter(j => {
    if (mode === 'failures' && j.status !== 'failed') return false
    if (mode === 'operations' && status && j.status !== status) return false
    if (engine && j.engine !== engine) return false
    const q = search.trim().toLowerCase()
    if (q && !(j.jobId.toLowerCase().includes(q) || (j.organizerUid ?? '').toLowerCase().includes(q) || (j.eventId ?? '').toLowerCase().includes(q) || (j.campaignId ?? '').toLowerCase().includes(q))) return false
    return true
  })

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <SearchInput value={search} onChange={setSearch} placeholder="Search job ID, owner, event, campaign…" className="max-w-xs flex-1" />
        {mode === 'operations' && <FilterTabs options={STATUS_FILTERS} value={status} onChange={setStatus} aria-label="Filter by status" />}
        <button onClick={reload} className={cn(btnOutline, 'ml-auto')}><RefreshCw className="size-3.5" /> Refresh</button>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <EngineChip active={engine === ''} onClick={() => setEngine('')} label="All engines" />
        {ENGINES.map(e => <EngineChip key={e.key} active={engine === e.key} onClick={() => setEngine(e.key)} label={e.label} />)}
      </div>

      {mode === 'failures' && <Banner>Cancel is supported (reuses the job kernel). <strong>Retry / Restart are not supported</strong> — no retry engine exists; investigate the error and re-run the operation from its origin workspace.</Banner>}
      {err && <ErrorBanner>{err}</ErrorBanner>}

      <Card title={mode === 'failures' ? 'Failed jobs' : 'Recent jobs'} icon={mode === 'failures' ? AlertTriangle : ListChecks}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-[13px]">
            <thead className="border-b border-border text-left text-[11px] uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-semibold">Job</th><th className="px-4 py-2 font-semibold">Engine</th>
                <th className="px-4 py-2 font-semibold">Status</th><th className="px-4 py-2 text-right font-semibold">Progress</th>
                <th className="px-4 py-2 font-semibold">Owner / Event</th><th className="px-4 py-2 font-semibold">Created</th>
                <th className="px-4 py-2 text-right font-semibold">Duration</th><th className="px-4 py-2 text-right font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody>
              {jobs === null ? <tr><td colSpan={8} className="px-4 py-10 text-center"><Loader2 className="mx-auto size-5 animate-spin text-muted-foreground" /></td></tr>
                : filtered.length === 0 ? <tr><td colSpan={8} className="px-4 py-10 text-center text-muted-foreground">No jobs.</td></tr>
                : filtered.map(j => (
                  <tr key={`${j.collection}:${j.jobId}`} className="border-b border-border/60 align-top">
                    <td className="px-4 py-2"><div className="max-w-[160px] truncate font-mono text-[12px] text-foreground">{j.jobId}</div>{j.error && <div className="max-w-[200px] truncate text-[11px] text-red-600" title={j.error}>{j.error}</div>}</td>
                    <td className="px-4 py-2 text-muted-foreground">{j.engineLabel}</td>
                    <td className="px-4 py-2"><StatusPill tone={STATUS_TONE[j.status]}>{j.status}</StatusPill></td>
                    <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">{num(j.processed)}/{num(j.total)}{j.failed > 0 && <span className="text-red-600"> · {num(j.failed)}✗</span>}</td>
                    <td className="px-4 py-2"><div className="max-w-[160px] truncate text-[12px] text-muted-foreground">{j.eventId ?? j.campaignId ?? '—'}</div><div className="max-w-[160px] truncate text-[11px] text-muted-foreground/70">{j.organizerUid ? `${j.organizerUid.slice(0, 10)}…` : ''}</div></td>
                    <td className="px-4 py-2 text-muted-foreground">{fmtDate(j.createdAt)}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">{fmtDuration(j.durationMs)}</td>
                    <td className="px-4 py-2">
                      <div className="flex flex-col items-end gap-1">
                        {j.cancellable ? <button onClick={() => void cancel(j)} className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11.5px] font-medium text-red-600 hover:bg-red-50"><Ban className="size-3.5" /> Cancel</button>
                          : <span className="text-[11px] text-muted-foreground">terminal</span>}
                        {j.status === 'failed' && <span className="inline-flex items-center gap-1 text-[10.5px] text-muted-foreground" title="No retry engine exists"><XCircle className="size-3" /> Retry not supported</span>}
                      </div>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </Card>
      {truncated && <p className="text-[12px] text-muted-foreground">Showing the most recent jobs per engine (bounded). Refine with search or the engine filter.</p>}
    </div>
  )
}

function EngineChip({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return <button onClick={onClick} className={cn('rounded-full border px-3 py-1 text-[12px] font-medium transition-colors', active ? 'border-primary bg-primary/[0.08] text-primary' : 'border-border text-muted-foreground hover:bg-muted')}>{label}</button>
}

async function authedSend(url: string, body: unknown): Promise<void> {
  const token = await getToken()
  const res = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  if (!res.ok) { const b = await res.json().catch(() => null) as { error?: string } | null; throw new Error(b?.error ?? `Request failed (${res.status})`) }
}

// ─── Monitoring ────────────────────────────────────────────────────────────────

function MonitoringWorkspace() {
  const [data, setData] = useState<OpsMonitoring | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    void (async () => {
      try { const d = await authedGet<OpsMonitoringResponse>('/api/admin/operations-center/monitoring'); if (alive) { setErr(null); setData(d.monitoring) } }
      catch (e) { if (alive) setErr(e instanceof Error ? e.message : 'Failed to load monitoring') }
    })()
    return () => { alive = false }
  }, [])

  if (err) return <ErrorBanner>{err}</ErrorBanner>
  if (!data) return <CenterSpin />

  const successData = data.engines.map(e => ({ label: e.label, value: e.successRatePct ?? 0 }))
  const throughputData = data.engines.map(e => ({ label: e.label, value: e.throughputPerDay }))

  return (
    <div className="space-y-4">
      <p className="text-[12px] text-muted-foreground">Rates &amp; durations computed from the {data.sampleSize} most recent jobs per engine (bounded sample — no full scan).</p>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Success rate by engine (%)" icon={CheckCircle2}><div className="p-4"><HBars data={successData} /></div></Card>
        <Card title="Throughput — jobs in last 24h" icon={Activity}><div className="p-4"><Bars data={throughputData} /></div></Card>
      </div>
      <Card title="Job statistics" icon={Gauge}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-[13px]">
            <thead className="border-b border-border text-left text-[11px] uppercase tracking-wide text-muted-foreground">
              <tr><th className="px-4 py-2 font-semibold">Engine</th><th className="px-4 py-2 text-right font-semibold">Running</th><th className="px-4 py-2 text-right font-semibold">Completed</th><th className="px-4 py-2 text-right font-semibold">Failed</th><th className="px-4 py-2 text-right font-semibold">Success</th><th className="px-4 py-2 text-right font-semibold">Failure</th><th className="px-4 py-2 text-right font-semibold">Avg runtime</th></tr>
            </thead>
            <tbody>
              {data.engines.map(e => (
                <tr key={e.key} className="border-b border-border/60">
                  <td className="px-4 py-2 font-medium text-foreground">{e.label}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{num(e.running)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{num(e.completed)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{e.failed > 0 ? <span className="text-red-600">{num(e.failed)}</span> : '0'}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{e.successRatePct == null ? '—' : `${e.successRatePct}%`}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{e.failureRatePct == null ? '—' : `${e.failureRatePct}%`}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{fmtDuration(e.avgDurationMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  )
}

// ─── Audit (timeline) ──────────────────────────────────────────────────────────

const TIMELINE_TONE: Record<OpsTimelineEntry['kind'], PillTone> = {
  created: 'info', completed: 'success', failed: 'danger', cancelled: 'neutral', admin: 'accent',
}

function AuditWorkspace() {
  const [entries, setEntries] = useState<OpsTimelineEntry[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    void (async () => {
      try { const d = await authedGet<OpsTimelineResponse>('/api/admin/operations-center/timeline'); if (alive) { setErr(null); setEntries(d.entries) } }
      catch (e) { if (alive) setErr(e instanceof Error ? e.message : 'Failed to load timeline') }
    })()
    return () => { alive = false }
  }, [])

  return (
    <div className="space-y-4">
      {err && <ErrorBanner>{err}</ErrorBanner>}
      <Card title="Configuration & audit" icon={ScrollText}>
        <div className="flex flex-wrap gap-2 p-4"><DeepLink href="/admin/audit" label="Admin Audit Log" /><DeepLink href="/admin/operations" label="Platform Health" /></div>
      </Card>
      <Card title="Job timeline — created · completed · failed · cancelled" icon={ScrollText}>
        <div className="p-4">
          {entries === null ? <CenterSpin /> : entries.length === 0 ? <Empty>No job activity yet.</Empty> : (
            <ol className="space-y-2">
              {entries.map(t => (
                <li key={t.id} className="rounded-lg border border-border bg-muted/30 px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="inline-flex items-center gap-2"><StatusPill tone={TIMELINE_TONE[t.kind]}>{t.kind}</StatusPill><span className="font-medium text-foreground">{t.detail}</span>{t.entity && <span className="text-[11px] text-muted-foreground">{t.entity}</span>}</span>
                    <span className="text-[11px] text-muted-foreground">{fmtDate(t.at)}</span>
                  </div>
                  {t.jobId && <p className="mt-0.5 font-mono text-[11px] text-muted-foreground/70">{t.jobId}</p>}
                </li>
              ))}
            </ol>
          )}
        </div>
      </Card>
    </div>
  )
}

// ─── Settings (read-only, future-ready) ─────────────────────────────────────

function SettingsWorkspace() {
  return (
    <div className="space-y-4">
      <Banner>Operational configuration is managed in code today (per-job lease, budget and page-size constants in the job runner). This workspace is read-only and future-ready — no editable operational settings exist yet.</Banner>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Retention" icon={Clock}>
          <dl className="space-y-2 p-4 text-[13.5px]">
            <Row label="Download links (print/export)" value="24 hours" />
            <Row label="Job records" value="Retained (no auto-purge)" />
          </dl>
        </Card>
        <Card title="Limits & workers" icon={Cog}>
          <dl className="space-y-2 p-4 text-[13.5px]">
            <Row label="Execution model" value="Cron-driven cursor runner" />
            <Row label="Distributed workers" value="Not configured" />
            <Row label="Autoscaling / scheduler" value="Not configured" />
          </dl>
        </Card>
      </div>
      <Card title="Manage configuration" icon={ExternalLink}>
        <div className="flex flex-wrap gap-2 p-4"><DeepLink href="/admin/business-configuration" label="Business Configuration" /><DeepLink href="/admin/operations" label="Platform Health & Recovery" /></div>
      </Card>
    </div>
  )
}

// ─── Shared primitives ─────────────────────────────────────────────────────────

const btnOutline = 'inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-[13px] font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50'

function CenterSpin() { return <div className="flex justify-center py-16"><Loader2 className="size-6 animate-spin text-muted-foreground" /></div> }
function Empty({ children }: { children: React.ReactNode }) { return <p className="text-[13px] text-muted-foreground">{children}</p> }
function Banner({ children }: { children: React.ReactNode }) {
  return <div className="flex items-start gap-2 rounded-lg border border-amber-300/50 bg-amber-50/50 px-3 py-2 text-[12.5px] text-foreground"><AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-600" />{children}</div>
}
function Kpi({ icon: Icon, label, value }: { icon: typeof Activity; label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-3.5">
      <div className="flex items-center gap-1.5 text-muted-foreground"><Icon className="size-3.5" aria-hidden /><span className="truncate text-[11px] font-medium uppercase tracking-wide">{label}</span></div>
      <p className="mt-1.5 truncate text-[19px] font-bold tabular-nums text-foreground" title={value}>{value}</p>
    </div>
  )
}
function Card({ title, icon: Icon, children }: { title: string; icon?: typeof Activity; children: React.ReactNode }) {
  return (
    <section className="overflow-hidden rounded-xl border border-border bg-card">
      <header className="flex items-center gap-2 border-b border-border px-4 py-2.5">{Icon && <Icon className="size-4 text-muted-foreground" aria-hidden />}<h2 className="text-[13.5px] font-semibold text-foreground">{title}</h2></header>
      {children}
    </section>
  )
}
function Row({ label, value }: { label: string; value: string }) {
  return <div className="flex items-center justify-between gap-3"><dt className="text-[12.5px] text-muted-foreground">{label}</dt><dd className="min-w-0 truncate text-right font-medium text-foreground" title={value}>{value}</dd></div>
}
function DeepLink({ href, label }: { href: string; label: string }) {
  return <Link href={href} className={btnOutline}><span>{label}</span><ExternalLink className="size-3.5 text-muted-foreground" /></Link>
}
