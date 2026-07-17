'use client'

// Enterprise Event 360 Console (GA-2 S1).
// The single admin command center for ONE event. Four logical workspaces
// (Overview / Operations / Business / Governance) over a permanent Health Panel.
// Purely additive + READ-first: every read hits a thin admin endpoint that reuses
// existing services; every MUTATION reuses an EXISTING admin route
// (POST /api/admin/licenses/[slug], POST …/review, PATCH …/[slug]). Overview loads
// first; the other workspaces load lazily on first open (analytics is shared by
// Operations + Business and fetched once).

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { auth } from '@/lib/firebase/auth'
import { cn } from '@/lib/utils/cn'
import {
  Loader2, ArrowLeft, ExternalLink, KeyRound, Users, IndianRupee, Ticket,
  CalendarDays, MapPin, Building2, Mail, Phone, ShieldCheck, Award, Printer,
  Send, Activity, ScrollText, RefreshCw, PlayCircle, PauseCircle, XCircle,
  ArrowUpCircle, ArrowDownCircle, BadgeCheck, Undo2,
  Gift, CalendarPlus, CalendarMinus, CalendarX, Unlock, Fingerprint, ShieldAlert,
  Zap, RotateCcw, CheckCircle2, Ban, Clock,
} from 'lucide-react'
import { StatusPill, ErrorBanner } from '@/components/admin'
import type { PillTone } from '@/components/admin'
import { useConfirm } from '@/components/ui/ConfirmDialog'
import { Bars, HBars, Donut, Funnel } from '@/components/analytics/Charts'
import { EVENT_LICENSE_TIERS, type EventLicenseTier } from '@/lib/licensing/eventLicense'
import type {
  Event360Overview, Event360Response, Event360Analytics, Event360Governance,
  Event360Timeline, Event360TimelineEntry, HealthIndicator, HealthLevel,
} from '@/lib/admin/event360Types'
import type { LicenseAdminActionType, LicenseAdminActionRequest } from '@/lib/admin/licenseAdminTypes'
import type { EventAnalytics } from '@/lib/analytics/eventAnalytics'

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

