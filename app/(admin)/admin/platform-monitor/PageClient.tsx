'use client'

// Enterprise Platform Monitoring Dashboard (GA-2 S5).
// The health-facing complement to the Operations Center: "how healthy is the
// platform?". Six lazy workspaces over a permanent Health Panel. Purely additive +
// reuse-first — it COMPOSES existing endpoints (analytics, operations health,
// operations-center monitoring/timeline, communications) plus three thin new
// aggregators. HONESTY RULE: metrics that cannot be derived render "Unavailable" —
// never estimated, never fabricated. No new monitoring engine.

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { auth } from '@/lib/firebase/auth'
import { cn } from '@/lib/utils/cn'
import {
  Loader2, RefreshCw, Activity, AlertTriangle, CheckCircle2, ScrollText, Gauge,
  Database, HardDrive, Boxes, Server, Cog, ExternalLink, ShieldCheck, CreditCard,
  Mail, MessageSquare, Award, Printer, FileText, KeyRound, Gift, Clock, Zap, Search,
} from 'lucide-react'
import { StatusPill, ErrorBanner, SearchInput } from '@/components/admin'
import type { PillTone } from '@/components/admin'
import { Bars, HBars } from '@/components/analytics/Charts'
import type {
  PlatformOverview, PlatformOverviewResponse, ServiceHealth, PlatformServicesResponse,
  PlatformSecurity, PlatformSecurityResponse, HealthIndicator, HealthLevel, ServiceLevel,
} from '@/lib/admin/platformMonitorTypes'
import type { OperationsHealth, OperationalAlert } from '@/lib/operations/healthMetrics'
import type { OpsMonitoringResponse, OpsMonitoring, OpsTimelineEntry, OpsTimelineResponse } from '@/lib/admin/operationsCenterTypes'
import type { AdminAnalytics } from '@/lib/analytics/adminAnalytics'

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
const rupees = (p: number): string => `₹${Math.round(p / 100).toLocaleString('en-IN')}`
const orUnavailable = (v: number | null, fmt: (n: number) => string): string => (v == null ? 'Unavailable' : fmt(v))
const fmtDate = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'
const fmtAgo = (iso: string | null): string => {
  if (!iso) return 'never'
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 60000) return 'just now'
  const m = Math.floor(ms / 60000); if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}
