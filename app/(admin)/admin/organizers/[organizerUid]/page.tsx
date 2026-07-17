'use client'

// Enterprise Organizer 360 Console (GA-2 S2).
// The single admin command center for ONE organizer. Four logical workspaces
// (Overview / Operations / Business / Governance) over a permanent Health Panel.
// Purely additive + READ-first: every read hits a thin admin endpoint that reuses
// existing services; every MUTATION reuses an EXISTING admin route
// (PATCH /api/admin/organizers/[uid], …/plan). Overview loads first; the other
// workspaces load lazily on first open.

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { auth } from '@/lib/firebase/auth'
import { cn } from '@/lib/utils/cn'
import {
  Loader2, ArrowLeft, ExternalLink, RefreshCw, Building2, Mail, Phone, Users,
  IndianRupee, KeyRound, ShieldCheck, ShieldOff, Ban, PlayCircle, BadgeCheck,
  CalendarDays, Ticket, Award, Send, Activity, ScrollText, Gift, Wallet,
  UserCog, SlidersHorizontal, Fingerprint, LayoutGrid,
} from 'lucide-react'
import { StatusPill, ErrorBanner } from '@/components/admin'
import type { PillTone } from '@/components/admin'
import { useConfirm } from '@/components/ui/ConfirmDialog'
import { HBars } from '@/components/analytics/Charts'
import { EVENT_LICENSE_TIERS, type EventLicenseTier } from '@/lib/licensing/eventLicense'
import type {
  Organizer360Overview, Organizer360Response, Organizer360Operations,
  Organizer360Business, Organizer360Governance, Organizer360Timeline,
  Organizer360TimelineEntry, HealthIndicator, HealthLevel,
} from '@/lib/admin/organizer360Types'

// ─── Utilities ──────────────────────────────────────────────────────────────

