'use client'

// RD-PLATFORM-COMMS-01 Phase 4B — Admin Enterprise Communication Center (read-only).
// Overview + Providers + Health, rendered ENTIRELY from the canonical read model served by
// GET /api/admin/communications/health (resolveAdminCommunicationOverview). This screen
// computes NO communication status locally — every value comes from the resolver. SMS/Push
// always render "Unavailable", never Active. Future sections are shown as disabled tabs.

import { Fragment, useEffect, useState } from 'react'
import { auth } from '@/lib/firebase/auth'
import {
  Loader2, Mail, MessageSquare, Phone, BellRing, ShieldCheck, ShieldAlert, ShieldQuestion,
  CheckCircle2, AlertTriangle, XCircle, Wrench,
} from 'lucide-react'
import { ErrorBanner } from '@/components/admin'
import type { AdminCommunicationOverview, AdminProviderView } from '@/lib/communications/health/adminOverview'
import type { HealthStatus } from '@/lib/communications/health/types'
import type { ResolvedRegistryEntry } from '@/lib/communications/registry/resolve'
import { COMM_REGISTRY_CATEGORIES } from '@/lib/communications/registry/catalog'
import type { ResolvedNotificationPolicy } from '@/lib/communications/policy/resolve'
import type { TemplateCenterView } from '@/lib/communications/templates/server'
import type { TimelineEntry, TimelineStatus } from '@/lib/communications/timeline/types'
import { TIMELINE_STATUS_LABELS } from '@/lib/communications/timeline/types'
import type { TimelineResult } from '@/lib/communications/timeline/resolve'
import type { CommunicationAnalytics, CommMetrics } from '@/lib/communications/analytics/types'
import type { CommunicationInsight, InsightSeverity, InsightCategory } from '@/lib/communications/insights/types'
import type { PlaygroundSession, PlaygroundVariable } from '@/lib/communications/playground/types'
import type { ResolvedCampaign } from '@/lib/communications/campaigns/types'
import type { ResolvedAudience } from '@/lib/communications/audiences/types'
import type { CampaignDraft } from '@/lib/communications/composer/types'
import type { ResolvedApproval } from '@/lib/communications/approval/types'
import type { ExecutionPlan } from '@/lib/communications/planner/types'

const STATUS: Record<HealthStatus, { label: string; cls: string; dot: string; Icon: typeof CheckCircle2 }> = {
  green: { label: 'Healthy',  cls: 'bg-emerald-50 text-emerald-700 border-emerald-200', dot: 'bg-emerald-500', Icon: CheckCircle2 },
  amber: { label: 'Degraded', cls: 'bg-amber-50 text-amber-700 border-amber-200',       dot: 'bg-amber-500',   Icon: AlertTriangle },
  red:   { label: 'Down',     cls: 'bg-rose-50 text-rose-700 border-rose-200',          dot: 'bg-rose-500',    Icon: XCircle },
}
const CH_ICON: Record<string, typeof Mail> = { email: Mail, whatsapp: MessageSquare, sms: Phone, push: BellRing }

function StatusPill({ status }: { status: HealthStatus }) {
  const s = STATUS[status]
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[12px] font-semibold ${s.cls}`}>
      <span className={`size-1.5 rounded-full ${s.dot}`} aria-hidden /> {s.label}
    </span>
  )
}

const TABS = [
  { id: 'overview',  label: 'Overview',  live: true },
  { id: 'providers', label: 'Providers', live: true },
  { id: 'health',    label: 'Health',    live: true },
  { id: 'notifications', label: 'Notifications', live: true },
  { id: 'policies',  label: 'Policies',   live: true },
  { id: 'templates', label: 'Templates',  live: true },
  { id: 'timeline',  label: 'Timeline',    live: true },
  { id: 'analytics', label: 'Analytics',   live: true },
  { id: 'insights',  label: 'Insights',    live: true },
  { id: 'playground', label: 'Playground', live: true },
  { id: 'campaigns', label: 'Campaigns',   live: true },
  { id: 'audiences', label: 'Audiences',   live: true },
  { id: 'composer',  label: 'Composer',    live: true },
  { id: 'approval',  label: 'Approval',    live: true },
  { id: 'planner',   label: 'Execution Planner', live: true },
  { id: 'settings',  label: 'Settings',    live: false },
] as const

export default function CommunicationCenterPage() {
  const [data, setData]         = useState<AdminCommunicationOverview | null>(null)
  const [registry, setRegistry] = useState<ResolvedRegistryEntry[] | null>(null)
  const [policies, setPolicies] = useState<ResolvedNotificationPolicy[] | null>(null)
  const [templates, setTemplates] = useState<TemplateCenterView | null>(null)
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState<string | null>(null)
  const [tab, setTab]           = useState<'overview' | 'providers' | 'health' | 'notifications' | 'policies' | 'templates' | 'timeline' | 'analytics' | 'insights' | 'playground' | 'campaigns' | 'audiences' | 'composer' | 'approval' | 'planner'>('overview')

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const u = auth.currentUser
        if (!u) throw new Error('Not authenticated')
        const token = await u.getIdToken()
        const headers = { authorization: `Bearer ${token}` }
        const [hRes, rRes, pRes, tRes] = await Promise.all([
          fetch('/api/admin/communications/health',    { headers, cache: 'no-store' }),
          fetch('/api/admin/communications/registry',  { headers, cache: 'no-store' }),
          fetch('/api/admin/communications/policies',  { headers, cache: 'no-store' }),
          fetch('/api/admin/communications/templates', { headers, cache: 'no-store' }),
        ])
        for (const res of [hRes, rRes, pRes, tRes]) if (!res.ok) throw new Error(`Request failed (${res.status})`)
        const h = await hRes.json() as { data: AdminCommunicationOverview }
        const r = await rRes.json() as { data: ResolvedRegistryEntry[] }
        const p = await pRes.json() as { data: ResolvedNotificationPolicy[] }
        const t = await tRes.json() as { data: TemplateCenterView }
        if (alive) { setData(h.data); setRegistry(r.data); setPolicies(p.data); setTemplates(t.data) }
      } catch (e) { if (alive) setError(e instanceof Error ? e.message : 'Failed to load') }
      finally { if (alive) setLoading(false) }
    })()
    return () => { alive = false }
  }, [])

  return (
    <div className="space-y-5 p-5 sm:p-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-[22px] font-bold tracking-tight text-foreground">Communication Center</h1>
            {data && <StatusPill status={data.overall} />}
          </div>
          <p className="mt-1 text-[13px] text-muted-foreground">Platform communication health, providers, and readiness — RegisterDesk → Organizer.</p>
        </div>
      </div>

      {error && <ErrorBanner>{error}</ErrorBanner>}

      {/* Tabs */}
      <div className="flex flex-wrap gap-1 border-b border-border">
        {TABS.map(t => {
          const active = t.live && tab === t.id
          return (
            <button
              key={t.id}
              type="button"
              disabled={!t.live}
              onClick={() => t.live && setTab(t.id as 'overview' | 'providers' | 'health' | 'notifications' | 'policies' | 'templates' | 'timeline' | 'analytics' | 'insights' | 'playground' | 'campaigns' | 'audiences' | 'composer' | 'approval' | 'planner')}
              className={`relative px-3.5 py-2 text-[13px] font-medium transition-colors ${
                active ? 'text-primary' : t.live ? 'text-muted-foreground hover:text-foreground' : 'cursor-not-allowed text-muted-foreground/40'
              }`}
            >
              {t.label}
              {!t.live && <span className="ml-1.5 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground/60">Soon</span>}
              {active && <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-primary" aria-hidden />}
            </button>
          )
        })}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-24 text-muted-foreground"><Loader2 className="size-5 animate-spin" aria-hidden /></div>
      ) : !data ? null : (
        <>
          {tab === 'overview'  && <OverviewTab data={data} />}
          {tab === 'providers' && <ProvidersTab providers={data.providers} />}
          {tab === 'health'    && <HealthTab data={data} />}
          {tab === 'notifications' && registry && <NotificationsTab entries={registry} />}
          {tab === 'policies' && policies && registry && <PoliciesTab policies={policies} entries={registry} />}
          {tab === 'templates' && templates && <TemplatesTab view={templates} />}
          {tab === 'timeline'  && <TimelineTab />}
          {tab === 'analytics' && <AnalyticsTab />}
          {tab === 'insights'  && <InsightsTab />}
          {tab === 'playground' && registry && <PlaygroundTab notifications={registry} />}
          {tab === 'campaigns' && <CampaignsTab />}
          {tab === 'audiences' && <AudiencesTab />}
          {tab === 'composer' && registry && <ComposerTab notifications={registry} />}
          {tab === 'approval' && <ApprovalTab />}
          {tab === 'planner' && <PlannerTab />}
        </>
      )}
    </div>
  )
}

// ─── Overview ────────────────────────────────────────────────────────────────

function Tile({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <p className="text-[22px] font-bold leading-none tracking-tight text-foreground">{value}</p>
      <p className="mt-1.5 text-[13px] font-medium text-foreground">{label}</p>
      {sub && <p className="mt-0.5 text-[12px] text-muted-foreground">{sub}</p>}
    </div>
  )
}

function OverviewTab({ data }: { data: AdminCommunicationOverview }) {
  const c = data.counts
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        <Tile label="Accepted"   value={c.accepted.toLocaleString('en-IN')}  sub="Provider-accepted" />
        <Tile label="Delivered"  value={c.delivered.toLocaleString('en-IN')} sub="Confirmed (WhatsApp only)" />
        <Tile label="Failed"     value={c.failed.toLocaleString('en-IN')}    sub="Send-stage failures" />
        <Tile label="Pending"    value={c.pending.toLocaleString('en-IN')}   sub="Queued" />
        <Tile label="WhatsApp"   value={c.whatsapp.toLocaleString('en-IN')}  sub="Sent" />
        <Tile label="Campaigns"  value={c.campaigns.toLocaleString('en-IN')} sub={`${c.campaignsScheduled} scheduled`} />
        <Tile label="Reminders"  value={c.remindersScheduled.toLocaleString('en-IN')} sub="Scheduled" />
        <Tile label="WA templates" value={c.whatsappTemplates} sub="Meta-approved set" />
      </div>

      {/* Provider health summary */}
      <div>
        <h2 className="mb-2 text-[13px] font-semibold text-foreground">Provider health</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {data.providers.map(p => <ProviderMini key={p.id} p={p} />)}
        </div>
      </div>

      <Recommendations data={data} />
    </div>
  )
}

function ProviderMini({ p }: { p: AdminProviderView }) {
  const Icon = CH_ICON[p.id] ?? Mail
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border bg-card p-3.5">
      <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/[0.09]"><Icon className="size-4 text-primary" aria-hidden /></div>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-semibold text-foreground">{p.label}</p>
        <p className="truncate text-[12px] text-muted-foreground">{p.summary}</p>
      </div>
      {p.implemented ? <StatusPill status={p.status} /> : <span className="rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">Unavailable</span>}
    </div>
  )
}

// ─── Providers ───────────────────────────────────────────────────────────────

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between border-b border-border/40 py-2 text-[13px] last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium text-foreground">{value}</span>
    </div>
  )
}

function ProvidersTab({ providers }: { providers: AdminProviderView[] }) {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      {providers.map(p => {
        const Icon = CH_ICON[p.id] ?? Mail
        return (
          <div key={p.id} className="rounded-2xl border border-border bg-card p-5">
            <div className="mb-3 flex items-center gap-3">
              <div className="flex size-10 items-center justify-center rounded-xl bg-primary/[0.09]"><Icon className="size-5 text-primary" aria-hidden /></div>
              <div className="min-w-0 flex-1">
                <p className="text-[15px] font-bold text-foreground">{p.label}</p>
                <p className="text-[12px] text-muted-foreground">{p.summary}</p>
              </div>
              {p.implemented ? <StatusPill status={p.status} /> : <span className="rounded-full border border-border bg-muted px-2.5 py-0.5 text-[12px] font-semibold text-muted-foreground">Unavailable</span>}
            </div>
            <div className="divide-y divide-border/40">
              <Row label="Connection" value={!p.implemented ? 'No transport' : p.configured ? 'Connected' : 'Not connected'} />
              <Row label="Health"     value={p.implemented ? STATUS[p.status].label : 'Unavailable'} />
              <Row label="Authentication" value={!p.implemented ? '—' : p.configured ? 'Credentials present · live probe pending' : 'Not configured'} />
              <Row label="Credits"    value={!p.implemented ? '—' : p.paid ? `₹${(p.pricePaise / 100).toFixed(2)} / message · organizer wallet` : 'Free (platform-absorbed)'} />
              <Row label="Delivery tracking" value={p.deliveryReceipts ? 'Delivered + read receipts' : p.implemented ? 'Accepted only (no receipts)' : '—'} />
              <Row label="Latency / Quota" value="Not measured yet" />
              <Row label="State" value={<span className="font-mono text-[12px]">{p.state}</span>} />
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ─── Health ──────────────────────────────────────────────────────────────────

function HealthTab({ data }: { data: AdminCommunicationOverview }) {
  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2 rounded-xl border border-border bg-card p-4">
        <span className="text-[13px] font-semibold text-foreground">Overall communication health</span>
        <StatusPill status={data.overall} />
      </div>

      {data.health.channels.map(ch => (
        <div key={ch.channel} className="rounded-2xl border border-border bg-card p-5">
          <div className="mb-3 flex items-center justify-between">
            <p className="text-[14px] font-bold text-foreground">{ch.summary}</p>
            <StatusPill status={ch.status} />
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {ch.dimensions.map(d => {
              const s = STATUS[d.status]
              return (
                <div key={d.dimension} className={`rounded-lg border p-3 ${s.cls}`}>
                  <div className="flex items-center gap-1.5">
                    <s.Icon className="size-3.5" aria-hidden />
                    <span className="text-[12px] font-semibold capitalize">{d.dimension}</span>
                  </div>
                  <p className="mt-1 text-[12.5px] text-foreground/90">{d.reason}</p>
                  <p className="mt-0.5 text-[12px] text-muted-foreground">→ {d.recommendedAction}</p>
                </div>
              )
            })}
          </div>
        </div>
      ))}

      <Recommendations data={data} />
    </div>
  )
}

// ─── Notification Catalog (read-only) ────────────────────────────────────────

function ChannelChip({ label, on }: { label: string; on: boolean }) {
  return (
    <span className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${on ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground/40 line-through'}`}>
      {label}
    </span>
  )
}