function fmtDuration(ms: number | null): string {
  if (ms == null) return '—'
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.round(ms / 60000)}m`
}

const HEALTH_DOT: Record<HealthLevel, string> = {
  green: 'bg-emerald-500', yellow: 'bg-amber-500', red: 'bg-red-500', neutral: 'bg-muted-foreground/40',
}
const SERVICE_TONE: Record<ServiceLevel, PillTone> = { healthy: 'success', warning: 'warning', unavailable: 'neutral' }
const SERVICE_ICON: Record<string, typeof CreditCard> = {
  payments: CreditCard, email: Mail, whatsapp: MessageSquare, certificates: Award, print: Printer,
  reports: FileText, licensing: KeyRound, coupons: Gift,
}

type TabKey = 'overview' | 'infrastructure' | 'services' | 'performance' | 'security' | 'observability'
const TABS: { key: TabKey; label: string }[] = [
  { key: 'overview', label: 'Overview' }, { key: 'infrastructure', label: 'Infrastructure' },
  { key: 'services', label: 'Services' }, { key: 'performance', label: 'Performance' },
  { key: 'security', label: 'Security' }, { key: 'observability', label: 'Observability' },
]

// ─── Page ───────────────────────────────────────────────────────────────────

export default function PlatformMonitorPage() {
  const [tab, setTab] = useState<TabKey>('overview')
  const [overview, setOverview] = useState<PlatformOverview | null>(null)
  const [health, setHealth] = useState<HealthIndicator[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [ovKey, setOvKey] = useState(0)

  useEffect(() => {
    let alive = true
    void (async () => {
      try { const d = await authedGet<PlatformOverviewResponse>('/api/admin/platform-monitor/overview'); if (alive) { setErr(null); setOverview(d.overview); setHealth(prev => mergeHealth(d.overview.health, prev)) } }
      catch (e) { if (alive) setErr(e instanceof Error ? e.message : 'Failed to load overview') }
    })()
    return () => { alive = false }
  }, [ovKey])

  // Infrastructure health signal (cron) is upgraded into the panel when known.
  function upgradeInfra(level: HealthLevel, detail: string) {
    setHealth(prev => prev.map(h => h.key === 'infrastructure' ? { ...h, level, detail } : h))
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link href="/admin/operations-center" className="mb-1 inline-flex items-center gap-1.5 text-[12.5px] font-medium text-muted-foreground transition-colors hover:text-foreground">
            <Activity className="size-3.5" /> Operations Center
          </Link>
          <h1 className="text-[20px] font-bold tracking-tight text-foreground">Platform Monitoring</h1>
          <p className="mt-0.5 text-[12.5px] text-muted-foreground">How healthy is the platform? — reuses existing analytics &amp; health signals.{overview?.version ? ` · v${overview.version}` : ''}</p>
        </div>
        <button onClick={() => setOvKey(k => k + 1)} className={btnOutline}><RefreshCw className="size-3.5" /> Refresh</button>
      </div>

      {err && <ErrorBanner>{err}</ErrorBanner>}
      <HealthPanel indicators={health} />

      <div className="flex flex-wrap gap-1 border-b border-border">
        {TABS.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)} aria-current={tab === t.key ? 'page' : undefined}
            className={cn('rounded-t-md px-3.5 py-2 text-[13.5px] font-medium transition-colors', tab === t.key ? 'border-b-2 border-primary text-primary' : 'text-muted-foreground hover:text-foreground')}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'overview' && (overview ? <OverviewWorkspace o={overview} onGoto={setTab} /> : !err && <CenterSpin />)}
      {tab === 'infrastructure' && <InfrastructureWorkspace onInfraHealth={upgradeInfra} />}
      {tab === 'services' && <ServicesWorkspace />}
      {tab === 'performance' && <PerformanceWorkspace />}
      {tab === 'security' && <SecurityWorkspace />}
      {tab === 'observability' && <ObservabilityWorkspace />}
    </div>
  )
}

function mergeHealth(fresh: HealthIndicator[], prev: HealthIndicator[]): HealthIndicator[] {
  const prevMap = new Map(prev.map(h => [h.key, h]))
  return fresh.map(h => (h.level === 'neutral' && prevMap.get(h.key) && prevMap.get(h.key)!.level !== 'neutral') ? prevMap.get(h.key)! : h)
}

// ─── Health Panel ─────────────────────────────────────────────────────────────

function HealthPanel({ indicators }: { indicators: HealthIndicator[] }) {
  if (!indicators.length) return <div className="flex items-center gap-2 rounded-xl border border-border bg-card p-4 text-[13px] text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Evaluating platform health…</div>
  return (
    <div className="rounded-xl border border-border bg-card p-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8">
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

function OverviewWorkspace({ o, onGoto }: { o: PlatformOverview; onGoto: (t: TabKey) => void }) {
  const [alerts, setAlerts] = useState<OperationalAlert[] | null>(null)
  useEffect(() => {
    let alive = true
    void (async () => {
      try { const d = await authedGet<{ alerts: OperationalAlert[] }>('/api/admin/operations'); if (alive) setAlerts(d.alerts) }
      catch { if (alive) setAlerts([]) }
    })()
    return () => { alive = false }
  }, [])

  const k = o.kpis
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        <Kpi icon={Server} label="Active organizers" value={num(k.activeOrganizers)} />
        <Kpi icon={Activity} label="Active events" value={num(k.activeEvents)} />
        <Kpi icon={CheckCircle2} label="Registrations today" value={orUnavailable(k.registrationsToday, num)} />
        <Kpi icon={CreditCard} label="Payments today" value={orUnavailable(k.paymentsToday, num)} />
        <Kpi icon={Zap} label="Revenue today" value={orUnavailable(k.revenueTodayPaise, rupees)} />
        <Kpi icon={KeyRound} label="Lifetime revenue" value={rupees(k.lifetimeRevenuePaise)} />
        <Kpi icon={Gauge} label="Running jobs" value={num(k.runningJobs)} />
        <Kpi icon={AlertTriangle} label="Failed jobs" value={num(k.failedJobs)} />
      </div>

      <Card title="Critical alerts" icon={AlertTriangle}>
        <div className="p-4">
          {alerts === null ? <div className="flex items-center gap-2 text-[13px] text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Loading…</div>
            : alerts.length === 0 ? <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-[13px] text-emerald-700">All clear — no active alerts.</div>
            : <div className="space-y-2">{alerts.map(a => (
                <div key={a.id} className={cn('flex items-start gap-2 rounded-lg border px-3 py-2 text-[13px]', a.severity === 'critical' ? 'border-rose-200 bg-rose-50 text-rose-800' : 'border-amber-200 bg-amber-50 text-amber-800')}>
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />{a.message}
                </div>))}
              </div>}
        </div>
      </Card>

      <Card title="Quick actions" icon={Cog}>
        <div className="flex flex-wrap gap-2 p-4">
          <button onClick={() => onGoto('services')} className={btnOutline}><Boxes className="size-3.5" /> Services</button>
          <button onClick={() => onGoto('performance')} className={btnOutline}><Gauge className="size-3.5" /> Performance</button>
          <button onClick={() => onGoto('security')} className={btnOutline}><ShieldCheck className="size-3.5" /> Security</button>
          <DeepLink href="/admin/operations-center" label="Operations Center" />
          <DeepLink href="/admin/dashboard" label="Admin Dashboard" />
          <DeepLink href="/admin/analytics" label="Analytics" />
        </div>
      </Card>
    </div>
  )
}

// ─── Infrastructure ─────────────────────────────────────────────────────────

function InfrastructureWorkspace({ onInfraHealth }: { onInfraHealth: (level: HealthLevel, detail: string) => void }) {
  const [health, setHealth] = useState<OperationsHealth | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const d = await authedGet<{ health: OperationsHealth }>('/api/admin/operations')
        if (!alive) return
        setErr(null); setHealth(d.health)
        const failing = d.health.crons.filter(c => c.failedWithin24h).length
        onInfraHealth(failing > 0 ? 'red' : d.health.crons.length ? 'green' : 'neutral', failing > 0 ? `${failing} cron(s) failing` : `${d.health.crons.length} crons healthy`)
      } catch (e) { if (alive) setErr(e instanceof Error ? e.message : 'Failed to load infrastructure') }
    })()
    return () => { alive = false }
  }, [onInfraHealth])

  return (
    <div className="space-y-4">
      <Banner>Firestore, Storage, Index and Environment metrics are not exposed by any existing data source, so they are shown as <strong>Unavailable</strong> rather than estimated. Cron health below is real (from the operations health service).</Banner>
      {err && <ErrorBanner>{err}</ErrorBanner>}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <UnavailableCard icon={Database} label="Firestore" />
        <UnavailableCard icon={HardDrive} label="Storage" />
        <UnavailableCard icon={Boxes} label="Indexes" />
        <UnavailableCard icon={Server} label="Environment" />
        <UnavailableCard icon={Cog} label="Workers" note="Cron-driven" />
        <UnavailableCard icon={Boxes} label="Autoscaling" note="Not configured" />
      </div>

      <Card title="Scheduled jobs (cron)" icon={Clock}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-[13px]">
            <thead className="border-b border-border text-left text-[11px] uppercase tracking-wide text-muted-foreground">
              <tr><th className="px-4 py-2 font-semibold">Cron</th><th className="px-4 py-2 font-semibold">Status</th><th className="px-4 py-2 font-semibold">Last success</th><th className="px-4 py-2 text-right font-semibold">Runs</th><th className="px-4 py-2 text-right font-semibold">Failures</th></tr>
            </thead>
            <tbody>
              {health === null ? <tr><td colSpan={5} className="px-4 py-8 text-center"><Loader2 className="mx-auto size-5 animate-spin text-muted-foreground" /></td></tr>
                : health.crons.map(c => (
                  <tr key={c.cronName} className="border-b border-border/60">
                    <td className="px-4 py-2 font-medium text-foreground">{c.cronName}</td>
                    <td className="px-4 py-2"><StatusPill tone={c.failedWithin24h ? 'danger' : c.lastOk === true ? 'success' : c.lastOk === false ? 'warning' : 'neutral'}>{c.failedWithin24h ? 'failing' : c.lastOk === true ? 'ok' : c.lastOk === false ? 'degraded' : 'idle'}</StatusPill></td>
                    <td className="px-4 py-2 text-muted-foreground">{fmtAgo(c.lastSuccessAt)}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{num(c.runCount)}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{c.failureCount > 0 ? <span className="text-red-600">{num(c.failureCount)}</span> : '0'}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="Platform configuration" icon={Cog}>
        <div className="flex flex-wrap gap-2 p-4"><DeepLink href="/admin/business-configuration" label="Business Configuration" /><DeepLink href="/admin/operations" label="Platform Health & Recovery" /></div>
      </Card>
    </div>
  )
}

function UnavailableCard({ icon: Icon, label, note }: { icon: typeof Database; label: string; note?: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-3.5">
      <div className="flex items-center gap-1.5 text-muted-foreground"><Icon className="size-3.5" aria-hidden /><span className="truncate text-[11px] font-medium uppercase tracking-wide">{label}</span></div>
      <p className="mt-1.5 text-[13px] font-semibold text-muted-foreground">{note ?? 'Unavailable'}</p>
    </div>
  )
}

// ─── Services ──────────────────────────────────────────────────────────────

function ServicesWorkspace() {
  const [services, setServices] = useState<ServiceHealth[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    void (async () => {
      try { const d = await authedGet<PlatformServicesResponse>('/api/admin/platform-monitor/services'); if (alive) { setErr(null); setServices(d.services) } }
      catch (e) { if (alive) setErr(e instanceof Error ? e.message : 'Failed to load services') }
    })()
    return () => { alive = false }
  }, [])

  if (err) return <ErrorBanner>{err}</ErrorBanner>
  if (!services) return <CenterSpin />
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {services.map(s => {
        const Icon = SERVICE_ICON[s.key] ?? Boxes
        return (
          <div key={s.key} className="rounded-xl border border-border bg-card p-4">
            <div className="flex items-center justify-between gap-2">
              <span className="inline-flex items-center gap-2"><Icon className="size-4 text-muted-foreground" aria-hidden /><span className="text-[13.5px] font-semibold text-foreground">{s.label}</span></span>
              <StatusPill tone={SERVICE_TONE[s.level]}>{s.level}</StatusPill>
            </div>
            <p className="mt-2 text-[17px] font-bold tabular-nums text-foreground">{s.metric ?? 'Unavailable'}</p>
            <p className="mt-0.5 text-[12px] text-muted-foreground">{s.detail}</p>
          </div>
        )
      })}
    </div>
  )
}

// ─── Performance ────────────────────────────────────────────────────────────

function PerformanceWorkspace() {
  const [mon, setMon] = useState<OpsMonitoring | null>(null)
  const [analytics, setAnalytics] = useState<AdminAnalytics | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const [m, a] = await Promise.all([
          authedGet<OpsMonitoringResponse>('/api/admin/operations-center/monitoring'),
          authedGet<{ analytics: AdminAnalytics }>('/api/admin/analytics'),
        ])
        if (alive) { setErr(null); setMon(m.monitoring); setAnalytics(a.analytics) }
      } catch (e) { if (alive) setErr(e instanceof Error ? e.message : 'Failed to load performance') }
    })()
    return () => { alive = false }
  }, [])

  if (err) return <ErrorBanner>{err}</ErrorBanner>
  if (!mon || !analytics) return <CenterSpin />

  return (
    <div className="space-y-4">
      <p className="text-[12px] text-muted-foreground">Job rates &amp; durations reuse the Operations Center monitoring sample ({mon.sampleSize}/engine). Platform trend reuses admin analytics.</p>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Success rate by engine (%)" icon={CheckCircle2}><div className="p-4"><HBars data={mon.engines.map(e => ({ label: e.label, value: e.successRatePct ?? 0 }))} /></div></Card>
        <Card title="Platform growth — events / day" icon={Activity}><div className="p-4"><Bars data={analytics.growth.eventsByDay} /></div></Card>
      </div>
      <Card title="Job statistics" icon={Gauge}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-[13px]">
            <thead className="border-b border-border text-left text-[11px] uppercase tracking-wide text-muted-foreground">
              <tr><th className="px-4 py-2 font-semibold">Engine</th><th className="px-4 py-2 text-right font-semibold">Running</th><th className="px-4 py-2 text-right font-semibold">Completed</th><th className="px-4 py-2 text-right font-semibold">Failed</th><th className="px-4 py-2 text-right font-semibold">Success</th><th className="px-4 py-2 text-right font-semibold">Failure</th><th className="px-4 py-2 text-right font-semibold">Avg runtime</th><th className="px-4 py-2 text-right font-semibold">24h</th></tr>
            </thead>
            <tbody>
              {mon.engines.map(e => (
                <tr key={e.key} className="border-b border-border/60">
                  <td className="px-4 py-2 font-medium text-foreground">{e.label}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{num(e.running)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{num(e.completed)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{e.failed > 0 ? <span className="text-red-600">{num(e.failed)}</span> : '0'}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{e.successRatePct == null ? 'Unavailable' : `${e.successRatePct}%`}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{e.failureRatePct == null ? 'Unavailable' : `${e.failureRatePct}%`}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{fmtDuration(e.avgDurationMs)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{num(e.throughputPerDay)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  )
}

// ─── Security ──────────────────────────────────────────────────────────────

function SecurityWorkspace() {
  const [sec, setSec] = useState<PlatformSecurity | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  useEffect(() => {
    let alive = true
    void (async () => {
      try { const d = await authedGet<PlatformSecurityResponse>('/api/admin/platform-monitor/security'); if (alive) { setErr(null); setSec(d.security) } }
      catch (e) { if (alive) setErr(e instanceof Error ? e.message : 'Failed to load security') }
    })()
    return () => { alive = false }
  }, [])

  const filtered = useMemo(() => {
    if (!sec) return []
    const q = search.trim().toLowerCase()
    if (!q) return sec.recentActivity
    return sec.recentActivity.filter(e => e.action.toLowerCase().includes(q) || e.entityType.toLowerCase().includes(q) || (e.entityId ?? '').toLowerCase().includes(q) || (e.actor ?? '').toLowerCase().includes(q))
  }, [sec, search])

  if (err) return <ErrorBanner>{err}</ErrorBanner>
  if (!sec) return <CenterSpin />

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Kpi icon={ShieldCheck} label="Audit (24h)" value={num(sec.auditHealth.last24h)} />
        <Kpi icon={Clock} label="Last entry" value={fmtAgo(sec.auditHealth.lastEntryAt)} />
        <Kpi icon={Cog} label="Overrides (recent)" value={num(sec.counts.overrides)} />
        <Kpi icon={AlertTriangle} label="Moderation (recent)" value={num(sec.counts.moderation)} />
      </div>
      <Banner>Authentication, authorization and rate-limit telemetry are not exposed as platform metrics — <strong>only the admin audit trail</strong> is surfaced here. Fields without a source are omitted rather than estimated.</Banner>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Overrides & permission changes" icon={Cog}>
          <div className="p-4">
            {sec.overrides.length === 0 ? <Empty>No overrides recorded.</Empty> : (
              <ul className="space-y-1.5">{sec.overrides.map(e => (
                <li key={e.id} className="rounded-md bg-muted/30 px-3 py-1.5 text-[12.5px]">
                  <div className="flex items-center justify-between gap-2"><span className="font-medium capitalize text-foreground">{e.action.replace(/[._]/g, ' ')}</span><span className="text-[11px] text-muted-foreground">{fmtAgo(e.at)}</span></div>
                  {e.reason && <p className="text-[11px] text-muted-foreground">{e.reason}</p>}
                </li>))}
              </ul>
            )}
          </div>
        </Card>
        <Card title="Recent admin activity" icon={ShieldCheck}>
          <div className="space-y-2 p-4">
            <SearchInput value={search} onChange={setSearch} placeholder="Search action, entity, admin…" />
            {filtered.length === 0 ? <Empty>No matching activity.</Empty> : (
              <ul className="max-h-[360px] space-y-1.5 overflow-y-auto">{filtered.map(e => (
                <li key={e.id} className="rounded-md bg-muted/30 px-3 py-1.5 text-[12.5px]">
                  <div className="flex items-center justify-between gap-2"><span className="inline-flex items-center gap-1.5"><StatusPill tone="info">{e.entityType || 'admin'}</StatusPill><span className="font-medium capitalize text-foreground">{e.action.replace(/[._]/g, ' ')}</span></span><span className="text-[11px] text-muted-foreground">{fmtAgo(e.at)}</span></div>
                </li>))}
              </ul>
            )}
          </div>
        </Card>
      </div>
    </div>
  )
}

// ─── Observability (merged platform timeline) ───────────────────────────────

interface FeedEntry { id: string; source: 'job' | 'admin'; kind: string; detail: string; entity: string | null; at: string | null }
const FEED_TONE: Record<string, PillTone> = {
  created: 'info', completed: 'success', failed: 'danger', cancelled: 'neutral', admin: 'accent',
}

function ObservabilityWorkspace() {
  const [feed, setFeed] = useState<FeedEntry[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const [jobs, sec] = await Promise.all([
          authedGet<OpsTimelineResponse>('/api/admin/operations-center/timeline'),
          authedGet<PlatformSecurityResponse>('/api/admin/platform-monitor/security'),
        ])
        if (!alive) return
        const jobEntries: FeedEntry[] = jobs.entries.map((t: OpsTimelineEntry) => ({ id: t.id, source: 'job', kind: t.kind, detail: t.detail, entity: t.entity, at: t.at }))
        const adminEntries: FeedEntry[] = sec.security.recentActivity.map(e => ({ id: `admin:${e.id}`, source: 'admin', kind: 'admin', detail: e.action.replace(/[._]/g, ' '), entity: e.entityId ?? e.entityType, at: e.at }))
        const merged = [...jobEntries, ...adminEntries].sort((a, b) => (b.at ? Date.parse(b.at) : -Infinity) - (a.at ? Date.parse(a.at) : -Infinity))
        setErr(null); setFeed(merged.slice(0, 400))
      } catch (e) { if (alive) setErr(e instanceof Error ? e.message : 'Failed to load timeline') }
    })()
    return () => { alive = false }
  }, [])

  const filtered = useMemo(() => {
    if (!feed) return []
    const q = search.trim().toLowerCase()
    if (!q) return feed
    return feed.filter(e => e.detail.toLowerCase().includes(q) || (e.entity ?? '').toLowerCase().includes(q) || e.kind.toLowerCase().includes(q))
  }, [feed, search])

  if (err) return <ErrorBanner>{err}</ErrorBanner>
  if (!feed) return <CenterSpin />

  return (
    <div className="space-y-4">
      <Card title="Platform timeline — job & admin events merged" icon={ScrollText}>
        <div className="space-y-3 p-4">
          <div className="flex items-center gap-2"><Search className="size-4 text-muted-foreground" /><SearchInput value={search} onChange={setSearch} placeholder="Search event, entity, kind…" className="max-w-sm" /></div>
          {filtered.length === 0 ? <Empty>No activity.</Empty> : (
            <ol className="space-y-2">{filtered.map(t => (
              <li key={t.id} className="rounded-lg border border-border bg-muted/30 px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="inline-flex items-center gap-2"><StatusPill tone={FEED_TONE[t.kind] ?? 'neutral'}>{t.source === 'admin' ? 'admin' : t.kind}</StatusPill><span className="font-medium text-foreground">{t.detail}</span>{t.entity && <span className="text-[11px] text-muted-foreground">{t.entity}</span>}</span>
                  <span className="text-[11px] text-muted-foreground">{fmtDate(t.at)}</span>
                </div>
              </li>))}
            </ol>
          )}
        </div>
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
function DeepLink({ href, label }: { href: string; label: string }) {
  return <Link href={href} className={btnOutline}><span>{label}</span><ExternalLink className="size-3.5 text-muted-foreground" /></Link>
}