async function getToken(): Promise<string> {
  const u = auth.currentUser
  if (!u) throw new Error('Not authenticated')
  return u.getIdToken()
}
async function authedGet<T>(url: string): Promise<T> {
  const token = await getToken()
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` }, cache: 'no-store' })
  if (!res.ok) {
    const b = await res.json().catch(() => null) as { error?: string } | null
    throw new Error(b?.error ?? `Request failed (${res.status})`)
  }
  return await res.json() as T
}

const rupees = (p: number): string => `₹${(p / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`
const num = (n: number): string => n.toLocaleString('en-IN')
const fmtDate = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'
const fmtDay = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—'

const HEALTH_DOT: Record<HealthLevel, string> = {
  green: 'bg-emerald-500', yellow: 'bg-amber-500', red: 'bg-red-500', neutral: 'bg-muted-foreground/40',
}

type TabKey = 'overview' | 'operations' | 'business' | 'governance'
const TABS: { key: TabKey; label: string }[] = [
  { key: 'overview',   label: 'Overview' },
  { key: 'operations', label: 'Operations' },
  { key: 'business',   label: 'Business' },
  { key: 'governance', label: 'Governance' },
]

// ─── Page ───────────────────────────────────────────────────────────────────

export default function Organizer360Page() {
  const { organizerUid } = useParams<{ organizerUid: string }>()
  const [tab, setTab] = useState<TabKey>('overview')

  const [overview, setOverview] = useState<Organizer360Overview | null>(null)
  const [overviewErr, setOverviewErr] = useState<string | null>(null)
  const [health, setHealth] = useState<HealthIndicator[]>([])
  const [ovReloadKey, setOvReloadKey] = useState(0)

  // Overview (backbone) — loads first + on reload bumps.
  useEffect(() => {
    if (!organizerUid) return
    let alive = true
    void (async () => {
      try {
        const d = await authedGet<Organizer360Response>(`/api/admin/organizers/${organizerUid}/360`)
        if (!alive) return
        setOverviewErr(null); setOverview(d.overview); setHealth(prev => mergeHealth(d.overview.health, prev))
      } catch (e) {
        if (alive) setOverviewErr(e instanceof Error ? e.message : 'Failed to load organizer')
      }
    })()
    return () => { alive = false }
  }, [organizerUid, ovReloadKey])

  const refreshOverview = useCallback(() => setOvReloadKey(k => k + 1), [])

  // Operations — lazy, fed back into health (communications + jobs).
  const [operations, setOperations] = useState<Organizer360Operations | null>(null)
  const [operationsErr, setOperationsErr] = useState<string | null>(null)
  useEffect(() => {
    if (!organizerUid || tab !== 'operations' || operations) return
    let alive = true
    void (async () => {
      try {
        const d = await authedGet<Organizer360Operations>(`/api/admin/organizers/${organizerUid}/operations`)
        if (!alive) return
        setOperationsErr(null); setOperations(d); setHealth(prev => upgradeHealth(prev, d))
      } catch (e) {
        if (alive) setOperationsErr(e instanceof Error ? e.message : 'Failed to load operations')
      }
    })()
    return () => { alive = false }
  }, [organizerUid, tab, operations])
  const operationsLoading = !operations && !operationsErr

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link href="/admin/organizers" className="mb-1 inline-flex items-center gap-1.5 text-[12.5px] font-medium text-muted-foreground transition-colors hover:text-foreground">
            <ArrowLeft className="size-3.5" /> Organizers
          </Link>
          <h1 className="text-[20px] font-bold tracking-tight text-foreground">
            {overview?.profile.name || overview?.profile.organizationName || (overviewErr ? 'Organizer' : 'Loading…')}
          </h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[12.5px] text-muted-foreground">
            <span className="font-mono">{organizerUid}</span>
            {overview && <StatusPill tone={overview.account.status === 'active' ? 'success' : overview.account.status === 'suspended' ? 'warning' : 'danger'}>{overview.account.status}</StatusPill>}
            {overview && <StatusPill tone="neutral">{overview.entitlements.effectiveTier}</StatusPill>}
            {overview?.entitlements.source === 'admin_override' && <StatusPill tone="info">override</StatusPill>}
          </div>
        </div>
        <button onClick={refreshOverview} className={btnOutline}><RefreshCw className="size-3.5" /> Refresh</button>
      </div>

      {overviewErr && <ErrorBanner>{overviewErr}</ErrorBanner>}

      {/* Permanent Health Panel */}
      <HealthPanel indicators={health} />

      {/* Tabs */}
      <div className="flex flex-wrap gap-1 border-b border-border">
        {TABS.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)} aria-current={tab === t.key ? 'page' : undefined}
            className={cn('rounded-t-md px-3.5 py-2 text-[13.5px] font-medium transition-colors',
              tab === t.key ? 'border-b-2 border-primary text-primary' : 'text-muted-foreground hover:text-foreground')}>
            {t.label}
          </button>
        ))}
      </div>

      {/* Body */}
      {tab === 'overview' && (overview ? <OverviewWorkspace o={overview} uid={organizerUid} onGoto={setTab} onChanged={refreshOverview} /> : !overviewErr && <CenterSpin />)}
      {tab === 'operations' && (
        operationsErr ? <GateError error={operationsErr} onRetry={() => { setOperationsErr(null); setOperations(null) }} />
          : operationsLoading ? <CenterSpin /> : operations && <OperationsWorkspace d={operations} />
      )}
      {tab === 'business' && <BusinessWorkspace uid={organizerUid} />}
      {tab === 'governance' && overview && <GovernanceWorkspace uid={organizerUid} o={overview} onChanged={refreshOverview} />}
    </div>
  )
}

// Merge a fresh core-health array with any previously-upgraded deferred signals.
function mergeHealth(fresh: HealthIndicator[], prev: HealthIndicator[]): HealthIndicator[] {
  const prevMap = new Map(prev.map(h => [h.key, h]))
  return fresh.map(h => (h.level === 'neutral' && prevMap.get(h.key) && prevMap.get(h.key)!.level !== 'neutral') ? prevMap.get(h.key)! : h)
}
function upgradeHealth(prev: HealthIndicator[], ops: Organizer360Operations): HealthIndicator[] {
  const patch: Partial<Record<HealthIndicator['key'], HealthIndicator>> = {
    communications: {
      key: 'communications', label: 'Communications',
      level: ops.communications.failed > 0 ? 'yellow' : ops.communications.sent > 0 ? 'green' : 'neutral',
      detail: ops.communications.sent > 0 ? `${ops.communications.sent} sent · ${ops.communications.failed} failed` : 'None sent',
    },
    jobs: {
      key: 'jobs', label: 'Background Jobs',
      level: ops.jobs.failed > 0 ? 'red' : ops.jobs.running > 0 ? 'yellow' : ops.jobs.total > 0 ? 'green' : 'neutral',
      detail: ops.jobs.total > 0 ? `${ops.jobs.running} running · ${ops.jobs.failed} failed` : 'No jobs',
    },
  }
  return prev.map(h => patch[h.key] ?? h)
}

// ─── Health Panel ─────────────────────────────────────────────────────────────

function HealthPanel({ indicators }: { indicators: HealthIndicator[] }) {
  if (!indicators.length) {
    return <div className="flex items-center gap-2 rounded-xl border border-border bg-card p-4 text-[13px] text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Evaluating health…</div>
  }
  return (
    <div className="rounded-xl border border-border bg-card p-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8">
        {indicators.map(h => (
          <div key={h.key} className="rounded-lg border border-border bg-muted/30 px-3 py-2">
            <div className="flex items-center gap-1.5">
              <span className={cn('size-2 shrink-0 rounded-full', HEALTH_DOT[h.level])} aria-hidden />
              <span className="truncate text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{h.label}</span>
            </div>
            <p className="mt-1 truncate text-[12.5px] font-medium text-foreground" title={h.detail}>{h.detail}</p>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Overview workspace ────────────────────────────────────────────────────────

function OverviewWorkspace({ o, uid, onGoto, onChanged }: {
  o: Organizer360Overview; uid: string; onGoto: (t: TabKey) => void; onChanged: () => void
}) {
  const { confirm, prompt } = useConfirm()
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  async function moderate(action: 'suspend' | 'reactivate' | 'ban') {
    let reason = ''
    if (action !== 'reactivate') {
      reason = (await prompt({ title: `${action} organizer`, message: `Reason for ${action}:`, required: true, tone: 'danger' }))?.trim() ?? ''
      if (!reason) return
    } else if (!(await confirm({ title: 'Reactivate organizer', message: 'Reactivate this organizer?' }))) return
    setBusy(action); setErr(null)
    try {
      const token = await getToken()
      const res = await fetch(`/api/admin/organizers/${uid}`, {
        method: 'PATCH', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ action, reason }),
      })
      if (!res.ok) { const b = await res.json().catch(() => null) as { error?: string } | null; throw new Error(b?.error ?? `Request failed (${res.status})`) }
      onChanged()
    } catch (e) { setErr(e instanceof Error ? e.message : 'Action failed') } finally { setBusy(null) }
  }

  return (
    <div className="space-y-4">
      {err && <ErrorBanner>{err}</ErrorBanner>}

      {/* KPIs */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Kpi icon={CalendarDays} label="Events" value={num(o.events.total)} />
        <Kpi icon={BadgeCheck} label="Published" value={num(o.events.published)} />
        <Kpi icon={Users} label="Registrations" value={num(o.registrations.total)} />
        <Kpi icon={KeyRound} label="Active licenses" value={num(o.licenses.active)} />
        <Kpi icon={IndianRupee} label="Available" value={rupees(o.revenue.availablePaise)} />
        <Kpi icon={IndianRupee} label="Settled" value={rupees(o.revenue.settledPaise)} />
      </div>
      {o.registrations.truncated && <p className="text-[12px] text-muted-foreground">Registration/revenue rollup sampled the {num(o.registrations.sampledEvents)} most recent events.</p>}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Organizer summary" icon={Building2}>
          <dl className="space-y-2 p-4 text-[13.5px]">
            <Row label="Name" value={o.profile.name || '—'} />
            <Row label="Organization" value={o.profile.organizationName || '—'} />
            <Row label="Role" value={o.profile.role} />
            <Row label="Email" value={o.profile.email || '—'} icon={Mail} />
            <Row label="Phone" value={o.profile.phone ?? '—'} icon={Phone} />
            <Row label="Joined" value={fmtDay(o.profile.createdAt)} />
          </dl>
        </Card>

        <Card title="Verification & account" icon={Fingerprint}>
          <div className="space-y-3 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <StatusPill tone={o.verification.emailVerified ? 'success' : 'warning'}>{o.verification.emailVerified ? 'email verified' : 'email unverified'}</StatusPill>
              <StatusPill tone={o.verification.payoutVerified ? 'success' : o.verification.payoutExists ? 'warning' : 'neutral'}>
                {o.verification.payoutVerified ? 'payout verified' : o.verification.payoutExists ? 'payout unverified' : 'no payout'}
              </StatusPill>
              {o.verification.payoutMethod && <StatusPill tone="neutral">{o.verification.payoutMethod}</StatusPill>}
            </div>
            <dl className="space-y-2 text-[13.5px]">
              <Row label="Account status" value={o.account.status} />
              {o.account.statusReason && <Row label="Reason" value={o.account.statusReason} />}
              <Row label="Team" value={`${o.team.memberCount} members · ${o.team.inviteCount} invites`} icon={Users} />
              <Row label="Entitlement tier" value={`${o.entitlements.effectiveTier} (${o.entitlements.source})`} />
            </dl>
          </div>
        </Card>

        <Card title="Revenue summary" icon={Wallet}>
          <dl className="space-y-2 p-4 text-[13.5px]">
            <Row label="Available" value={rupees(o.revenue.availablePaise)} />
            <Row label="Pending" value={rupees(o.revenue.pendingPaise)} />
            <Row label="In transit" value={rupees(o.revenue.inTransitPaise)} />
            <Row label="Settled" value={rupees(o.revenue.settledPaise)} />
            <Row label="License revenue" value={rupees(o.licenses.revenuePaise)} />
          </dl>
        </Card>

        {/* Quick actions */}
        <Card title="Quick actions" icon={UserCog}>
          <div className="space-y-3 p-4">
            <div className="flex flex-wrap gap-2">
              {o.account.status !== 'active'
                ? <Act icon={PlayCircle} label="Activate" tone="emerald" busy={busy === 'reactivate'} onClick={() => void moderate('reactivate')} />
                : <Act icon={ShieldOff} label="Suspend" tone="amber" busy={busy === 'suspend'} onClick={() => void moderate('suspend')} />}
              {o.account.status !== 'banned' && <Act icon={Ban} label="Ban" tone="red" busy={busy === 'ban'} onClick={() => void moderate('ban')} />}
            </div>
            <div className="flex flex-col gap-2">
              <button onClick={() => onGoto('operations')} className={cn(btnOutline, 'justify-between')}><span className="inline-flex items-center gap-2"><Activity className="size-3.5" /> View Operations &amp; Event 360</span></button>
              <button onClick={() => onGoto('business')} className={cn(btnOutline, 'justify-between')}><span className="inline-flex items-center gap-2"><KeyRound className="size-3.5" /> View Licenses, Coupons &amp; Payments</span></button>
              <DeepLink href="/admin/licenses" label="Open License Console" />
              <DeepLink href="/admin/finance" label="Open Finance Console" />
              <DeepLink href="/admin/communications" label="Open Communications" />
              <DeepLink href="/admin/audit" label="Open Admin Audit Log" />
            </div>
          </div>
        </Card>
      </div>
    </div>
  )
}

// ─── Operations workspace ──────────────────────────────────────────────────────

function OperationsWorkspace({ d }: { d: Organizer360Operations }) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Kpi icon={Award} label="Certificates" value={num(d.certificates.issued)} />
        <Kpi icon={Send} label="Emails sent" value={num(d.communications.sent)} />
        <Kpi icon={Activity} label="Jobs running" value={num(d.jobs.running)} />
        <Kpi icon={Ticket} label="Jobs failed" value={num(d.jobs.failed)} />
      </div>

      <Card title={`Events (${d.events.length}${d.truncated ? '+' : ''})`} icon={CalendarDays}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-[13px]">
            <thead className="border-b border-border text-left text-[11px] uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-semibold">Event</th>
                <th className="px-4 py-2 font-semibold">Status</th>
                <th className="px-4 py-2 font-semibold">License</th>
                <th className="px-4 py-2 text-right font-semibold">Regs</th>
                <th className="px-4 py-2 text-right font-semibold">In</th>
                <th className="px-4 py-2 text-right font-semibold">Revenue</th>
                <th className="px-4 py-2 text-right font-semibold">360</th>
              </tr>
            </thead>
            <tbody>
              {d.events.length === 0 ? (
                <tr><td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">No events.</td></tr>
              ) : d.events.map(e => (
                <tr key={e.slug} className="border-b border-border/60">
                  <td className="px-4 py-2">
                    <div className="max-w-[220px] truncate font-medium text-foreground">{e.name}</div>
                    <div className="max-w-[220px] truncate text-[11px] text-muted-foreground">{e.slug}</div>
                  </td>
                  <td className="px-4 py-2"><StatusPill tone={e.lifecycleStatus === 'published' ? 'success' : 'neutral'}>{e.lifecycleStatus ?? '—'}</StatusPill></td>
                  <td className="px-4 py-2 text-muted-foreground">{e.licenseTier ?? '—'}{e.licenseStatus ? ` · ${e.licenseStatus}` : ''}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{num(e.registrations)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{num(e.checkedIn)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{rupees(e.revenuePaise)}</td>
                  <td className="px-4 py-2 text-right">
                    <Link href={`/admin/events/${e.slug}`} title="Open Event 360" className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11.5px] font-medium text-foreground hover:bg-muted"><LayoutGrid className="size-3.5" /> 360</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Communications & certificates" icon={Send}>
          <dl className="space-y-2 p-4 text-[13.5px]">
            <Row label="Emails sent" value={num(d.communications.sent)} icon={Mail} />
            <Row label="Emails failed" value={num(d.communications.failed)} />
            <Row label="Certificates issued" value={num(d.certificates.issued)} icon={Award} />
            <Row label="Sampled events" value={num(d.communications.approxOfEvents)} />
          </dl>
        </Card>
        <Card title="Background jobs" icon={Activity}>
          <div className="p-4">
            {d.jobs.recent.length === 0 ? <Empty>No recent jobs.</Empty> : (
              <ul className="space-y-1.5">
                {d.jobs.recent.map(j => (
                  <li key={j.id} className="flex items-center justify-between gap-2 rounded-md bg-muted/30 px-3 py-1.5 text-[12.5px]">
                    <span className="inline-flex items-center gap-2"><StatusPill tone={j.status === 'failed' || j.status === 'error' ? 'danger' : j.status === 'completed' || j.status === 'succeeded' ? 'success' : 'neutral'}>{j.status}</StatusPill><span className="text-muted-foreground">{j.kind}</span></span>
                    <span className="text-[11px] text-muted-foreground">{fmtDay(j.createdAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>
      </div>
    </div>
  )
}

// ─── Business workspace ────────────────────────────────────────────────────────

function BusinessWorkspace({ uid }: { uid: string }) {
  const [data, setData] = useState<Organizer360Business | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const d = await authedGet<Organizer360Business>(`/api/admin/organizers/${uid}/business`)
        if (!alive) return
        setErr(null); setData(d)
      } catch (e) { if (alive) setErr(e instanceof Error ? e.message : 'Failed to load business data') }
    })()
    return () => { alive = false }
  }, [uid, reloadKey])

  if (err) return <GateError error={err} onRetry={() => { setErr(null); setReloadKey(k => k + 1) }} />
  if (!data) return <CenterSpin />

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Kpi icon={KeyRound} label="Licenses" value={num(data.licenses.length)} />
        <Kpi icon={IndianRupee} label="License rev." value={rupees(data.revenue.licenseRevenuePaise)} />
        <Kpi icon={IndianRupee} label="Event rev." value={rupees(data.revenue.eventRevenuePaise)} />
        <Kpi icon={Wallet} label="Available" value={rupees(data.wallet.availablePaise)} />
        <Kpi icon={Wallet} label="Pending" value={rupees(data.wallet.pendingPaise)} />
        <Kpi icon={Wallet} label="Settled" value={rupees(data.wallet.settledPaise)} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title={`Licenses${data.truncated ? ' (first 100)' : ''}`} icon={KeyRound}>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-[13px]">
              <thead className="border-b border-border text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                <tr><th className="px-4 py-2 font-semibold">Event</th><th className="px-4 py-2 font-semibold">Tier</th><th className="px-4 py-2 font-semibold">Status</th><th className="px-4 py-2 text-right font-semibold">Paid</th></tr>
              </thead>
              <tbody>
                {data.licenses.length === 0 ? <tr><td colSpan={4} className="px-4 py-8 text-center text-muted-foreground">No licenses.</td></tr>
                  : data.licenses.map(l => (
                    <tr key={l.eventId} className="border-b border-border/60">
                      <td className="px-4 py-2"><Link href={`/admin/events/${l.eventId}`} className="max-w-[200px] truncate text-primary hover:underline">{l.eventId}</Link>{l.couponCode && <span className="ml-1 text-[11px] text-muted-foreground">🎟 {l.couponCode}</span>}</td>
                      <td className="px-4 py-2 capitalize">{l.tier}</td>
                      <td className="px-4 py-2"><StatusPill tone={l.displayStatus === 'active' ? 'success' : l.displayStatus === 'pending' ? 'warning' : 'danger'}>{l.displayStatus}</StatusPill></td>
                      <td className="px-4 py-2 text-right tabular-nums">{rupees(l.amountPaidPaise)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card title="Coupons used" icon={Gift}>
          <div className="p-4">
            {data.coupons.length === 0 ? <Empty>No coupons used.</Empty> : <HBars data={data.coupons.map(c => ({ label: c.code, value: c.count }))} />}
          </div>
        </Card>

        <Card title="Wallet & settlements" icon={Wallet}>
          <div className="space-y-3 p-4">
            <dl className="space-y-2 text-[13.5px]">
              <Row label="Payout" value={data.payout.exists ? (data.payout.verified ? `Verified (${data.payout.method ?? '—'})` : 'Unverified') : 'None'} />
              <Row label="Available" value={rupees(data.wallet.availablePaise)} />
              <Row label="In transit" value={rupees(data.wallet.inTransitPaise)} />
            </dl>
            {data.settlements.length > 0 && (
              <div>
                <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Recent settlements</p>
                <ul className="space-y-1">
                  {data.settlements.map(s => (
                    <li key={s.id} className="flex items-center justify-between rounded-md bg-muted/30 px-3 py-1.5 text-[12.5px]">
                      <span className="capitalize text-muted-foreground">{s.status}</span>
                      <span className="font-medium text-foreground">{rupees(s.amountPaise)} · {fmtDay(s.requestedAt)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </Card>

        <Card title="Entitlements" icon={SlidersHorizontal}>
          <div className="space-y-3 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <StatusPill tone="neutral">{data.entitlements.effectiveTier}</StatusPill>
              <StatusPill tone="info">{data.entitlements.source}</StatusPill>
              <span className="text-[12.5px] text-muted-foreground">{data.entitlements.activeLicensedEvents} active licensed events</span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {data.entitlements.features.filter(f => f.enabled).map(f => <StatusPill key={f.key} tone="success">{f.key}</StatusPill>)}
              {data.entitlements.features.filter(f => f.enabled).length === 0 && <Empty>No premium features enabled.</Empty>}
            </div>
          </div>
        </Card>
      </div>
    </div>
  )
}

// ─── Governance workspace ──────────────────────────────────────────────────────

function GovernanceWorkspace({ uid, o, onChanged }: {
  uid: string; o: Organizer360Overview; onChanged: () => void
}) {
  const [gov, setGov] = useState<Organizer360Governance | null>(null)
  const [timeline, setTimeline] = useState<Organizer360TimelineEntry[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const { confirm, prompt } = useConfirm()

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const [g, t] = await Promise.all([
          authedGet<Organizer360Governance>(`/api/admin/organizers/${uid}/governance`),
          authedGet<Organizer360Timeline>(`/api/admin/organizers/${uid}/timeline`),
        ])
        if (!alive) return
        setErr(null); setGov(g); setTimeline(t.entries)
      } catch (e) { if (alive) setErr(e instanceof Error ? e.message : 'Failed to load governance') }
    })()
    return () => { alive = false }
  }, [uid, reloadKey])

  async function setOverride() {
    const cur = gov?.overrides.entitlementOverrideTier
    const v = (await prompt({ title: 'Entitlement override', message: `Override tier (${EVENT_LICENSE_TIERS.join(' / ')}), or "clear":`, placeholder: cur ?? 'clear' }))?.trim()
    if (!v) return
    const clearing = v.toLowerCase() === 'clear'
    if (!clearing && !EVENT_LICENSE_TIERS.includes(v as EventLicenseTier)) { setErr('Invalid tier'); return }
    if (!(await confirm({ message: clearing ? 'Clear the entitlement override?' : `Set entitlement override to "${v}"? This can only raise entitlements.`, tone: clearing ? undefined : 'danger' }))) return
    setBusy('override'); setErr(null)
    try {
      const token = await getToken()
      const res = await fetch(`/api/admin/organizers/${uid}/plan`, {
        method: 'PATCH', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ overrideTier: clearing ? null : v }),
      })
      if (!res.ok) { const b = await res.json().catch(() => null) as { error?: string } | null; throw new Error(b?.error ?? `Request failed (${res.status})`) }
      setReloadKey(k => k + 1); onChanged()
    } catch (e) { setErr(e instanceof Error ? e.message : 'Action failed') } finally { setBusy(null) }
  }

  return (
    <div className="space-y-4">
      {err && <ErrorBanner>{err}</ErrorBanner>}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Overrides & feature flags" icon={SlidersHorizontal}>
          <div className="space-y-3 p-4">
            <div className="flex flex-wrap items-center gap-2 text-[13.5px]">
              <span className="text-muted-foreground">Effective tier</span>
              <StatusPill tone="neutral">{gov?.overrides.effectiveTier ?? o.entitlements.effectiveTier}</StatusPill>
              <StatusPill tone="info">{gov?.overrides.source ?? o.entitlements.source}</StatusPill>
              {gov?.overrides.entitlementOverrideTier && <StatusPill tone="accent">override: {gov.overrides.entitlementOverrideTier}</StatusPill>}
            </div>
            <Act icon={SlidersHorizontal} label="Set / clear entitlement override" busy={busy === 'override'} onClick={() => void setOverride()} />
            <div className="flex flex-wrap gap-1.5 pt-1">
              {(gov?.features ?? []).filter(f => f.enabled).map(f => <StatusPill key={f.key} tone="success">{f.key}</StatusPill>)}
              {gov && gov.features.filter(f => f.enabled).length === 0 && <Empty>No premium features enabled.</Empty>}
            </div>
          </div>
        </Card>

        <Card title="Team & permissions" icon={Users}>
          <div className="p-4">
            {gov === null ? <CenterSpin /> : gov.team.length === 0 ? <Empty>No team members.</Empty> : (
              <ul className="space-y-1.5">
                {gov.team.map(m => (
                  <li key={m.id} className="flex items-center justify-between gap-2 rounded-md bg-muted/30 px-3 py-1.5 text-[12.5px]">
                    <span className="min-w-0 truncate"><span className="font-medium text-foreground">{m.email || m.name || m.id}</span> <span className="text-muted-foreground">· {m.role}</span></span>
                    <span className="inline-flex items-center gap-1.5"><StatusPill tone={m.status === 'active' ? 'success' : m.status === 'invited' ? 'warning' : 'neutral'}>{m.status}</StatusPill><span className="text-[11px] text-muted-foreground">{m.permissions} perms</span></span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>
      </div>

      {/* Audit */}
      <Card title="Admin audit" icon={ShieldCheck}>
        <div className="p-4">
          {gov === null ? <CenterSpin /> : gov.audit.length === 0 ? <Empty>No admin actions recorded.</Empty> : (
            <ul className="space-y-2">
              {gov.audit.map(a => (
                <li key={a.id} className="rounded-lg border border-border bg-muted/30 px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="inline-flex items-center gap-2"><StatusPill tone="info">{a.entityType || 'admin'}</StatusPill><span className="font-medium capitalize text-foreground">{a.action.replace(/[._]/g, ' ')}</span></span>
                    <span className="text-[11px] text-muted-foreground">{fmtDate(a.at)}</span>
                  </div>
                  {a.detail && <p className="mt-0.5 text-[12.5px] text-muted-foreground">{a.detail}</p>}
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>

      {/* Timeline */}
      <Card title="Timeline" icon={ScrollText}>
        <div className="p-4">
          {timeline === null ? <CenterSpin /> : timeline.length === 0 ? <Empty>No history yet.</Empty> : (
            <ol className="space-y-2">
              {timeline.map(t => (
                <li key={t.id} className="rounded-lg border border-border bg-muted/30 px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="inline-flex items-center gap-2"><StatusPill tone={TIMELINE_TONE[t.source]}>{t.source}</StatusPill><span className="font-medium capitalize text-foreground">{t.action.replace(/[._]/g, ' ')}</span></span>
                    <span className="text-[11px] text-muted-foreground">{fmtDate(t.at)}</span>
                  </div>
                  {t.detail && <p className="mt-0.5 text-[12.5px] text-muted-foreground">{t.detail}</p>}
                  {t.actor && <p className="mt-0.5 text-[11px] text-muted-foreground/70">{t.actor.slice(0, 10)}…</p>}
                </li>
              ))}
            </ol>
          )}
        </div>
      </Card>
    </div>
  )
}

const TIMELINE_TONE: Record<Organizer360TimelineEntry['source'], PillTone> = {
  account: 'neutral', verification: 'success', license: 'accent', coupon: 'accent',
  event: 'info', payment: 'warning', audit: 'info', override: 'warning',
}

// ─── Shared primitives ─────────────────────────────────────────────────────────

const btnOutline = 'inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-[13px] font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50'

function CenterSpin() { return <div className="flex justify-center py-16"><Loader2 className="size-6 animate-spin text-muted-foreground" /></div> }
function Empty({ children }: { children: React.ReactNode }) { return <p className="text-[13px] text-muted-foreground">{children}</p> }
function GateError({ error, onRetry }: { error: string; onRetry: () => void }) {
  return <div className="space-y-3"><ErrorBanner>{error}</ErrorBanner><button onClick={onRetry} className={btnOutline}><RefreshCw className="size-3.5" /> Retry</button></div>
}

function Kpi({ icon: Icon, label, value }: { icon: typeof Users; label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-3.5">
      <div className="flex items-center gap-1.5 text-muted-foreground"><Icon className="size-3.5" aria-hidden /><span className="truncate text-[11px] font-medium uppercase tracking-wide">{label}</span></div>
      <p className="mt-1.5 truncate text-[19px] font-bold tabular-nums text-foreground" title={value}>{value}</p>
    </div>
  )
}
function Card({ title, icon: Icon, children }: { title: string; icon?: typeof Users; children: React.ReactNode }) {
  return (
    <section className="overflow-hidden rounded-xl border border-border bg-card">
      <header className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        {Icon && <Icon className="size-4 text-muted-foreground" aria-hidden />}
        <h2 className="text-[13.5px] font-semibold text-foreground">{title}</h2>
      </header>
      {children}
    </section>
  )
}
function Row({ label, value, icon: Icon }: { label: string; value: string; icon?: typeof Users }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="inline-flex shrink-0 items-center gap-1.5 text-[12.5px] text-muted-foreground">{Icon && <Icon className="size-3.5" aria-hidden />}{label}</dt>
      <dd className="min-w-0 truncate text-right font-medium text-foreground" title={value}>{value}</dd>
    </div>
  )
}
function DeepLink({ href, label }: { href: string; label: string }) {
  return <Link href={href} className={cn(btnOutline, 'justify-between')}><span>{label}</span><ExternalLink className="size-3.5 text-muted-foreground" /></Link>
}
function Act({ icon: Icon, label, onClick, busy, tone }: {
  icon: typeof KeyRound; label: string; onClick: () => void; busy?: boolean; tone?: 'emerald' | 'amber' | 'red'
}) {
  const toneCls = tone === 'emerald' ? 'hover:border-emerald-300 hover:bg-emerald-50 hover:text-emerald-700'
    : tone === 'amber' ? 'hover:border-amber-300 hover:bg-amber-50 hover:text-amber-700'
    : tone === 'red' ? 'hover:border-red-300 hover:bg-red-50 hover:text-red-700' : 'hover:bg-muted'
  return (
    <button onClick={onClick} disabled={busy}
      className={cn('inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-[12.5px] font-medium text-foreground transition-colors disabled:opacity-40', toneCls)}>
      {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Icon className="size-3.5" />}{label}
    </button>
  )
}