function NotificationsTab({ entries }: { entries: ResolvedRegistryEntry[] }) {
  const categories = COMM_REGISTRY_CATEGORIES.filter(c => entries.some(e => e.category === c))
  return (
    <div className="space-y-6">
      <p className="text-[13px] text-muted-foreground">
        The canonical registry of every RegisterDesk notification — {entries.length} total. Read-only.
      </p>
      {categories.map(cat => {
        const rows = entries.filter(e => e.category === cat)
        return (
          <div key={cat}>
            <h2 className="mb-2 text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">{cat} · {rows.length}</h2>
            <div className="overflow-x-auto rounded-xl border border-border">
              <table className="w-full min-w-[820px] text-left text-[13px]">
                <thead>
                  <tr className="border-b border-border bg-muted/30">
                    {['Notification', 'Channels', 'Priority', 'Mandatory', 'Enabled', 'Template', 'Future Rule'].map(h => (
                      <th key={h} className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground first:pl-4">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((e, i) => (
                    <tr key={e.id} className={i < rows.length - 1 ? 'border-b border-border/40' : ''}>
                      <td className="px-3 py-2.5 pl-4">
                        <p className="font-medium text-foreground">{e.displayName}</p>
                        <p className="text-[12px] text-muted-foreground">{e.trigger} · {e.audience}</p>
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="flex flex-wrap gap-1">
                          <ChannelChip label="Email" on={e.supports.email} />
                          <ChannelChip label="WhatsApp" on={e.supports.whatsapp} />
                          <ChannelChip label="In-app" on={e.supports.inapp} />
                          <ChannelChip label="SMS" on={e.supports.sms} />
                        </div>
                      </td>
                      <td className="px-3 py-2.5 capitalize text-foreground">{e.priority}</td>
                      <td className="px-3 py-2.5">{e.mandatory
                        ? <span className="rounded-full bg-rose-50 px-2 py-0.5 text-[11px] font-semibold text-rose-700">Mandatory</span>
                        : <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">Optional</span>}</td>
                      <td className="px-3 py-2.5">{e.enabled
                        ? <span className="text-emerald-600">●</span>
                        : <span className="text-muted-foreground/40">○</span>}</td>
                      <td className="px-3 py-2.5 font-mono text-[12px] text-muted-foreground">{e.templateKey}</td>
                      <td className="px-3 py-2.5 font-mono text-[12px] text-muted-foreground/70">{e.futureRuleKey}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ─── Notification Policies (read-only) ───────────────────────────────────────

const PRIORITY_CLS: Record<string, string> = {
  critical:      'bg-rose-50 text-rose-700',
  high:          'bg-amber-50 text-amber-700',
  medium:        'bg-sky-50 text-sky-700',
  low:           'bg-slate-100 text-slate-600',
  informational: 'bg-muted text-muted-foreground',
}
const YesNo = ({ v }: { v: boolean }) => v
  ? <span className="text-emerald-600" title="Yes">●</span>
  : <span className="text-muted-foreground/40" title="No">○</span>

function PoliciesTab({ policies, entries }: { policies: ResolvedNotificationPolicy[]; entries: ResolvedRegistryEntry[] }) {
  const nameOf: Record<string, string> = Object.fromEntries(entries.map(e => [e.id, e.displayName]))
  return (
    <div className="space-y-3">
      <p className="text-[13px] text-muted-foreground">
        How each notification behaves — resolved through the canonical Notification Policy resolver. Read-only.
      </p>
      <div className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full min-w-[1100px] text-left text-[13px]">
          <thead>
            <tr className="border-b border-border bg-muted/30">
              {['Notification', 'Priority', 'Mandatory', 'Delivery', 'Retry', 'Visibility', 'Scheduling', 'Channels', 'Escalation', 'Template', 'Autom.', 'Camp.', 'Workflow'].map(h => (
                <th key={h} className="whitespace-nowrap px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground first:pl-4">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {policies.map((p, i) => (
              <tr key={p.notificationId} className={i < policies.length - 1 ? 'border-b border-border/40' : ''}>
                <td className="px-3 py-2.5 pl-4 font-medium text-foreground">{nameOf[p.notificationId] ?? p.notificationId}</td>
                <td className="px-3 py-2.5"><span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold capitalize ${PRIORITY_CLS[p.priority]}`}>{p.priority}</span></td>
                <td className="px-3 py-2.5"><YesNo v={p.mandatory} /></td>
                <td className="px-3 py-2.5 capitalize text-foreground">{p.deliveryMode}</td>
                <td className="px-3 py-2.5 font-mono text-[12px] text-muted-foreground">{p.retryPolicy}</td>
                <td className="px-3 py-2.5 capitalize text-muted-foreground">{p.visibility}</td>
                <td className="px-3 py-2.5"><YesNo v={p.allowScheduling} /></td>
                <td className="px-3 py-2.5">
                  <div className="flex gap-1">
                    <ChannelChip label="E" on={p.supportsEmail} />
                    <ChannelChip label="W" on={p.supportsWhatsApp} />
                    <ChannelChip label="I" on={p.supportsInApp} />
                    <ChannelChip label="S" on={p.supportsSMS} />
                  </div>
                </td>
                <td className="px-3 py-2.5 text-[12px] text-muted-foreground">{p.escalation.replace(/_/g, ' ')}</td>
                <td className="px-3 py-2.5"><YesNo v={p.requireTemplate} /></td>
                <td className="px-3 py-2.5"><YesNo v={p.futureAutomation} /></td>
                <td className="px-3 py-2.5"><YesNo v={p.futureCampaign} /></td>
                <td className="px-3 py-2.5"><YesNo v={p.futureWorkflow} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[12px] text-muted-foreground">Automation / Campaign / Workflow columns are future-readiness markers — reserved for later phases, not active controls.</p>
    </div>
  )
}

// ─── Communication Playground (read-only QA) ─────────────────────────────────

function PGPreview({ channel, title, vars, values, mobile }: { channel: string; title: string; vars: PlaygroundVariable[]; values: Record<string, string>; mobile: boolean }) {
  const lines = vars.map(v => `${v.label}: ${values[v.id] ?? v.sample}`)
  if (channel === 'whatsapp') return (
    <div className="rounded-xl bg-[#e5ddd5] p-4"><div className="max-w-[85%] rounded-lg rounded-tl-none bg-[#dcf8c6] p-3 shadow-sm"><p className="mb-1.5 text-[13px] font-semibold text-slate-800">{title}</p>{lines.map((l, i) => <p key={i} className="text-[12.5px] text-slate-700">{l}</p>)}</div></div>
  )
  if (channel === 'inapp') return (
    <div className="rounded-xl border border-border bg-card p-3.5"><p className="text-[13px] font-semibold text-foreground">{title}</p>{lines.map((l, i) => <p key={i} className="mt-0.5 text-[12.5px] text-muted-foreground">{l}</p>)}</div>
  )
  return (
    <div className={`mx-auto rounded-xl border border-border bg-white shadow-sm ${mobile ? 'max-w-[320px]' : 'w-full'}`}>
      <div className="border-b border-border px-4 py-2.5"><p className="text-[13px] font-bold text-slate-800">{title}</p></div>
      <div className="space-y-1.5 px-4 py-4">{lines.map((l, i) => <p key={i} className="text-[13px] text-slate-700">{l}</p>)}<p className="pt-2 text-[11px] text-slate-400">RegisterDesk</p></div>
    </div>
  )
}

function PlaygroundTab({ notifications }: { notifications: ResolvedRegistryEntry[] }) {
  const [nid, setNid]       = useState<string>(notifications[0]?.id ?? '')
  const [channel, setChannel] = useState<'email' | 'whatsapp' | 'inapp'>('email')
  const [session, setSession] = useState<PlaygroundSession | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr]       = useState<string | null>(null)
  const [values, setValues] = useState<Record<string, string>>({})
  const [mobile, setMobile] = useState(false)

  useEffect(() => {
    if (!nid) return
    let alive = true
    void (async () => {
      setLoading(true); setErr(null)
      try {
        const u = auth.currentUser
        if (!u) throw new Error('Not authenticated')
        const token = await u.getIdToken()
        const res = await fetch(`/api/admin/communications/playground?notificationId=${encodeURIComponent(nid)}&channel=${channel}`, { headers: { authorization: `Bearer ${token}` }, cache: 'no-store' })
        if (!res.ok) throw new Error(`Request failed (${res.status})`)
        const d = await res.json() as { data: PlaygroundSession }
        if (alive) { setSession(d.data); setValues(Object.fromEntries((d.data.template?.variables ?? []).map(v => [v.id, v.sample]))) }
      } catch (e) { if (alive) setErr(e instanceof Error ? e.message : 'Failed to load') }
      finally { if (alive) setLoading(false) }
    })()
    return () => { alive = false }
  }, [nid, channel])

  const s = session
  return (
    <div className="space-y-4">
      {/* Selectors */}
      <div className="flex flex-wrap items-center gap-2">
        <select value={nid} onChange={e => setNid(e.target.value)} className="h-8 min-w-[220px] rounded-lg border border-border bg-background px-2 text-[13px]">
          {notifications.map(n => <option key={n.id} value={n.id}>{n.displayName}</option>)}
        </select>
        <select value={channel} onChange={e => setChannel(e.target.value as 'email' | 'whatsapp' | 'inapp')} className="h-8 rounded-lg border border-border bg-background px-2 text-[13px]">
          <option value="email">Email</option><option value="whatsapp">WhatsApp</option><option value="inapp">In-app</option>
        </select>
        <span className="text-[12px] text-muted-foreground">Read-only QA — nothing is sent or stored.</span>
      </div>

      {err && <ErrorBanner>{err}</ErrorBanner>}
      {loading ? <div className="flex items-center justify-center py-16 text-muted-foreground"><Loader2 className="size-5 animate-spin" aria-hidden /></div>
      : !s ? null : !s.found ? <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-[13px] text-rose-700">Notification not found in the registry.</div>
      : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {/* Left: validation + variables + policy + projections */}
          <div className="space-y-4">
            {/* Validation */}
            <div className="rounded-xl border border-border bg-card p-4">
              <p className="mb-2 text-[13px] font-semibold text-foreground">Validation</p>
              <div className="space-y-1">
                {s.validation.map(v => (
                  <div key={v.check} className="flex items-start gap-2 text-[12.5px]">
                    <span className={v.ok ? 'text-emerald-600' : 'text-rose-600'}>{v.ok ? '●' : '▲'}</span>
                    <span className="capitalize font-medium text-foreground">{v.check}:</span>
                    <span className="text-muted-foreground">{v.detail}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Variable editor */}
            {s.template && (
              <div className="rounded-xl border border-border bg-card p-4">
                <p className="mb-2 text-[13px] font-semibold text-foreground">Variables</p>
                <div className="space-y-2">
                  {s.template.variables.map(v => (
                    <div key={v.id} className="flex items-center gap-2">
                      <label className="w-40 shrink-0 text-[12px] text-muted-foreground" title={v.label}><span className="font-mono">{v.token}</span></label>
                      <input value={values[v.id] ?? ''} onChange={e => setValues(p => ({ ...p, [v.id]: e.target.value }))} placeholder={v.sample}
                        className={`h-7 flex-1 rounded border px-2 text-[12.5px] outline-none ${v.known ? 'border-border bg-background' : 'border-rose-300 bg-rose-50'}`} />
                      {!v.known && <span className="text-[11px] text-rose-600">unknown</span>}
                    </div>
                  ))}
                  {s.template.variables.length === 0 && <p className="text-[12px] text-muted-foreground">No variables.</p>}
                </div>
              </div>
            )}

            {/* Policy preview */}
            {s.policy && (
              <div className="rounded-xl border border-border bg-card p-4">
                <p className="mb-2 text-[13px] font-semibold text-foreground">Policy</p>
                <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-[12.5px]">
                  <Detail label="Priority" value={s.policy.priority} />
                  <Detail label="Mandatory" value={s.policy.mandatory ? 'Yes' : 'No'} />
                  <Detail label="Delivery" value={s.policy.deliveryMode} />
                  <Detail label="Retry" value={s.policy.retryPolicy} />
                  <Detail label="Escalation" value={s.policy.escalation.replace(/_/g, ' ')} />
                  <Detail label="Scheduling" value={s.policy.allowScheduling ? 'Yes' : 'No'} />
                  <Detail label="Expiry" value={s.policy.expiryPolicy} />
                  <Detail label="Visibility" value={s.policy.visibility} />
                </div>
              </div>
            )}

            {/* Timeline projection */}
            <div className="rounded-xl border border-border bg-card p-4">
              <p className="mb-2 text-[13px] font-semibold text-foreground">Timeline projection</p>
              <div className="flex flex-wrap gap-1.5">
                {s.timelineProjection.map(st => (
                  <span key={st.stage} title={st.note} className={`rounded-full px-2 py-0.5 text-[11px] font-medium capitalize ${st.reachable ? 'bg-emerald-50 text-emerald-700' : 'bg-muted text-muted-foreground/50 line-through'}`}>{st.stage}</span>
                ))}
              </div>
            </div>

            {/* Analytics projection */}
            <div className="rounded-xl border border-border bg-card p-4">
              <p className="mb-2 text-[13px] font-semibold text-foreground">Analytics projection (1 message)</p>
              <div className="flex flex-wrap gap-x-6 gap-y-1 text-[12.5px]">
                <Detail label="Volume" value={String(s.analyticsProjection.volume)} />
                <Detail label="Accepted" value={String(s.analyticsProjection.accepted)} />
                <Detail label="Delivered" value={String(s.analyticsProjection.delivered)} />
                <Detail label="Failed" value={String(s.analyticsProjection.failed)} />
              </div>
            </div>

            {/* Insight projection */}
            <div className="rounded-xl border border-border bg-card p-4">
              <p className="mb-2 text-[13px] font-semibold text-foreground">Insight projection</p>
              {s.insightProjection.length === 0 ? <p className="text-[12.5px] text-emerald-600">No issues projected.</p>
                : <div className="space-y-1">{s.insightProjection.map(i => (
                    <div key={i.insightId} className="flex items-start gap-2 text-[12.5px]"><span className={`rounded px-1.5 text-[10px] font-semibold capitalize ${SEV_CLS[i.severity]}`}>{i.severity}</span><span className="text-foreground">{i.title}</span></div>
                  ))}</div>}
            </div>
          </div>

          {/* Right: preview */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">Preview</p>
              {channel === 'email' && <div className="flex gap-1 rounded-lg border border-border p-0.5">{(['desktop', 'mobile'] as const).map(m => <button key={m} type="button" onClick={() => setMobile(m === 'mobile')} className={`rounded px-2 py-0.5 text-[11px] font-medium capitalize ${(m === 'mobile') === mobile ? 'bg-primary/10 text-primary' : 'text-muted-foreground'}`}>{m}</button>)}</div>}
            </div>
            {s.template ? <PGPreview channel={channel} title={s.registry?.displayName ?? nid} vars={s.template.variables} values={values} mobile={mobile} />
              : <div className="rounded-xl border border-border bg-card px-4 py-10 text-center text-[13px] text-muted-foreground">No template for this channel.</div>}
            <p className="text-[11px] text-muted-foreground">Preview uses your edited values locally. Nothing is sent or persisted.</p>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Campaign Execution Planner (read-only) ──────────────────────────────────

function PlannerTab() {
  const [campaigns, setCampaigns] = useState<ResolvedCampaign[] | null>(null)
  const [cid, setCid]     = useState('')
  const [plan, setPlan]   = useState<ExecutionPlan | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr]     = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const u = auth.currentUser; if (!u) return
        const token = await u.getIdToken()
        const res = await fetch('/api/admin/communications/campaigns', { headers: { authorization: `Bearer ${token}` }, cache: 'no-store' })
        if (res.ok) { const d = await res.json() as { data: ResolvedCampaign[] }; if (alive) { setCampaigns(d.data); if (d.data[0]) setCid(d.data[0].campaignId) } }
        else if (alive) setCampaigns([])
      } catch { if (alive) setCampaigns([]) }
    })()
    return () => { alive = false }
  }, [])

  useEffect(() => {
    if (!cid) return
    let alive = true
    void (async () => {
      setLoading(true); setErr(null)
      try {
        const u = auth.currentUser; if (!u) throw new Error('Not authenticated')
        const token = await u.getIdToken()
        const res = await fetch(`/api/admin/communications/execution-plan?campaignId=${encodeURIComponent(cid)}`, { headers: { authorization: `Bearer ${token}` }, cache: 'no-store' })
        if (!res.ok) throw new Error(`Request failed (${res.status})`)
        const d = await res.json() as { data: ExecutionPlan }
        if (alive) setPlan(d.data)
      } catch (e) { if (alive) setErr(e instanceof Error ? e.message : 'Failed to load') }
      finally { if (alive) setLoading(false) }
    })()
    return () => { alive = false }
  }, [cid])

  const inr = (p: number | null) => p == null ? '—' : `₹${(p / 100).toLocaleString('en-IN')}`
  const n = (v: number | null) => v == null ? '—' : v.toLocaleString('en-IN')
  const p = plan

  return (
    <div className="space-y-4">
      <p className="text-[13px] text-muted-foreground">A deterministic execution plan — projected recipients, channels, batches, cost, and readiness. Read-only: nothing executes, schedules, or queues.</p>
      {campaigns && campaigns.length === 0 ? (
        <div className="rounded-xl border border-border bg-card px-4 py-10 text-center">
          <p className="text-[13px] font-medium text-foreground">No campaigns to plan yet</p>
          <p className="mt-1 text-[12.5px] text-muted-foreground">Campaigns from the (future) Composer will appear here for execution planning. The planner is the read-only foundation.</p>
        </div>
      ) : (
        <>
          <select value={cid} onChange={e => setCid(e.target.value)} className="h-8 min-w-[240px] rounded-lg border border-border bg-background px-2 text-[13px]">
            {(campaigns ?? []).map(c => <option key={c.campaignId} value={c.campaignId}>{c.name}</option>)}
          </select>
          {err && <ErrorBanner>{err}</ErrorBanner>}
          {loading ? <div className="flex items-center justify-center py-16 text-muted-foreground"><Loader2 className="size-5 animate-spin" aria-hidden /></div>
          : !p ? null : (
            <div className="space-y-4">
              {/* Projection tiles */}
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
                <Tile label="Recipients" value={n(p.estimatedRecipients)} sub={p.estimatedRecipients == null ? 'audience not evaluated' : undefined} />
                <Tile label="Messages" value={n(p.estimatedMessages)} />
                <Tile label="Batches" value={n(p.estimatedBatches)} sub={`batch ${p.batchSize}`} />
                <Tile label="Est. cost" value={inr(p.estimatedCostPaise)} sub="worst-case" />
                <Tile label="State" value={p.approvalState} />
              </div>

              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                {/* Audience + channels + providers */}
                <div className="space-y-4">
                  <div className="rounded-xl border border-border bg-card p-4">
                    <p className="mb-2 text-[13px] font-semibold text-foreground">Audience</p>
                    {p.audience ? <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-[12.5px]">
                      <Detail label="Name" value={p.audience.name} /><Detail label="Scope" value={p.audience.scope} />
                      <Detail label="Rules" value={String(p.audience.ruleCount)} /><Detail label="Reach" value={n(p.audience.estimatedReach)} />
                      <Detail label="Health" value={p.audience.health} />
                    </div> : <p className="text-[12.5px] text-muted-foreground">No audience bound to this campaign.</p>}
                  </div>
                  <div className="rounded-xl border border-border bg-card p-4">
                    <p className="mb-2 text-[13px] font-semibold text-foreground">Channels</p>
                    <div className="flex flex-wrap gap-1.5">{p.estimatedChannels.map(c => (
                      <span key={c.channel} title={c.reason} className={`rounded-full px-2 py-0.5 text-[11px] font-medium capitalize ${c.supported ? 'bg-emerald-50 text-emerald-700' : 'bg-muted text-muted-foreground/50 line-through'}`}>{c.channel}</span>
                    ))}</div>
                  </div>
                  <div className="rounded-xl border border-border bg-card p-4">
                    <p className="mb-2 text-[13px] font-semibold text-foreground">Provider readiness</p>
                    {p.providerReadiness.length === 0 ? <p className="text-[12.5px] text-muted-foreground">No channels to plan.</p>
                      : <div className="space-y-1">{p.providerReadiness.map(pr => (
                          <div key={pr.channel} className="flex items-center gap-2 text-[12.5px]"><span className={pr.ready ? 'text-emerald-600' : 'text-amber-500'}>{pr.ready ? '●' : '▲'}</span><span className="font-medium text-foreground capitalize">{pr.channel}</span><span className="text-muted-foreground">{pr.provider} · {pr.state}</span></div>
                        ))}</div>}
                  </div>
                </div>

                {/* Wallet + validation */}
                <div className="space-y-4">
                  <div className="rounded-xl border border-border bg-card p-4">
                    <p className="mb-2 text-[13px] font-semibold text-foreground">Wallet</p>
                    <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-[12.5px]">
                      <Detail label="Balance" value={p.walletReadiness.balancePaise == null ? 'n/a' : inr(p.walletReadiness.balancePaise)} />
                      <Detail label="Est. cost" value={inr(p.walletReadiness.estimatedCostPaise)} />
                      <Detail label="Sufficient" value={p.walletReadiness.sufficient == null ? 'n/a' : p.walletReadiness.sufficient ? 'Yes' : 'No'} />
                    </div>
                    <p className="mt-1.5 text-[11px] text-muted-foreground">{p.walletReadiness.notes}</p>
                  </div>
                  <div className="rounded-xl border border-border bg-card p-4">
                    <p className="mb-2 text-[13px] font-semibold text-foreground">Validation</p>
                    <div className="space-y-1">{p.validation.map(v => (
                      <div key={v.check} className="flex items-start gap-2 text-[12.5px]"><span className={v.ok ? 'text-emerald-600' : 'text-amber-500'}>{v.ok ? '●' : '▲'}</span><span className="capitalize font-medium text-foreground">{v.check}:</span><span className="text-muted-foreground">{v.detail}</span></div>
                    ))}</div>
                  </div>
                </div>
              </div>
              <p className="text-[11px] text-muted-foreground">Deterministic projection — no provider calls, no queue, nothing executed or scheduled.</p>
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ─── Campaign Approval Workflow (read-only) ──────────────────────────────────

function ApprovalTab() {
  const [campaigns, setCampaigns] = useState<ResolvedCampaign[] | null>(null)
  const [cid, setCid]       = useState('')
  const [appr, setAppr]     = useState<ResolvedApproval | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr]       = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const u = auth.currentUser; if (!u) return
        const token = await u.getIdToken()
        const res = await fetch('/api/admin/communications/campaigns', { headers: { authorization: `Bearer ${token}` }, cache: 'no-store' })
        if (res.ok) { const d = await res.json() as { data: ResolvedCampaign[] }; if (alive) { setCampaigns(d.data); if (d.data[0]) setCid(d.data[0].campaignId) } }
        else if (alive) setCampaigns([])
      } catch { if (alive) setCampaigns([]) }
    })()
    return () => { alive = false }
  }, [])

  useEffect(() => {
    if (!cid) return
    let alive = true
    void (async () => {
      setLoading(true); setErr(null)
      try {
        const u = auth.currentUser; if (!u) throw new Error('Not authenticated')
        const token = await u.getIdToken()
        const res = await fetch(`/api/admin/communications/campaign-approval?campaignId=${encodeURIComponent(cid)}`, { headers: { authorization: `Bearer ${token}` }, cache: 'no-store' })
        if (!res.ok) throw new Error(`Request failed (${res.status})`)
        const d = await res.json() as { data: ResolvedApproval }
        if (alive) setAppr(d.data)
      } catch (e) { if (alive) setErr(e instanceof Error ? e.message : 'Failed to load') }
      finally { if (alive) setLoading(false) }
    })()
    return () => { alive = false }
  }, [cid])

  const fmt = (iso: string) => iso ? new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—'

  return (
    <div className="space-y-4">
      <p className="text-[13px] text-muted-foreground">Campaign lifecycle + approval — current state, allowed transitions, and history. Read-only: no transition is performed, nothing is executed or scheduled.</p>
      {campaigns && campaigns.length === 0 ? (
        <div className="rounded-xl border border-border bg-card px-4 py-10 text-center">
          <p className="text-[13px] font-medium text-foreground">No campaigns to review yet</p>
          <p className="mt-1 text-[12.5px] text-muted-foreground">Campaigns created by the (future) Composer will appear here for lifecycle review. The state machine + history model is the read-only foundation.</p>
        </div>
      ) : (
        <>
          <select value={cid} onChange={e => setCid(e.target.value)} className="h-8 min-w-[240px] rounded-lg border border-border bg-background px-2 text-[13px]">
            {(campaigns ?? []).map(c => <option key={c.campaignId} value={c.campaignId}>{c.name}</option>)}
          </select>
          {err && <ErrorBanner>{err}</ErrorBanner>}
          {loading ? <div className="flex items-center justify-center py-16 text-muted-foreground"><Loader2 className="size-5 animate-spin" aria-hidden /></div>
          : !appr ? null : (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <div className="space-y-4">
                {/* Current state + allowed actions */}
                <div className="rounded-xl border border-border bg-card p-4">
                  <div className="flex items-center gap-2">
                    <p className="text-[13px] font-semibold text-foreground">Current state</p>
                    <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${CAMPAIGN_STATUS_CLS[appr.currentState] ?? 'bg-muted text-muted-foreground'}`}>{appr.currentStateLabel}</span>
                    {appr.isTerminal && <span className="text-[11px] text-muted-foreground">(terminal)</span>}
                  </div>
                  <p className="mt-3 mb-1.5 text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">Allowed actions</p>
                  {appr.allowedActions.length === 0 ? <p className="text-[12.5px] text-muted-foreground">No further transitions.</p>
                    : <div className="flex flex-wrap gap-1.5">{appr.allowedActions.map(a => (
                        <span key={a.to} className="inline-flex items-center gap-1 rounded-lg border border-border bg-muted/40 px-2.5 py-1 text-[12px] font-medium text-foreground">{a.action} <span className="text-muted-foreground/60">→ {a.to}</span></span>
                      ))}</div>}
                  <p className="mt-2 text-[11px] text-muted-foreground">Transitions are shown for review only — performing them is a future (execution) phase.</p>
                </div>

                {/* Validation */}
                <div className="rounded-xl border border-border bg-card p-4">
                  <p className="mb-2 text-[13px] font-semibold text-foreground">Validation</p>
                  <div className="space-y-1">{appr.validation.map(v => (
                    <div key={v.check} className="flex items-start gap-2 text-[12.5px]"><span className={v.ok ? 'text-emerald-600' : 'text-amber-500'}>{v.ok ? '●' : '▲'}</span><span className="capitalize font-medium text-foreground">{v.check}:</span><span className="text-muted-foreground">{v.detail}</span></div>
                  ))}</div>
                </div>
              </div>

              {/* History */}
              <div className="rounded-xl border border-border bg-card p-4">
                <p className="mb-2 text-[13px] font-semibold text-foreground">History</p>
                {appr.history.length === 0 ? <p className="text-[12.5px] text-muted-foreground">No history yet.</p>
                  : <div className="space-y-2">{appr.history.map((h, i) => (
                      <div key={i} className="flex items-start gap-2.5 text-[12.5px]">
                        <span className="mt-1 size-1.5 shrink-0 rounded-full bg-primary/50" aria-hidden />
                        <div className="min-w-0">
                          <p className="text-foreground"><span className="font-medium">{h.action}</span> <span className="text-muted-foreground">by {h.actor}</span></p>
                          <p className="text-[11px] text-muted-foreground tabular-nums">{fmt(h.timestamp)}{h.reason ? ` · ${h.reason}` : ''}</p>
                        </div>
                      </div>
                    ))}</div>}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ─── Campaign Composer (read-only) ───────────────────────────────────────────

function ComposerTab({ notifications }: { notifications: ResolvedRegistryEntry[] }) {
  const [nid, setNid]       = useState<string>(notifications[0]?.id ?? '')
  const [channel, setChannel] = useState<'email' | 'whatsapp' | 'inapp'>('email')
  const [audienceId, setAudienceId] = useState('')
  const [name, setName]     = useState('')
  const [audiences, setAudiences] = useState<ResolvedAudience[]>([])
  const [draft, setDraft]   = useState<CampaignDraft | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr]       = useState<string | null>(null)
  const [values, setValues] = useState<Record<string, string>>({})
  const [mobile, setMobile] = useState(false)

  // Audience dropdown (read-only; empty until the Composer creates audiences).
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const u = auth.currentUser; if (!u) return
        const token = await u.getIdToken()
        const res = await fetch('/api/admin/communications/audiences', { headers: { authorization: `Bearer ${token}` }, cache: 'no-store' })
        if (res.ok) { const d = await res.json() as { data: ResolvedAudience[] }; if (alive) setAudiences(d.data) }
      } catch { /* non-fatal */ }
    })()
    return () => { alive = false }
  }, [])

  useEffect(() => {
    if (!nid) return
    let alive = true
    void (async () => {
      setLoading(true); setErr(null)
      try {
        const u = auth.currentUser; if (!u) throw new Error('Not authenticated')
        const token = await u.getIdToken()
        const qs = new URLSearchParams({ notificationId: nid, channel })
        if (audienceId) qs.set('audienceId', audienceId)
        if (name.trim()) qs.set('name', name.trim())
        const res = await fetch(`/api/admin/communications/campaign-composer?${qs.toString()}`, { headers: { authorization: `Bearer ${token}` }, cache: 'no-store' })
        if (!res.ok) throw new Error(`Request failed (${res.status})`)
        const d = await res.json() as { data: CampaignDraft }
        if (alive) { setDraft(d.data); setValues(Object.fromEntries(d.data.variables.map(v => [v.id, v.sample]))) }
      } catch (e) { if (alive) setErr(e instanceof Error ? e.message : 'Failed to load') }
      finally { if (alive) setLoading(false) }
    })()
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nid, channel, audienceId])

  const d = draft
  return (
    <div className="space-y-4">
      {/* Assembly controls */}
      <div className="flex flex-wrap items-center gap-2">
        <input value={name} onChange={e => setName(e.target.value)} placeholder="Campaign name…" className="h-8 w-52 rounded-lg border border-border bg-background px-3 text-[13px] outline-none focus:border-primary/50" />
        <select value={nid} onChange={e => setNid(e.target.value)} className="h-8 min-w-[200px] rounded-lg border border-border bg-background px-2 text-[13px]">
          {notifications.map(n => <option key={n.id} value={n.id}>{n.displayName}</option>)}
        </select>
        <select value={channel} onChange={e => setChannel(e.target.value as 'email' | 'whatsapp' | 'inapp')} className="h-8 rounded-lg border border-border bg-background px-2 text-[13px]">
          <option value="email">Email</option><option value="whatsapp">WhatsApp</option><option value="inapp">In-app</option>
        </select>
        <select value={audienceId} onChange={e => setAudienceId(e.target.value)} className="h-8 rounded-lg border border-border bg-background px-2 text-[13px]">
          <option value="">No audience</option>
          {audiences.map(a => <option key={a.audienceId} value={a.audienceId}>{a.name}</option>)}
        </select>
        <span className="text-[12px] text-muted-foreground">Read-only — nothing is saved, scheduled, or sent.</span>
      </div>

      {err && <ErrorBanner>{err}</ErrorBanner>}
      {loading ? <div className="flex items-center justify-center py-16 text-muted-foreground"><Loader2 className="size-5 animate-spin" aria-hidden /></div>
      : !d ? null : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div className="space-y-4">
            {/* Validation */}
            <div className="rounded-xl border border-border bg-card p-4">
              <p className="mb-2 text-[13px] font-semibold text-foreground">Validation</p>
              <div className="space-y-1">
                {d.validation.map(v => (
                  <div key={v.check} className="flex items-start gap-2 text-[12.5px]"><span className={v.ok ? 'text-emerald-600' : 'text-rose-600'}>{v.ok ? '●' : '▲'}</span><span className="capitalize font-medium text-foreground">{v.check}:</span><span className="text-muted-foreground">{v.detail}</span></div>
                ))}
              </div>
            </div>

            {/* Campaign + notification + audience */}
            <div className="rounded-xl border border-border bg-card p-4">
              <p className="mb-2 text-[13px] font-semibold text-foreground">Campaign</p>
              <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-[12.5px]">
                <Detail label="Name" value={d.campaign.name} />
                <Detail label="Type" value={d.campaign.type} />
                <Detail label="Category" value={d.campaign.category} />
                <Detail label="Notification" value={d.notification?.displayName ?? '—'} />
                <Detail label="Priority" value={d.notification?.priority ?? '—'} />
                <Detail label="Channels" value={(d.notification?.supportedChannels ?? []).join(', ') || '—'} />
                <Detail label="Audience" value={d.audience?.name ?? 'None'} />
                <Detail label="Est. reach" value={d.audience?.estimatedReach != null ? d.audience.estimatedReach.toLocaleString('en-IN') : '—'} />
              </div>
            </div>

            {/* Template */}
            <div className="rounded-xl border border-border bg-card p-4">
              <p className="mb-2 text-[13px] font-semibold text-foreground">Template</p>
              {d.template ? (
                <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-[12.5px]">
                  <Detail label="Template" value={d.template.templateId} />
                  <Detail label="Channel" value={d.template.channel} />
                  <Detail label="Status" value={d.template.status} />
                  <Detail label="Version" value={`v${d.template.version}`} />
                </div>
              ) : <p className="text-[12.5px] text-rose-600">No template for this channel.</p>}
            </div>

            {/* Variable editor */}
            {d.variables.length > 0 && (
              <div className="rounded-xl border border-border bg-card p-4">
                <p className="mb-2 text-[13px] font-semibold text-foreground">Variables</p>
                <div className="space-y-2">
                  {d.variables.map(v => (
                    <div key={v.id} className="flex items-center gap-2">
                      <label className="w-40 shrink-0 font-mono text-[12px] text-muted-foreground">{v.token}</label>
                      <input value={values[v.id] ?? ''} onChange={e => setValues(p => ({ ...p, [v.id]: e.target.value }))} placeholder={v.sample} className={`h-7 flex-1 rounded border px-2 text-[12.5px] outline-none ${v.known ? 'border-border bg-background' : 'border-rose-300 bg-rose-50'}`} />
                      {!v.known && <span className="text-[11px] text-rose-600">unknown</span>}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Policy */}
            {d.policy && (
              <div className="rounded-xl border border-border bg-card p-4">
                <p className="mb-2 text-[13px] font-semibold text-foreground">Policy</p>
                <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-[12.5px]">
                  <Detail label="Priority" value={d.policy.priority} />
                  <Detail label="Mandatory" value={d.policy.mandatory ? 'Yes' : 'No'} />
                  <Detail label="Delivery" value={d.policy.deliveryMode} />
                  <Detail label="Retry" value={d.policy.retryPolicy} />
                  <Detail label="Escalation" value={d.policy.escalation.replace(/_/g, ' ')} />
                  <Detail label="Scheduling" value={d.policy.allowScheduling ? 'Yes' : 'No'} />
                  <Detail label="Expiry" value={d.policy.expiryPolicy} />
                </div>
              </div>
            )}
          </div>

          {/* Preview */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">Preview</p>
              {channel === 'email' && <div className="flex gap-1 rounded-lg border border-border p-0.5">{(['desktop', 'mobile'] as const).map(m => <button key={m} type="button" onClick={() => setMobile(m === 'mobile')} className={`rounded px-2 py-0.5 text-[11px] font-medium capitalize ${(m === 'mobile') === mobile ? 'bg-primary/10 text-primary' : 'text-muted-foreground'}`}>{m}</button>)}</div>}
            </div>
            {d.template ? <PGPreview channel={channel} title={d.notification?.displayName ?? nid} vars={d.variables} values={values} mobile={mobile} />
              : <div className="rounded-xl border border-border bg-card px-4 py-10 text-center text-[13px] text-muted-foreground">No template for this channel.</div>}
            <p className="text-[11px] text-muted-foreground">Preview uses your edited values locally. This is a draft assembly — nothing is persisted or sent.</p>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Audience Builder (read-only) ────────────────────────────────────────────

const AUDIENCE_HEALTH_CLS: Record<string, string> = {
  valid: 'bg-emerald-50 text-emerald-700', warning: 'bg-amber-50 text-amber-700', invalid: 'bg-rose-50 text-rose-700',
}

function AudiencesTab() {
  const [items, setItems]   = useState<ResolvedAudience[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr]       = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    void (async () => {
      setLoading(true); setErr(null)
      try {
        const u = auth.currentUser
        if (!u) throw new Error('Not authenticated')
        const token = await u.getIdToken()
        const res = await fetch('/api/admin/communications/audiences', { headers: { authorization: `Bearer ${token}` }, cache: 'no-store' })
        if (!res.ok) throw new Error(`Request failed (${res.status})`)
        const d = await res.json() as { data: ResolvedAudience[] }
        if (alive) setItems(d.data)
      } catch (e) { if (alive) setErr(e instanceof Error ? e.message : 'Failed to load') }
      finally { if (alive) setLoading(false) }
    })()
    return () => { alive = false }
  }, [])

  const fmt = (iso: string) => iso ? new Date(iso).toLocaleDateString('en-IN', { dateStyle: 'medium' }) : '—'

  return (
    <div className="space-y-3">
      <p className="text-[13px] text-muted-foreground">The canonical registry of platform audiences (saved organizer segments). Read-only — rules are validated, never evaluated against live data here.</p>
      {err && <ErrorBanner>{err}</ErrorBanner>}
      {loading ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground"><Loader2 className="size-5 animate-spin" aria-hidden /></div>
      ) : !items || items.length === 0 ? (
        <div className="rounded-xl border border-border bg-card px-4 py-10 text-center">
          <p className="text-[13px] font-medium text-foreground">No audiences yet</p>
          <p className="mt-1 text-[12.5px] text-muted-foreground">Saved segments will appear here once the Audience Composer (a future phase) creates them. This registry + rule model is the read-only foundation.</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full min-w-[820px] text-left text-[13px]">
            <thead>
              <tr className="border-b border-border bg-muted/30">
                {['Audience', 'Type', 'Scope', 'Rules', 'Estimated Size', 'Health', 'Updated'].map(h => <th key={h} className="whitespace-nowrap px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground first:pl-4">{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {items.map((a, i) => (
                <tr key={a.audienceId} className={i < items.length - 1 ? 'border-b border-border/40' : ''}>
                  <td className="px-3 py-2.5 pl-4 font-medium text-foreground">{a.name}</td>
                  <td className="px-3 py-2.5 text-muted-foreground">{a.typeLabel}</td>
                  <td className="px-3 py-2.5 text-muted-foreground">{a.scopeLabel}</td>
                  <td className="px-3 py-2.5 tabular-nums text-muted-foreground">{a.ruleCount}</td>
                  <td className="px-3 py-2.5 tabular-nums text-muted-foreground">{a.lastEvaluatedAt ? a.estimatedSize.toLocaleString('en-IN') : '—'}</td>
                  <td className="px-3 py-2.5"><span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold capitalize ${AUDIENCE_HEALTH_CLS[a.health]}`} title={a.warnings.map(w => w.detail).join(' · ')}>{a.health}</span></td>
                  <td className="px-3 py-2.5 whitespace-nowrap text-muted-foreground tabular-nums">{fmt(a.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ─── Campaign Registry (read-only) ───────────────────────────────────────────

const CAMPAIGN_STATUS_CLS: Record<string, string> = {
  running: 'bg-emerald-50 text-emerald-700', scheduled: 'bg-sky-50 text-sky-700', approved: 'bg-sky-50 text-sky-700',
  review: 'bg-amber-50 text-amber-700', paused: 'bg-amber-50 text-amber-700', draft: 'bg-muted text-muted-foreground',
  completed: 'bg-muted text-muted-foreground', cancelled: 'bg-rose-50 text-rose-700', archived: 'bg-muted text-muted-foreground',
}

function CampaignsTab() {
  const [items, setItems]   = useState<ResolvedCampaign[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr]       = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    void (async () => {
      setLoading(true); setErr(null)
      try {
        const u = auth.currentUser
        if (!u) throw new Error('Not authenticated')
        const token = await u.getIdToken()
        const res = await fetch('/api/admin/communications/campaigns', { headers: { authorization: `Bearer ${token}` }, cache: 'no-store' })
        if (!res.ok) throw new Error(`Request failed (${res.status})`)
        const d = await res.json() as { data: ResolvedCampaign[] }
        if (alive) setItems(d.data)
      } catch (e) { if (alive) setErr(e instanceof Error ? e.message : 'Failed to load') }
      finally { if (alive) setLoading(false) }
    })()
    return () => { alive = false }
  }, [])

  const fmt = (iso: string) => iso ? new Date(iso).toLocaleDateString('en-IN', { dateStyle: 'medium' }) : '—'

  return (
    <div className="space-y-3">
      <p className="text-[13px] text-muted-foreground">The canonical registry of platform (RegisterDesk → Organizer) campaigns. Read-only — no execution, sending, or scheduling.</p>
      {err && <ErrorBanner>{err}</ErrorBanner>}
      {loading ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground"><Loader2 className="size-5 animate-spin" aria-hidden /></div>
      ) : !items || items.length === 0 ? (
        <div className="rounded-xl border border-border bg-card px-4 py-10 text-center">
          <p className="text-[13px] font-medium text-foreground">No campaigns yet</p>
          <p className="mt-1 text-[12.5px] text-muted-foreground">Platform campaigns will appear here once the Campaign Composer (a future phase) creates them. This registry is the read-only foundation.</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full min-w-[960px] text-left text-[13px]">
            <thead>
              <tr className="border-b border-border bg-muted/30">
                {['Name', 'Type', 'Category', 'Status', 'Notification', 'Template', 'Audience', 'Priority', 'Created', 'Updated'].map(h => <th key={h} className="whitespace-nowrap px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground first:pl-4">{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {items.map((c, i) => (
                <tr key={c.campaignId} className={i < items.length - 1 ? 'border-b border-border/40' : ''}>
                  <td className="px-3 py-2.5 pl-4 font-medium text-foreground">{c.name}</td>
                  <td className="px-3 py-2.5 text-muted-foreground">{c.typeLabel}</td>
                  <td className="px-3 py-2.5 text-muted-foreground">{c.categoryLabel}</td>
                  <td className="px-3 py-2.5"><span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${CAMPAIGN_STATUS_CLS[c.status] ?? 'bg-muted text-muted-foreground'}`}>{c.statusLabel}</span></td>
                  <td className="px-3 py-2.5 font-mono text-[11px] text-muted-foreground/70">{c.notificationId ?? '—'}</td>
                  <td className="px-3 py-2.5 font-mono text-[11px] text-muted-foreground/70">{c.templateId ?? '—'}</td>
                  <td className="px-3 py-2.5 font-mono text-[11px] text-muted-foreground/70">{c.audienceId ?? '—'}</td>
                  <td className="px-3 py-2.5 capitalize text-muted-foreground">{c.priority}</td>
                  <td className="px-3 py-2.5 whitespace-nowrap text-muted-foreground tabular-nums">{fmt(c.createdAt)}</td>
                  <td className="px-3 py-2.5 whitespace-nowrap text-muted-foreground tabular-nums">{fmt(c.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ─── Communication Insights (read-only) ──────────────────────────────────────

const SEV_CLS: Record<string, string> = {
  critical: 'bg-rose-100 text-rose-700', high: 'bg-rose-50 text-rose-700',
  medium: 'bg-amber-50 text-amber-700', low: 'bg-sky-50 text-sky-700',
  informational: 'bg-muted text-muted-foreground',
}
const INSIGHT_CATEGORIES: InsightCategory[] = ['configuration', 'templates', 'providers', 'notifications', 'delivery', 'health', 'performance', 'compliance', 'security', 'recommendation']
const INSIGHT_SEVERITIES: InsightSeverity[] = ['critical', 'high', 'medium', 'low', 'informational']

function InsightsTab() {
  const [items, setItems]   = useState<CommunicationInsight[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr]       = useState<string | null>(null)
  const [severity, setSeverity] = useState<InsightSeverity | ''>('')
  const [category, setCategory] = useState<InsightCategory | ''>('')
  const [openId, setOpenId] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    void (async () => {
      setLoading(true); setErr(null)
      try {
        const u = auth.currentUser
        if (!u) throw new Error('Not authenticated')
        const token = await u.getIdToken()
        const qs = new URLSearchParams()
        if (severity) qs.set('severity', severity)
        if (category) qs.set('category', category)
        const res = await fetch(`/api/admin/communications/insights?${qs.toString()}`, { headers: { authorization: `Bearer ${token}` }, cache: 'no-store' })
        if (!res.ok) throw new Error(`Request failed (${res.status})`)
        const d = await res.json() as { data: CommunicationInsight[] }
        if (alive) setItems(d.data)
      } catch (e) { if (alive) setErr(e instanceof Error ? e.message : 'Failed to load') }
      finally { if (alive) setLoading(false) }
    })()
    return () => { alive = false }
  }, [severity, category])

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <select value={severity} onChange={e => setSeverity(e.target.value as InsightSeverity | '')} className="h-8 rounded-lg border border-border bg-background px-2 text-[13px] capitalize">
          <option value="">All severities</option>
          {INSIGHT_SEVERITIES.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={category} onChange={e => setCategory(e.target.value as InsightCategory | '')} className="h-8 rounded-lg border border-border bg-background px-2 text-[13px] capitalize">
          <option value="">All categories</option>
          {INSIGHT_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        {items && <span className="text-[12px] text-muted-foreground">{items.length} insight(s)</span>}
      </div>

      {err && <ErrorBanner>{err}</ErrorBanner>}
      {loading ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground"><Loader2 className="size-5 animate-spin" aria-hidden /></div>
      ) : !items || items.length === 0 ? (
        <div className="flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-[13px] text-emerald-700"><ShieldCheck className="size-4" aria-hidden /> No insights — nothing needs attention right now.</div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full min-w-[900px] text-left text-[13px]">
            <thead>
              <tr className="border-b border-border bg-muted/30">
                {['Severity', 'Category', 'Title', 'Recommendation', 'Related', 'Status', ''].map(h => <th key={h} className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground first:pl-4">{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {items.map(ins => {
                const related = ins.relatedProvider ?? ins.relatedChannel ?? ins.relatedNotification ?? ins.relatedTemplate ?? '—'
                const open = openId === ins.insightId
                return (
                  <Fragment key={ins.insightId}>
                    <tr onClick={() => setOpenId(open ? null : ins.insightId)} className="cursor-pointer border-b border-border/40 transition-colors hover:bg-muted/40">
                      <td className="px-3 py-2.5 pl-4"><span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold capitalize ${SEV_CLS[ins.severity]}`}>{ins.severity}</span></td>
                      <td className="px-3 py-2.5 capitalize text-muted-foreground">{ins.category}</td>
                      <td className="px-3 py-2.5 font-medium text-foreground">{ins.title}</td>
                      <td className="px-3 py-2.5"><span className="line-clamp-1 max-w-[240px] text-muted-foreground">{ins.recommendation}</span></td>
                      <td className="px-3 py-2.5 font-mono text-[11px] text-muted-foreground/70">{related}</td>
                      <td className="px-3 py-2.5 capitalize text-muted-foreground">{ins.status}</td>
                      <td className="px-3 py-2.5 text-muted-foreground/60">{open ? '▾' : '▸'}</td>
                    </tr>
                    {open && (
                      <tr className="border-b border-border/40 bg-muted/20">
                        <td colSpan={7} className="px-4 py-3">
                          <p className="text-[13px] text-foreground">{ins.description}</p>
                          <p className="mt-1 text-[13px] text-muted-foreground"><span className="font-medium text-foreground/70">Recommendation:</span> {ins.recommendation}</p>
                          <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-[12px] text-muted-foreground">
                            {Object.entries(ins.metadata).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => <span key={k}><span className="font-medium text-foreground/70">{k}:</span> {String(v)}</span>)}
                            <span><span className="font-medium text-foreground/70">generated:</span> {new Date(ins.generatedAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}</span>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-[11px] text-muted-foreground">Insights derive from Analytics → Timeline (read-only). No fabricated insights; every item reflects a real condition.</p>
    </div>
  )
}

// ─── Communication Analytics (read-only, tables only) ────────────────────────

const pct = (n: number) => `${(n * 100).toFixed(1)}%`
const lat = (m: number | null) => m != null ? `${m} ms` : '—'

function MetricsCells({ m }: { m: CommMetrics }) {
  return (
    <>
      <td className="px-3 py-2 tabular-nums text-foreground">{m.volume.toLocaleString('en-IN')}</td>
      <td className="px-3 py-2 tabular-nums text-emerald-600">{m.accepted.toLocaleString('en-IN')}</td>
      <td className="px-3 py-2 tabular-nums text-muted-foreground">{m.delivered.toLocaleString('en-IN')}</td>
      <td className="px-3 py-2 tabular-nums text-rose-600">{m.failed.toLocaleString('en-IN')}</td>
      <td className="px-3 py-2 tabular-nums text-muted-foreground">{lat(m.avgLatencyMs)}</td>
    </>
  )
}
const METRIC_HEADS = ['Volume', 'Accepted', 'Delivered', 'Failed', 'Avg latency']

function ATable({ title, firstHead, rows }: { title: string; firstHead: string; rows: { key: string; label: React.ReactNode; m: CommMetrics; extra?: React.ReactNode }[] }) {
  return (
    <div>
      <h2 className="mb-2 text-[13px] font-semibold text-foreground">{title}</h2>
      <div className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full min-w-[640px] text-left text-[13px]">
          <thead>
            <tr className="border-b border-border bg-muted/30">
              <th className="px-3 py-2 pl-4 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{firstHead}</th>
              {METRIC_HEADS.map(h => <th key={h} className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={6} className="px-4 py-6 text-center text-muted-foreground">No data yet.</td></tr>
            ) : rows.map((r, i) => (
              <tr key={r.key} className={i < rows.length - 1 ? 'border-b border-border/40' : ''}>
                <td className="px-3 py-2 pl-4 font-medium text-foreground">{r.label}{r.extra}</td>
                <MetricsCells m={r.m} />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function AnalyticsTab() {
  const [a, setA]           = useState<CommunicationAnalytics | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr]       = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    void (async () => {
      setLoading(true); setErr(null)
      try {
        const u = auth.currentUser
        if (!u) throw new Error('Not authenticated')
        const token = await u.getIdToken()
        const res = await fetch('/api/admin/communications/analytics', { headers: { authorization: `Bearer ${token}` }, cache: 'no-store' })
        if (!res.ok) throw new Error(`Request failed (${res.status})`)
        const d = await res.json() as { data: CommunicationAnalytics }
        if (alive) setA(d.data)
      } catch (e) { if (alive) setErr(e instanceof Error ? e.message : 'Failed to load') }
      finally { if (alive) setLoading(false) }
    })()
    return () => { alive = false }
  }, [])

  if (loading) return <div className="flex items-center justify-center py-16 text-muted-foreground"><Loader2 className="size-5 animate-spin" aria-hidden /></div>
  if (err) return <ErrorBanner>{err}</ErrorBanner>
  if (!a) return null

  return (
    <div className="space-y-6">
      <p className="text-[13px] text-muted-foreground">Aggregated from the last {a.scanned.toLocaleString('en-IN')} timeline entries — the operational source of truth. Read-only, no charts.</p>

      {/* Overview + Health summary */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Tile label="Volume"       value={a.overall.volume.toLocaleString('en-IN')} />
        <Tile label="Accepted"     value={a.overall.accepted.toLocaleString('en-IN')} />
        <Tile label="Delivered"    value={a.overall.delivered.toLocaleString('en-IN')} sub="WhatsApp only" />
        <Tile label="Failed"       value={a.overall.failed.toLocaleString('en-IN')} />
        <Tile label="Success rate" value={pct(a.overall.successRate)} />
        <Tile label="Failure rate" value={pct(a.overall.failureRate)} />
      </div>

      {/* Provider summary (with availability + errors) */}
      <div>
        <h2 className="mb-2 text-[13px] font-semibold text-foreground">Provider summary</h2>
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full min-w-[720px] text-left text-[13px]">
            <thead>
              <tr className="border-b border-border bg-muted/30">
                {['Provider', ...METRIC_HEADS, 'Availability', 'Top error'].map(h => <th key={h} className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground first:pl-4">{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {a.byProvider.length === 0 ? <tr><td colSpan={8} className="px-4 py-6 text-center text-muted-foreground">No data yet.</td></tr>
                : a.byProvider.map((p, i) => (
                <tr key={p.provider} className={i < a.byProvider.length - 1 ? 'border-b border-border/40' : ''}>
                  <td className="px-3 py-2 pl-4 font-medium text-foreground">{p.provider}{!p.implemented && <span className="ml-1.5 text-[11px] text-muted-foreground/60">(unknown)</span>}</td>
                  <MetricsCells m={p.metrics} />
                  <td className="px-3 py-2 tabular-nums text-foreground">{pct(p.availability)}</td>
                  <td className="px-3 py-2 font-mono text-[12px] text-muted-foreground">{p.errorDistribution[0] ? `${p.errorDistribution[0].code} (${p.errorDistribution[0].count})` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <ATable title="Channel summary" firstHead="Channel" rows={a.byChannel.map(c => ({ key: c.key, label: c.label, m: c.metrics }))} />
      <ATable title="Category summary" firstHead="Category" rows={a.byCategory.map(c => ({ key: c.key, label: <span className="capitalize">{c.label}</span>, m: c.metrics }))} />
      <ATable title="Notification summary" firstHead="Notification" rows={a.byNotification.map(n => ({ key: n.notificationId, label: n.displayName, m: n.metrics }))} />
      <ATable title="Template summary" firstHead="Template" rows={a.byTemplate.map(t => ({ key: t.templateId, label: <span className="font-mono text-[12px]">{t.templateId}</span>, m: t.metrics }))} />

      <p className="text-[11px] text-muted-foreground">&quot;Accepted&quot; = provider-accepted; email delivery/open tracking is not yet wired, so Delivered reflects WhatsApp receipts. Analytics reads the timeline, never providers directly.</p>
    </div>
  )
}

// ─── Communication Timeline (read-only) ──────────────────────────────────────

const TL_STATUS_CLS: Record<string, string> = {
  delivered: 'bg-emerald-50 text-emerald-700', opened: 'bg-emerald-50 text-emerald-700',
  sent: 'bg-sky-50 text-sky-700', queued: 'bg-amber-50 text-amber-700',
  failed: 'bg-rose-50 text-rose-700', cancelled: 'bg-muted text-muted-foreground',
}

function TimelineTab() {
  const [result, setResult]   = useState<TimelineResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr]         = useState<string | null>(null)
  const [status, setStatus]   = useState<TimelineStatus | ''>('')
  const [channel, setChannel] = useState<'' | 'email' | 'whatsapp'>('')
  const [search, setSearch]   = useState('')
  const [applied, setApplied] = useState(0)   // bump to re-fetch
  const [openId, setOpenId]   = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    void (async () => {
      setLoading(true); setErr(null)
      try {
        const u = auth.currentUser
        if (!u) throw new Error('Not authenticated')
        const token = await u.getIdToken()
        const qs = new URLSearchParams()
        if (status) qs.set('status', status)
        if (channel) qs.set('channel', channel)
        if (search.trim()) qs.set('search', search.trim())
        const res = await fetch(`/api/admin/communications/timeline?${qs.toString()}`, { headers: { authorization: `Bearer ${token}` }, cache: 'no-store' })
        if (!res.ok) throw new Error(`Request failed (${res.status})`)
        const d = await res.json() as { data: TimelineResult }
        if (alive) setResult(d.data)
      } catch (e) { if (alive) setErr(e instanceof Error ? e.message : 'Failed to load') }
      finally { if (alive) setLoading(false) }
    })()
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, channel, applied])

  const fmtTime = (iso?: string) => iso ? new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—'

  return (
    <div className="space-y-3">
      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <input value={search} onChange={e => setSearch(e.target.value)} onKeyDown={e => e.key === 'Enter' && setApplied(a => a + 1)}
          placeholder="Search recipient / subject / event…" className="h-8 w-56 rounded-lg border border-border bg-background px-3 text-[13px] outline-none focus:border-primary/50" />
        <select value={status} onChange={e => setStatus(e.target.value as TimelineStatus | '')} className="h-8 rounded-lg border border-border bg-background px-2 text-[13px]">
          <option value="">All statuses</option>
          {Object.entries(TIMELINE_STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <select value={channel} onChange={e => setChannel(e.target.value as '' | 'email' | 'whatsapp')} className="h-8 rounded-lg border border-border bg-background px-2 text-[13px]">
          <option value="">All channels</option>
          <option value="email">Email</option>
          <option value="whatsapp">WhatsApp</option>
        </select>
        <button type="button" onClick={() => setApplied(a => a + 1)} className="h-8 rounded-lg border border-border px-3 text-[13px] font-medium hover:bg-muted">Search</button>
        {result && <span className="text-[12px] text-muted-foreground">{result.count} of {result.scanned} scanned</span>}
      </div>

      {err && <ErrorBanner>{err}</ErrorBanner>}
      {loading ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground"><Loader2 className="size-5 animate-spin" aria-hidden /></div>
      ) : !result || result.entries.length === 0 ? (
        <div className="rounded-xl border border-border bg-card px-4 py-10 text-center text-[13px] text-muted-foreground">No communications match these filters.</div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full min-w-[880px] text-left text-[13px]">
            <thead>
              <tr className="border-b border-border bg-muted/30">
                {['Time', 'Notification', 'Recipient', 'Channel', 'Provider', 'Status', 'Latency', 'Retry', ''].map(h => (
                  <th key={h} className="whitespace-nowrap px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground first:pl-4">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.entries.map(e => (
                <TimelineRow key={e.timelineId} e={e} open={openId === e.timelineId} onToggle={() => setOpenId(openId === e.timelineId ? null : e.timelineId)} fmtTime={fmtTime} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-[11px] text-muted-foreground">Read-only historical record. No replay, resend, or retry. &quot;Sent&quot; = provider-accepted; email delivery/open tracking is not yet wired.</p>
    </div>
  )
}

function TimelineRow({ e, open, onToggle, fmtTime }: { e: TimelineEntry; open: boolean; onToggle: () => void; fmtTime: (s?: string) => string }) {
  return (
    <>
      <tr onClick={onToggle} className="cursor-pointer border-b border-border/40 transition-colors hover:bg-muted/40">
        <td className="whitespace-nowrap px-3 py-2.5 pl-4 text-muted-foreground tabular-nums">{fmtTime(e.queuedAt)}</td>
        <td className="px-3 py-2.5 font-medium text-foreground">{e.notificationId ?? e.templateId}</td>
        <td className="px-3 py-2.5"><span className="line-clamp-1 max-w-[180px] text-muted-foreground">{e.recipient}</span></td>
        <td className="px-3 py-2.5"><ChannelChip label={e.channel} on /></td>
        <td className="px-3 py-2.5 text-muted-foreground">{e.provider}</td>
        <td className="px-3 py-2.5"><span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${TL_STATUS_CLS[e.status] ?? 'bg-muted text-muted-foreground'}`}>{TIMELINE_STATUS_LABELS[e.status]}</span></td>
        <td className="px-3 py-2.5 tabular-nums text-muted-foreground">{e.latencyMs != null ? `${e.latencyMs} ms` : '—'}</td>
        <td className="px-3 py-2.5 tabular-nums text-muted-foreground">{e.retryCount}</td>
        <td className="px-3 py-2.5 text-muted-foreground/60">{open ? '▾' : '▸'}</td>
      </tr>
      {open && (
        <tr className="border-b border-border/40 bg-muted/20">
          <td colSpan={9} className="px-4 py-3">
            <div className="grid grid-cols-2 gap-x-8 gap-y-1.5 text-[12.5px] sm:grid-cols-3">
              <Detail label="Notification" value={e.notificationId ?? '—'} />
              <Detail label="Policy" value={e.policyId ?? '—'} />
              <Detail label="Template" value={`${e.templateId} · v${e.templateVersion}`} />
              <Detail label="Trigger" value={e.trigger} />
              <Detail label="Recipient type" value={e.recipientType} />
              <Detail label="Provider reference" value={e.providerReference ?? '—'} />
              <Detail label="Queued" value={fmtTime(e.queuedAt)} />
              <Detail label="Sent" value={fmtTime(e.sentAt)} />
              <Detail label="Delivered" value={fmtTime(e.deliveredAt)} />
              <Detail label="Opened" value={fmtTime(e.openedAt)} />
              <Detail label="Failed" value={fmtTime(e.failedAt)} />
              <Detail label="Completed" value={fmtTime(e.completedAt)} />
              {e.errorCode && <Detail label="Error code" value={e.errorCode} />}
              {e.errorMessage && <Detail label="Error" value={e.errorMessage} />}
            </div>
            <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-[12px] text-muted-foreground">
              {Object.entries(e.metadata).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => (
                <span key={k}><span className="font-medium text-foreground/70">{k}:</span> {String(v)}</span>
              ))}
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

function Detail({ label, value }: { label: string; value: string }) {
  return <div><span className="text-muted-foreground">{label}: </span><span className="font-medium text-foreground">{value}</span></div>
}

// ─── Platform Templates (read-only) ──────────────────────────────────────────

type TView = NonNullable<TemplateCenterView>
type TItem = TView['templates'][number]

function TemplatesTab({ view }: { view: TView }) {
  const { templates, variables } = view
  const [selectedId, setSelectedId] = useState<string>(templates[0]?.templateId ?? '')
  const [mobile, setMobile] = useState(false)
  const sample: Record<string, { label: string; example: string }> =
    Object.fromEntries(variables.map(v => [v.id, { label: v.label, example: v.example }]))
  const selected = templates.find(t => t.templateId === selectedId) ?? templates[0]

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
      {/* List */}
      <div className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full min-w-[640px] text-left text-[13px]">
          <thead>
            <tr className="border-b border-border bg-muted/30">
              {['Notification', 'Channel', 'Ver', 'Status', 'Vars', 'Health', 'Binding'].map(h => (
                <th key={h} className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground first:pl-4">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {templates.map((t, i) => (
              <tr
                key={t.templateId}
                onClick={() => setSelectedId(t.templateId)}
                className={`cursor-pointer transition-colors hover:bg-muted/40 ${t.templateId === selected?.templateId ? 'bg-primary/[0.04]' : ''} ${i < templates.length - 1 ? 'border-b border-border/40' : ''}`}
              >
                <td className="px-3 py-2.5 pl-4 font-medium text-foreground">{t.displayName}</td>
                <td className="px-3 py-2.5"><ChannelChip label={t.channel} on /></td>
                <td className="px-3 py-2.5 tabular-nums text-muted-foreground">v{t.version}</td>
                <td className="px-3 py-2.5"><span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold capitalize text-emerald-700">{t.status}</span></td>
                <td className="px-3 py-2.5 tabular-nums text-muted-foreground">{t.variables.length}</td>
                <td className="px-3 py-2.5">{t.health.healthy
                  ? <span className="text-emerald-600" title="Healthy">●</span>
                  : <span className="text-amber-500" title={t.health.unknownVariables.length ? 'Unknown variables' : 'Not healthy'}>▲</span>}</td>
                <td className="px-3 py-2.5 font-mono text-[11px] text-muted-foreground/70">{t.notificationId}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Preview */}
      {selected && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">Preview · sample values</p>
            {selected.channel === 'email' && (
              <div className="flex gap-1 rounded-lg border border-border p-0.5">
                {(['desktop', 'mobile'] as const).map(m => (
                  <button key={m} type="button" onClick={() => setMobile(m === 'mobile')}
                    className={`rounded px-2 py-0.5 text-[11px] font-medium capitalize ${(m === 'mobile') === mobile ? 'bg-primary/10 text-primary' : 'text-muted-foreground'}`}>{m}</button>
                ))}
              </div>
            )}
          </div>
          <TemplatePreview t={selected} sample={sample} mobile={mobile} />
          <div className="rounded-xl border border-border bg-card p-3">
            <p className="mb-1.5 text-[12px] font-semibold text-foreground">Variables ({selected.variables.length})</p>
            <div className="space-y-1">
              {selected.variables.map(id => (
                <div key={id} className="flex items-center justify-between gap-2 text-[12px]">
                  <span className="font-mono text-muted-foreground">{`{{${id}}}`}</span>
                  <span className="truncate text-foreground">{sample[id]?.example ?? '—'}</span>
                </div>
              ))}
            </div>
            {selected.health.unknownVariables.length > 0 && (
              <p className="mt-2 text-[12px] text-amber-600">Unknown variables: {selected.health.unknownVariables.join(', ')}</p>
            )}
          </div>
          <p className="text-[11px] text-muted-foreground">Read-only preview with sample values. Production rendering happens in the send path (unchanged).</p>
        </div>
      )}
    </div>
  )
}

function TemplatePreview({ t, sample, mobile }: { t: TItem; sample: Record<string, { label: string; example: string }>; mobile: boolean }) {
  const lines = t.variables.map(id => `${sample[id]?.label ?? id}: ${sample[id]?.example ?? '—'}`)
  if (t.channel === 'whatsapp') {
    return (
      <div className="rounded-xl bg-[#e5ddd5] p-4">
        <div className="max-w-[85%] rounded-lg rounded-tl-none bg-[#dcf8c6] p-3 shadow-sm">
          <p className="mb-1.5 text-[13px] font-semibold text-slate-800">{t.displayName}</p>
          {lines.map((l, i) => <p key={i} className="text-[12.5px] text-slate-700">{l}</p>)}
        </div>
      </div>
    )
  }
  if (t.channel === 'inapp') {
    return (
      <div className="rounded-xl border border-border bg-card p-3.5">
        <p className="text-[13px] font-semibold text-foreground">{t.displayName}</p>
        {lines.map((l, i) => <p key={i} className="mt-0.5 text-[12.5px] text-muted-foreground">{l}</p>)}
      </div>
    )
  }
  // email
  return (
    <div className={`mx-auto rounded-xl border border-border bg-white shadow-sm ${mobile ? 'max-w-[320px]' : 'w-full'}`}>
      <div className="border-b border-border px-4 py-2.5"><p className="text-[13px] font-bold text-slate-800">{t.displayName}</p></div>
      <div className="space-y-1.5 px-4 py-4">
        {lines.map((l, i) => <p key={i} className="text-[13px] text-slate-700">{l}</p>)}
        <p className="pt-2 text-[11px] text-slate-400">RegisterDesk</p>
      </div>
    </div>
  )
}

// ─── Recommendations ─────────────────────────────────────────────────────────

function Recommendations({ data }: { data: AdminCommunicationOverview }) {
  if (data.recommendations.length === 0) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-[13px] text-emerald-700">
        <ShieldCheck className="size-4" aria-hidden /> No action required — all live channels are healthy.
      </div>
    )
  }
  return (
    <div>
      <h2 className="mb-2 flex items-center gap-1.5 text-[13px] font-semibold text-foreground"><Wrench className="size-3.5" aria-hidden /> Recommendations</h2>
      <div className="space-y-2">
        {data.recommendations.map((r, i) => {
          const Icon = r.severity === 'red' ? ShieldAlert : ShieldQuestion
          const cls = r.severity === 'red' ? 'border-rose-200 bg-rose-50 text-rose-700' : 'border-amber-200 bg-amber-50 text-amber-700'
          return (
            <div key={i} className={`flex items-start gap-2.5 rounded-lg border px-4 py-2.5 ${cls}`}>
              <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
              <div className="min-w-0">
                <p className="text-[13px] font-semibold">{r.title}</p>
                <p className="text-[12.5px] opacity-90">{r.action}</p>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