export default function Event360Page() {
  const { slug } = useParams<{ slug: string }>()
  const [tab, setTab] = useState<TabKey>('overview')

  const [overview, setOverview] = useState<Event360Overview | null>(null)
  const [overviewErr, setOverviewErr] = useState<string | null>(null)

  // Lazy caches — fetched once, on first open of the workspace that needs them.
  const [analytics, setAnalytics] = useState<EventAnalytics | null>(null)
  const [analyticsErr, setAnalyticsErr] = useState<string | null>(null)
  const [analyticsReloadKey, setAnalyticsReloadKey] = useState(0)
  const analyticsRef = useRef<EventAnalytics | null>(null)   // latest analytics for refreshOverview

  // Live health starts from /360; deferred indicators are upgraded from analytics.
  const [health, setHealth] = useState<HealthIndicator[]>([])

  // Overview (backbone) — loads first.
  useEffect(() => {
    if (!slug) return
    let alive = true
    void (async () => {
      try {
        const d = await authedGet<Event360Response>(`/api/admin/events/${slug}/360`)
        if (!alive) return
        setOverview(d.overview)
        setHealth(d.overview.health)
      } catch (e) {
        if (alive) setOverviewErr(e instanceof Error ? e.message : 'Failed to load event')
      }
    })()
    return () => { alive = false }
  }, [slug])

  // Analytics — lazily fetched when Operations or Business first opens (shared,
  // once; re-fetched only when the reload key is bumped). Inline async IIFE keeps
  // every setState off the synchronous effect path.
  const needAnalytics = tab === 'operations' || tab === 'business'
  useEffect(() => {
    if (!slug || !needAnalytics || analytics) return
    let alive = true
    void (async () => {
      try {
        const d = await authedGet<Event360Analytics>(`/api/admin/events/${slug}/analytics`)
        if (!alive) return
        analyticsRef.current = d.analytics
        setAnalyticsErr(null)
        setAnalytics(d.analytics)
        setHealth(prev => upgradeHealth(prev, d.analytics))
      } catch (e) {
        if (alive) setAnalyticsErr(e instanceof Error ? e.message : 'Failed to load analytics')
      }
    })()
    return () => { alive = false }
  }, [slug, needAnalytics, analytics, analyticsReloadKey])

  const retryAnalytics = useCallback(() => { setAnalyticsErr(null); setAnalyticsReloadKey(k => k + 1) }, [])

  const refreshOverview = useCallback(async () => {
    if (!slug) return
    try {
      const d = await authedGet<Event360Response>(`/api/admin/events/${slug}/360`)
      setOverview(d.overview)
      const a = analyticsRef.current
      setHealth(a ? upgradeHealth(d.overview.health, a) : d.overview.health)
    } catch { /* keep prior */ }
  }, [slug])

  const analyticsLoading = !analytics && !analyticsErr

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link href="/admin/event-approvals" className="mb-1 inline-flex items-center gap-1.5 text-[12.5px] font-medium text-muted-foreground transition-colors hover:text-foreground">
            <ArrowLeft className="size-3.5" /> Events
          </Link>
          <h1 className="text-[20px] font-bold tracking-tight text-foreground">
            {overview?.eventName ?? (overviewErr ? 'Event' : 'Loading…')}
          </h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[12.5px] text-muted-foreground">
            <span className="font-mono">{slug}</span>
            {overview?.lifecycleStatus && <StatusPill tone="neutral">{overview.lifecycleStatus}</StatusPill>}
            {overview?.reviewStatus && overview.reviewStatus !== overview.lifecycleStatus && (
              <StatusPill tone="warning">{overview.reviewStatus}</StatusPill>
            )}
            {overview?.moderationStatus && overview.moderationStatus !== 'active' && (
              <StatusPill tone="danger">{overview.moderationStatus}</StatusPill>
            )}
          </div>
        </div>
        <button onClick={() => void refreshOverview()} className={btnOutline}>
          <RefreshCw className="size-3.5" /> Refresh
        </button>
      </div>

      {overviewErr && <ErrorBanner>{overviewErr}</ErrorBanner>}

      {/* Permanent Health Panel */}
      <HealthPanel indicators={health} />

      {/* Workspace tabs */}
      <div className="flex flex-wrap gap-1 border-b border-border">
        {TABS.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            aria-current={tab === t.key ? 'page' : undefined}
            className={cn(
              'rounded-t-md px-3.5 py-2 text-[13.5px] font-medium transition-colors',
              tab === t.key ? 'border-b-2 border-primary text-primary' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Workspace body */}
      {tab === 'overview' && (
        overview ? <OverviewWorkspace o={overview} onGoto={setTab} /> : !overviewErr && <CenterSpin />
      )}
      {tab === 'operations' && (
        <AnalyticsGate loading={analyticsLoading} error={analyticsErr} data={analytics} onRetry={retryAnalytics}>
          {a => <OperationsWorkspace a={a} o={overview} />}
        </AnalyticsGate>
      )}
      {tab === 'business' && (
        <AnalyticsGate loading={analyticsLoading} error={analyticsErr} data={analytics} onRetry={retryAnalytics}>
          {a => <BusinessWorkspace a={a} />}
        </AnalyticsGate>
      )}
      {tab === 'governance' && overview && (
        <GovernanceWorkspace slug={slug} o={overview} onChanged={() => void refreshOverview()} />
      )}
    </div>
  )
}

// Fold the analytics-derived signals into the permanent health strip.
function upgradeHealth(prev: HealthIndicator[], a: EventAnalytics): HealthIndicator[] {
  const patch: Partial<Record<HealthIndicator['key'], HealthIndicator>> = {
    certificates: {
      key: 'certificates', label: 'Certificates',
      level: a.certificates.issued > 0 ? 'green' : 'neutral',
      detail: a.certificates.issued > 0 ? `${a.certificates.issued} issued · ${a.certificates.downloaded} downloaded` : 'None issued',
    },
    communications: {
      key: 'communications', label: 'Communications',
      level: a.communication.failed > 0 ? 'yellow' : a.communication.sent > 0 ? 'green' : 'neutral',
      detail: a.communication.sent > 0 ? `${a.communication.sent} sent · ${a.communication.failed} failed` : 'None sent',
    },
    analytics: {
      key: 'analytics', label: 'Analytics',
      level: 'green', detail: `${num(a.kpis.registrations)} regs · ${rupees(a.kpis.revenuePaise)}`,
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

function OverviewWorkspace({ o, onGoto }: { o: Event360Overview; onGoto: (t: TabKey) => void }) {
  return (
    <div className="space-y-4">
      {/* Counters */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <Kpi icon={Users} label="Registrations" value={num(o.counters.totalRegistrations)} />
        <Kpi icon={CheckCircle2} label="Checked in" value={num(o.counters.checkedIn)} />
        <Kpi icon={IndianRupee} label="Revenue" value={rupees(o.counters.revenuePaise)} />
        <Kpi icon={Clock} label="Pending" value={num(o.counters.pending)} />
        <Kpi icon={Ban} label="Cancelled" value={num(o.counters.cancelled)} />
      </div>
      {!o.counters.statsComplete && (
        <p className="text-[12px] text-muted-foreground">Aggregate statistics are being reconciled — figures may be approximate.</p>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Event summary */}
        <Card title="Event summary" icon={CalendarDays}>
          <dl className="space-y-2 p-4 text-[13.5px]">
            <Row label="Type" value={o.eventType ?? '—'} />
            <Row label="Tagline" value={o.tagline || '—'} />
            <Row label="Starts" value={`${fmtDay(o.schedule.startDate)}${o.schedule.startTime ? ` · ${o.schedule.startTime}` : ''}`} />
            <Row label="Ends" value={fmtDay(o.schedule.endDate)} />
            <Row label="Timezone" value={o.schedule.timezone ?? '—'} />
            <Row label="Venue" value={[o.venue.name, o.venue.city, o.venue.state].filter(Boolean).join(', ') || (o.venue.type ?? '—')} icon={MapPin} />
          </dl>
        </Card>

        {/* Organizer */}
        <Card title="Organizer" icon={Building2}>
          <dl className="space-y-2 p-4 text-[13.5px]">
            <Row label="Name" value={o.organizer.name ?? '—'} />
            <Row label="Workspace" value={o.organizer.workspace ?? '—'} />
            <Row label="Email" value={o.organizer.email ?? '—'} icon={Mail} />
            <Row label="Phone" value={o.organizer.phone ?? '—'} icon={Phone} />
            <Row label="UID" value={o.organizer.uid || '—'} mono />
            {o.organizer.uid && (
              <Link href={`/admin/organizers/${o.organizer.uid}`} className="inline-flex items-center gap-1.5 pt-1 text-[12.5px] font-medium text-primary hover:underline">
                <ExternalLink className="size-3.5" /> Open Organizer 360 console
              </Link>
            )}
          </dl>
        </Card>

        {/* License */}
        <Card title="License" icon={KeyRound}>
          {o.license ? (
            <div className="space-y-3 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <StatusPill tone={o.license.displayStatus === 'active' ? 'success' : o.license.displayStatus === 'pending' ? 'warning' : 'danger'}>
                  {o.license.displayStatus ?? 'unknown'}
                </StatusPill>
                <StatusPill tone="neutral">{o.license.tier ?? '—'}</StatusPill>
                <StatusPill tone={o.license.paymentStatus === 'paid' || o.license.paymentStatus === 'free' || o.license.paymentStatus === 'complimentary' ? 'success' : o.license.paymentStatus === 'pending' ? 'warning' : 'neutral'}>
                  {o.license.paymentStatus ?? '—'}
                </StatusPill>
                {o.license.complimentary && <StatusPill tone="accent">complimentary</StatusPill>}
                {o.license.hasOverrides && <StatusPill tone="info">overrides</StatusPill>}
                {o.license.consumed && <StatusPill tone="neutral">consumed</StatusPill>}
              </div>
              <dl className="space-y-2 text-[13.5px]">
                <Row label="Reg. limit" value={o.license.registrationLimit === null ? 'Unlimited' : `${num(o.license.used)} / ${num(o.license.registrationLimit)}`} />
                <Row label="Amount paid" value={rupees(o.license.amountPaidPaise)} />
                <Row label="Expires" value={o.license.expiresAt ? fmtDay(o.license.expiresAt) : 'Never'} />
              </dl>
              {o.coupon && (
                <div className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-[12.5px]">
                  <span className="font-semibold text-foreground">Coupon {o.coupon.code}</span>
                  {o.coupon.campaign ? ` · ${o.coupon.campaign}` : ''} · −{rupees(o.coupon.discountPaise)}
                  {o.coupon.finalPricePaise != null ? ` → ${rupees(o.coupon.finalPricePaise)}` : ''}
                </div>
              )}
              <button onClick={() => onGoto('governance')} className={btnOutline}>
                <ShieldCheck className="size-3.5" /> Manage in Governance
              </button>
            </div>
          ) : (
            <p className="p-4 text-[13px] text-muted-foreground">No license record.</p>
          )}
        </Card>

        {/* Quick actions / deep-links */}
        <Card title="Quick actions" icon={Zap}>
          <div className="flex flex-col gap-2 p-4">
            <DeepLink href={`/admin/licenses`} label="Open in License Console" />
            <DeepLink href={`/admin/event-approvals`} label="Open in Event Approvals" />
            <DeepLink href={`/admin/moderation`} label="Open in Moderation" />
            <DeepLink href={`/admin/audit`} label="Open Admin Audit Log" />
            <button onClick={() => onGoto('governance')} className={cn(btnOutline, 'justify-between')}>
              <span className="inline-flex items-center gap-2"><ShieldCheck className="size-3.5" /> Governance &amp; license actions</span>
            </button>
          </div>
        </Card>
      </div>

      <div className="text-[12px] text-muted-foreground">
        Created {fmtDate(o.lifecycle.createdAt)} · Published {fmtDate(o.lifecycle.publishedAt)} · Approved {fmtDate(o.lifecycle.approvedAt)}
      </div>
    </div>
  )
}

// ─── Operations workspace ──────────────────────────────────────────────────────

function OperationsWorkspace({ a, o }: { a: EventAnalytics; o: Event360Overview | null }) {
  const toChart = (pts: { label: string; value: number }[]) => pts.map(p => ({ label: p.label, value: p.value }))
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Kpi icon={Users} label="Registered" value={num(a.kpis.registrations)} />
        <Kpi icon={BadgeCheck} label="Paid" value={num(a.kpis.paid)} />
        <Kpi icon={Ticket} label="Free" value={num(a.kpis.free)} />
        <Kpi icon={Clock} label="Pending" value={num(a.kpis.pending)} />
        <Kpi icon={CheckCircle2} label="Checked in" value={num(a.kpis.checkedIn)} />
        <Kpi icon={Ban} label="Cancelled" value={num(a.kpis.cancelled)} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Registrations / day" icon={Users}><div className="p-4"><Bars data={toChart(a.registrationsByDay)} /></div></Card>
        <Card title="Check-ins / day" icon={CheckCircle2}><div className="p-4"><Bars data={toChart(a.checkInsByDay)} /></div></Card>

        <Card title="Participant 360" icon={Activity}>
          <dl className="space-y-2 p-4 text-[13.5px]">
            <Row label="Total participants" value={num(a.kpis.registrations)} />
            <Row label="Confirmed / capacity" value={o?.license?.registrationLimit != null ? `${num(a.kpis.registrations - a.kpis.cancelled)} / ${num(o.license.registrationLimit)}` : num(a.kpis.registrations - a.kpis.cancelled)} />
            <Row label="Attendance rate" value={a.kpis.registrations > 0 ? `${Math.round((a.kpis.checkedIn / a.kpis.registrations) * 100)}%` : '—'} />
            <Row label="Refunded" value={num(a.kpis.refunded)} />
          </dl>
        </Card>

        <Card title="Certificates & Print" icon={Award}>
          <dl className="space-y-2 p-4 text-[13.5px]">
            <Row label="Certificates issued" value={num(a.certificates.issued)} icon={Award} />
            <Row label="Certificates downloaded" value={num(a.certificates.downloaded)} />
            <Row label="Print assets" value="Managed per workspace" icon={Printer} />
          </dl>
        </Card>

        <Card title="Communications" icon={Send}>
          <dl className="space-y-2 p-4 text-[13.5px]">
            <Row label="Emails sent" value={num(a.communication.sent)} icon={Mail} />
            <Row label="Delivered" value={num(a.communication.delivered)} />
            <Row label="Failed" value={num(a.communication.failed)} />
            <Row label="Reminders scheduled" value={num(a.reminders.scheduled)} />
            <Row label="Reminders sent" value={num(a.reminders.sent)} />
          </dl>
        </Card>

        <Card title="Pass sales" icon={Ticket}>
          <div className="p-4">{a.passSales.length ? <HBars data={toChart(a.passSales)} /> : <Empty>No pass sales.</Empty>}</div>
        </Card>
      </div>
    </div>
  )
}

// ─── Business workspace ────────────────────────────────────────────────────────

function BusinessWorkspace({ a }: { a: EventAnalytics }) {
  const toChart = (pts: { label: string; value: number }[]) => pts.map(p => ({ label: p.label, value: p.value }))
  const f = a.financial
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Kpi icon={IndianRupee} label="Gross" value={rupees(f.grossPaise)} />
        <Kpi icon={IndianRupee} label="Platform fee" value={rupees(f.platformFeePaise)} />
        <Kpi icon={IndianRupee} label="GST" value={rupees(f.gstPaise)} />
        <Kpi icon={IndianRupee} label="Gateway" value={rupees(f.gatewayFeePaise)} />
        <Kpi icon={IndianRupee} label="Net" value={rupees(f.netPaise)} />
        <Kpi icon={IndianRupee} label="Refunds" value={rupees(f.refundsPaise)} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Revenue / day" icon={IndianRupee}><div className="p-4"><Bars data={toChart(a.revenueByDay)} format={rupees} /></div></Card>
        <Card title="Registrations / day" icon={Users}><div className="p-4"><Bars data={toChart(a.registrationsByDay)} /></div></Card>

        <Card title="Payment status" icon={BadgeCheck}>
          <div className="p-4">{a.paymentStatus.length ? <Donut segments={toChart(a.paymentStatus)} /> : <Empty>No data.</Empty>}</div>
        </Card>
        <Card title="Conversion funnel" icon={Activity}>
          <div className="p-4"><Funnel steps={toChart(a.funnel)} /></div>
        </Card>

        <Card title="Pass revenue" icon={Ticket}>
          <div className="p-4">{a.passRevenue.length ? <HBars data={toChart(a.passRevenue)} format={rupees} /> : <Empty>No revenue yet.</Empty>}</div>
        </Card>
        <Card title="Coupon usage" icon={Gift}>
          <div className="p-4">
            {a.couponUsage.length ? <HBars data={toChart(a.couponUsage)} /> : <Empty>No coupons used.</Empty>}
            {a.couponDiscountPaise > 0 && <p className="mt-3 text-[12.5px] text-muted-foreground">Total discount: <strong className="text-foreground">{rupees(a.couponDiscountPaise)}</strong></p>}
          </div>
        </Card>

        <Card title="Settlement" icon={IndianRupee}>
          <dl className="space-y-2 p-4 text-[13.5px]">
            <Row label="Available" value={rupees(f.settlement.availablePaise)} />
            <Row label="Pending" value={rupees(f.settlement.pendingPaise)} />
            <Row label="Settled" value={rupees(f.settlement.settledPaise)} />
            <Row label="Profit estimate" value={rupees(f.profitEstimatePaise)} />
          </dl>
        </Card>
        <Card title="Reports" icon={ScrollText}>
          <div className="flex flex-col gap-2 p-4">
            <DeepLink href="/admin/finance-reports" label="Open Finance Reports" />
            <DeepLink href="/admin/finance" label="Open Finance Console" />
            <p className="text-[12px] text-muted-foreground">Per-event report exports run from the organizer workspace; platform finance reporting is here.</p>
          </div>
        </Card>
      </div>
    </div>
  )
}

// ─── Governance workspace ──────────────────────────────────────────────────────

function GovernanceWorkspace({ slug, o, onChanged }: {
  slug: string; o: Event360Overview; onChanged: () => void
}) {
  const [gov, setGov] = useState<Event360Governance | null>(null)
  const [timeline, setTimeline] = useState<Event360TimelineEntry[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const { confirm, prompt } = useConfirm()

  // Inline async IIFE (setState only after await) — re-runs when reloadKey bumps.
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const [g, t] = await Promise.all([
          authedGet<Event360Governance>(`/api/admin/events/${slug}/governance`),
          authedGet<Event360Timeline>(`/api/admin/events/${slug}/timeline`),
        ])
        if (!alive) return
        setErr(null); setGov(g); setTimeline(t.entries)
      } catch (e) {
        if (alive) setErr(e instanceof Error ? e.message : 'Failed to load governance')
      }
    })()
    return () => { alive = false }
  }, [slug, reloadKey])

  // Called from mutation handlers (event handlers, not effects): reload + refresh.
  const afterMutation = useCallback(() => { setReloadKey(k => k + 1); onChanged() }, [onChanged])

  // ── License actions (reuse the EXISTING admin route; no new mutation logic) ──
  async function postLicense(action: LicenseAdminActionType, body: Partial<LicenseAdminActionRequest>) {
    setBusy(action); setErr(null)
    try {
      const token = await getToken()
      const res = await fetch(`/api/admin/licenses/${slug}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ action, reason: '', ...body }),
      })
      if (!res.ok) {
        const b = await res.json().catch(() => null) as { error?: string } | null
        throw new Error(b?.error ?? `Request failed (${res.status})`)
      }
      afterMutation()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Action failed')
    } finally { setBusy(null) }
  }

  async function withReason(action: LicenseAdminActionType, extra: Partial<LicenseAdminActionRequest> = {}, confirmMsg?: string, tone: 'danger' | 'default' = 'default') {
    if (confirmMsg && !(await confirm({ message: confirmMsg, tone: tone === 'danger' ? 'danger' : undefined }))) return
    const reason = (await prompt({ title: 'Reason required', message: `Reason for "${action}":`, required: true }))?.trim()
    if (!reason) return
    await postLicense(action, { ...extra, reason })
  }

  async function promptDays(action: 'extendExpiry' | 'reduceExpiry') {
    const v = (await prompt({ title: action === 'extendExpiry' ? 'Extend expiry' : 'Reduce expiry', message: 'New expiry window in days from now:', placeholder: 'e.g. 30' }))?.trim()
    if (!v) return
    const n = Number(v)
    if (!Number.isInteger(n) || n <= 0) { setErr('Days must be a positive integer'); return }
    await withReason(action, { expiryDays: n })
  }

  async function promptTier(action: 'upgrade' | 'downgrade') {
    const tier = (await prompt({ title: 'Select tier', message: `Target tier (${EVENT_LICENSE_TIERS.join(' / ')}):`, placeholder: EVENT_LICENSE_TIERS.join(' / ') }))?.trim() as EventLicenseTier
    if (!EVENT_LICENSE_TIERS.includes(tier)) { if (tier) setErr('Invalid tier'); return }
    await withReason(action, { tier })
  }

  // ── Review actions (POST …/review) ──
  async function review(action: 'approve' | 'reject' | 'request_changes') {
    const key = `review:${action}`
    let extra: Record<string, string> = {}
    if (action === 'reject') {
      const reason = (await prompt({ title: 'Reject event', message: 'Rejection reason (min 3 chars):', required: true }))?.trim()
      if (!reason || reason.length < 3) return
      extra = { reason }
    } else if (action === 'request_changes') {
      const comment = (await prompt({ title: 'Request changes', message: 'Describe the requested changes (min 3 chars):', required: true, multiline: true }))?.trim()
      if (!comment || comment.length < 3) return
      extra = { comment }
    } else if (!(await confirm({ message: 'Approve and publish this event?' }))) return

    setBusy(key); setErr(null)
    try {
      const token = await getToken()
      const res = await fetch(`/api/admin/events/${slug}/review`, {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ action, ...extra }),
      })
      if (!res.ok) { const b = await res.json().catch(() => null) as { error?: string } | null; throw new Error(b?.error ?? `Request failed (${res.status})`) }
      afterMutation()
    } catch (e) { setErr(e instanceof Error ? e.message : 'Review failed') } finally { setBusy(null) }
  }

  // ── Moderation actions (PATCH …/[slug]) ──
  async function moderate(action: 'take_down' | 'restore' | 'under_review') {
    const key = `mod:${action}`
    const danger = action === 'take_down'
    if (!(await confirm({ message: `${action.replace('_', ' ')} this event?`, tone: danger ? 'danger' : undefined }))) return
    const reason = (await prompt({ title: 'Reason', message: `Reason for ${action.replace('_', ' ')}:`, required: action !== 'restore' }))?.trim() ?? ''
    setBusy(key); setErr(null)
    try {
      const token = await getToken()
      const res = await fetch(`/api/admin/events/${slug}`, {
        method: 'PATCH', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ action, reason }),
      })
      if (!res.ok) { const b = await res.json().catch(() => null) as { error?: string } | null; throw new Error(b?.error ?? `Request failed (${res.status})`) }
      afterMutation()
    } catch (e) { setErr(e instanceof Error ? e.message : 'Moderation failed') } finally { setBusy(null) }
  }

  const reviewable = o.reviewStatus === 'pending_review'
  const overrides = gov?.baseline?.overrides

  return (
    <div className="space-y-4">
      {err && <ErrorBanner>{err}</ErrorBanner>}

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Lifecycle review */}
        <Card title="Lifecycle review" icon={BadgeCheck}>
          <div className="space-y-3 p-4">
            <p className="text-[12.5px] text-muted-foreground">
              {reviewable ? 'This event is awaiting review.' : `Review status: ${o.reviewStatus ?? '—'} (only a pending-review event can be reviewed).`}
            </p>
            <div className="flex flex-wrap gap-2">
              <Act icon={CheckCircle2} label="Approve" tone="emerald" disabled={!reviewable} busy={busy === 'review:approve'} onClick={() => void review('approve')} />
              <Act icon={XCircle} label="Reject" tone="red" disabled={!reviewable} busy={busy === 'review:reject'} onClick={() => void review('reject')} />
              <Act icon={RotateCcw} label="Request changes" tone="amber" disabled={!reviewable} busy={busy === 'review:request_changes'} onClick={() => void review('request_changes')} />
            </div>
          </div>
        </Card>

        {/* Moderation */}
        <Card title="Moderation" icon={ShieldAlert}>
          <div className="space-y-3 p-4">
            <p className="text-[12.5px] text-muted-foreground">Current: {o.moderationStatus ?? 'active'}</p>
            <div className="flex flex-wrap gap-2">
              <Act icon={Ban} label="Take down" tone="red" busy={busy === 'mod:take_down'} onClick={() => void moderate('take_down')} />
              <Act icon={PlayCircle} label="Restore" tone="emerald" busy={busy === 'mod:restore'} onClick={() => void moderate('restore')} />
              <Act icon={Activity} label="Under review" tone="amber" busy={busy === 'mod:under_review'} onClick={() => void moderate('under_review')} />
            </div>
          </div>
        </Card>
      </div>

      {/* Publish governance baseline */}
      <Card title="Publish governance" icon={Fingerprint}>
        <div className="space-y-3 p-4 text-[13.5px]">
          {gov === null ? <CenterSpin /> : gov.baseline ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <StatusPill tone="neutral">{gov.baseline.publishCount} publish(es)</StatusPill>
                {overrides?.publish && <StatusPill tone="info">publish override</StatusPill>}
                {overrides?.identity && <StatusPill tone="info">identity override</StatusPill>}
                {overrides?.registrationSafety && <StatusPill tone="info">reg-safety override</StatusPill>}
              </div>
              <dl className="grid grid-cols-2 gap-2">
                <Row label="Baseline name" value={gov.baseline.identity?.name ?? '—'} />
                <Row label="Baseline city" value={gov.baseline.identity?.city ?? '—'} />
                <Row label="Baseline type" value={gov.baseline.identity?.eventType ?? '—'} />
                <Row label="First published" value={fmtDate(gov.baseline.firstPublishedAt)} />
              </dl>
            </>
          ) : (
            <p className="text-muted-foreground">No governance baseline yet — captured on first governed publish.</p>
          )}
        </div>
      </Card>

      {/* License actions — the full EA-4 set incl. the 8 API-only actions */}
      <Card title="License actions" icon={KeyRound}>
        <div className="space-y-3 p-4">
          <div className="flex flex-wrap gap-2">
            {o.license?.displayStatus === 'active'
              ? <Act icon={PauseCircle} label="Suspend" tone="amber" busy={busy === 'suspend'} onClick={() => void withReason('suspend')} />
              : <Act icon={PlayCircle} label="Reactivate" tone="emerald" busy={busy === 'reactivate'} onClick={() => void withReason('reactivate', {}, 'Reactivate this license?')} />}
            <Act icon={XCircle} label="Cancel" tone="red" busy={busy === 'cancel'} onClick={() => void withReason('cancel', {}, 'Cancel this license?', 'danger')} />
            <Act icon={ArrowUpCircle} label="Upgrade" busy={busy === 'upgrade'} onClick={() => void promptTier('upgrade')} />
            <Act icon={ArrowDownCircle} label="Downgrade" busy={busy === 'downgrade'} onClick={() => void promptTier('downgrade')} />
            <Act icon={BadgeCheck} label="Mark paid" tone="emerald" busy={busy === 'markPaymentReceived'} onClick={() => void withReason('markPaymentReceived', {}, 'Mark payment as received?')} />
            <Act icon={Undo2} label="Refund" tone="red" busy={busy === 'refund'} onClick={() => void withReason('refund', {}, 'Refund and cancel this license?', 'danger')} />
            <Act icon={RefreshCw} label="Reissue" busy={busy === 'reissue'} onClick={() => void withReason('reissue', {}, 'Reissue this license?')} />
          </div>

          <div>
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Expiry &amp; consumption (API-only actions)</p>
            <div className="flex flex-wrap gap-2">
              <Act icon={CalendarPlus} label="Extend expiry" busy={busy === 'extendExpiry'} onClick={() => void promptDays('extendExpiry')} />
              <Act icon={CalendarMinus} label="Reduce expiry" busy={busy === 'reduceExpiry'} onClick={() => void promptDays('reduceExpiry')} />
              <Act icon={CalendarX} label="Disable expiry" busy={busy === 'disableExpiry'} onClick={() => void withReason('disableExpiry', {}, 'Make this license perpetual (never expire)?')} />
              <Act icon={Zap} label="Force consume" tone="amber" busy={busy === 'forceConsume'} onClick={() => void withReason('forceConsume', {}, 'Force-consume this license, binding it to the event identity?', 'danger')} />
              <Act icon={RotateCcw} label="Reset license" tone="red" busy={busy === 'resetLicense'} onClick={() => void withReason('resetLicense', {}, 'Reset this license (clears consumption + binding)? This is a powerful action.', 'danger')} />
            </div>
          </div>

          <div>
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Governance overrides (API-only actions)</p>
            <div className="flex flex-wrap gap-2">
              <Act icon={Unlock} label={overrides?.publish ? 'Clear publish override' : 'Override publish'} busy={busy === 'overridePublish'} onClick={() => void withReason('overridePublish', { overrideEnabled: !overrides?.publish }, overrides?.publish ? 'Clear the force-publish override?' : 'Force-publish: bypass ALL governance for this event?', 'danger')} />
              <Act icon={Fingerprint} label={overrides?.identity ? 'Clear identity override' : 'Override identity'} busy={busy === 'overrideIdentity'} onClick={() => void withReason('overrideIdentity', { overrideEnabled: !overrides?.identity }, overrides?.identity ? 'Clear the identity-validation override?' : 'Bypass identity validation for this event?', 'danger')} />
              <Act icon={ShieldAlert} label={overrides?.registrationSafety ? 'Clear reg-safety override' : 'Override reg-safety'} busy={busy === 'overrideRegistrationSafety'} onClick={() => void withReason('overrideRegistrationSafety', { overrideEnabled: !overrides?.registrationSafety }, overrides?.registrationSafety ? 'Clear the registration-safety override?' : 'Bypass the registration-safety escalation?', 'danger')} />
            </div>
          </div>

          <Link href="/admin/licenses" className="inline-flex items-center gap-1.5 text-[12.5px] font-medium text-primary hover:underline">
            <ExternalLink className="size-3.5" /> Open full License Console
          </Link>
        </div>
      </Card>

      {/* Merged timeline */}
      <Card title="Timeline" icon={ScrollText}>
        <div className="p-4">
          {timeline === null ? <CenterSpin /> : timeline.length === 0 ? <Empty>No history yet.</Empty> : (
            <ol className="space-y-2">
              {timeline.map(t => (
                <li key={t.id} className="rounded-lg border border-border bg-muted/30 px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="inline-flex items-center gap-2">
                      <StatusPill tone={TIMELINE_TONE[t.source]}>{t.source}</StatusPill>
                      <span className="font-medium capitalize text-foreground">{t.action.replace(/[._]/g, ' ')}</span>
                    </span>
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

const TIMELINE_TONE: Record<Event360TimelineEntry['source'], PillTone> = {
  lifecycle: 'neutral', audit: 'info', license: 'accent', governance: 'warning', moderation: 'danger',
}

// ─── Shared primitives ─────────────────────────────────────────────────────────

const btnOutline = 'inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-[13px] font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50'

function CenterSpin() {
  return <div className="flex justify-center py-16"><Loader2 className="size-6 animate-spin text-muted-foreground" /></div>
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-[13px] text-muted-foreground">{children}</p>
}

function AnalyticsGate({ loading, error, data, onRetry, children }: {
  loading: boolean; error: string | null; data: EventAnalytics | null
  onRetry: () => void; children: (a: EventAnalytics) => React.ReactNode
}) {
  if (error) return <div className="space-y-3"><ErrorBanner>{error}</ErrorBanner><button onClick={onRetry} className={btnOutline}><RefreshCw className="size-3.5" /> Retry</button></div>
  if (loading || !data) return <CenterSpin />
  return <>{children(data)}</>
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

function Row({ label, value, icon: Icon, mono }: { label: string; value: string; icon?: typeof Users; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="inline-flex items-center gap-1.5 shrink-0 text-[12.5px] text-muted-foreground">{Icon && <Icon className="size-3.5" aria-hidden />}{label}</dt>
      <dd className={cn('min-w-0 truncate text-right font-medium text-foreground', mono && 'font-mono text-[12px]')} title={value}>{value}</dd>
    </div>
  )
}

function DeepLink({ href, label }: { href: string; label: string }) {
  return (
    <Link href={href} className={cn(btnOutline, 'justify-between')}>
      <span>{label}</span><ExternalLink className="size-3.5 text-muted-foreground" />
    </Link>
  )
}

function Act({ icon: Icon, label, onClick, busy, disabled, tone }: {
  icon: typeof KeyRound; label: string; onClick: () => void; busy?: boolean; disabled?: boolean
  tone?: 'emerald' | 'amber' | 'red'
}) {
  const toneCls = tone === 'emerald' ? 'hover:border-emerald-300 hover:bg-emerald-50 hover:text-emerald-700'
    : tone === 'amber' ? 'hover:border-amber-300 hover:bg-amber-50 hover:text-amber-700'
    : tone === 'red' ? 'hover:border-red-300 hover:bg-red-50 hover:text-red-700'
    : 'hover:bg-muted'
  return (
    <button onClick={onClick} disabled={busy || disabled}
      className={cn('inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-[12.5px] font-medium text-foreground transition-colors disabled:opacity-40', toneCls)}>
      {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Icon className="size-3.5" />}{label}
    </button>
  )
}
