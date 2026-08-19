'use client'

// Phase H.2.1 — Organizer executive dashboard.
//
// A premium, connected overview composed entirely from the EXISTING
// /api/organizer/dashboard aggregation endpoint (one request, no new Firestore
// reads). All sections are derived client-side from that single payload using the
// reusable workspace components (MetricCard, ActivityTimeline, AttentionPanel,
// EventSwitcher, DashboardCard). No fake or hardcoded data.

import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import type { LucideIcon } from 'lucide-react'
import {
  Ticket, Banknote, Wallet, CalendarDays,
  Flame, Award, Clock, CreditCard, MailWarning, Plus, CheckCircle2, Circle,
  Megaphone, Send, Users as UsersIcon, Activity as ActivityIcon,
  TrendingUp, TrendingDown, Sparkles, AlertTriangle, ScanLine, BarChart3, ArrowRight,
} from 'lucide-react'
import { auth } from '@/lib/firebase/auth'
import { cn } from '@/lib/utils/cn'
import { isChannelImplemented } from '@/lib/communications/health/channels'
import { isEventLicenseTier, isEventLicenseTierV2 } from '@/lib/licensing/eventLicense'
import { useLicenseCatalog, useLicenseCatalogV2 } from '@/lib/licensing/licenseCatalogClient'
import { formatINR } from '@/components/event-templates/shared/utils/format'
import { CREATE_EVENT_HREF } from '@/config/workspaceNav'
import { MetricCard } from '@/components/dashboard/MetricCard'
import { ActivityTimeline, type ActivityItem } from '@/components/dashboard/ActivityTimeline'
import { AttentionPanel, type AttentionItem } from '@/components/dashboard/AttentionPanel'
import { EventSwitcher, type SwitchableEvent } from '@/components/dashboard/EventSwitcher'
import { DashboardCard } from '@/components/dashboard/DashboardCard'
import { EmptyState, ErrorState } from '@/components/dashboard/EmptyState'
import { KpiCardSkeleton, ChartSkeleton, Skeleton } from '@/components/dashboard/Skeleton'
import type { ChartPoint } from '@/components/analytics/Charts'
import type { DashboardData } from '@/app/api/organizer/dashboard/route'

// Charts are code-split: the SVG primitives load only after the dashboard payload
// arrives, keeping the initial bundle light (perf: lazy-load charts).
const DashboardCharts = lazy(() => import('@/components/dashboard/DashboardCharts'))

// ─── Helpers ──────────────────────────────────────────────────────────────────

const rupees = (paise: number) => formatINR(Math.round(paise) / 100)

function todayYmd(): string {
  const n = new Date()
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`
}

const STATUS_LABEL: Record<string, string> = {
  published:           'Live',
  registration_closed: 'Closed',
  completed:           'Ended',
  pending_review:      'Pending',
  changes_requested:   'Changes',
  draft:               'Draft',
}
const STATUS_STYLE: Record<string, string> = {
  published:           'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  registration_closed: 'bg-amber-50 text-amber-700 ring-amber-600/20',
  completed:           'bg-slate-100 text-slate-600 ring-slate-500/20',
  pending_review:      'bg-amber-50 text-amber-700 ring-amber-600/20',
  changes_requested:   'bg-orange-50 text-orange-700 ring-orange-600/20',
  draft:               'bg-slate-100 text-slate-600 ring-slate-500/20',
}

function greeting(): string {
  const h = new Date().getHours()
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'
}

// Truthful percentage delta — returns undefined when there is no real prior value to
// compare against (so MetricCard shows no fake trend). Only ever called with real
// historical series (trendDays).
function pctDelta(curr: number, prev: number): { text: string; trend: 'up' | 'down' | 'flat' } | undefined {
  if (prev <= 0) return undefined
  const pct = Math.round(((curr - prev) / prev) * 100)
  if (pct === 0) return { text: '0%', trend: 'flat' }
  return { text: `${pct > 0 ? '+' : ''}${pct}%`, trend: pct > 0 ? 'up' : 'down' }
}

// "2026-07-25" → "25/07" for compact chart axis labels.
function shortDate(ymd: string): string {
  const [, m, d] = ymd.split('-')
  return d && m ? `${d}/${m}` : ymd
}

interface Insight { tone: 'positive' | 'negative' | 'warning' | 'info'; icon: LucideIcon; text: string }

// Insight tone → token-driven accent (colour communicates meaning only):
// positive/revenue = green, negative/problem = red, warning = amber, info/analytics = violet.
const INSIGHT_TONE: Record<Insight['tone'], { icon: string; bg: string }> = {
  positive: { icon: 'text-emerald-600', bg: 'bg-emerald-50' },
  negative: { icon: 'text-rose-600',    bg: 'bg-rose-50' },
  warning:  { icon: 'text-amber-600',   bg: 'bg-amber-50' },
  info:     { icon: 'text-violet-600',  bg: 'bg-violet-50' },
}

// Premium quick-action cards — every href is an EXISTING route. Colour by meaning:
// green = money/create, blue = registrations, violet = comms/analytics, amber = ops.
const QUICK_ACTIONS: { label: string; href: string; icon: LucideIcon; tint: string }[] = [
  { label: 'Create event',  href: CREATE_EVENT_HREF,                        icon: Plus,       tint: 'text-emerald-700 bg-emerald-50' },
  { label: 'Registrations', href: '/dashboard/registrations',               icon: Ticket,     tint: 'text-sky-700 bg-sky-50' },
  { label: 'Broadcast',     href: '/dashboard/communications/broadcasts',   icon: Megaphone,  tint: 'text-violet-700 bg-violet-50' },
  { label: 'Check-in',      href: '/dashboard/check-in',                     icon: ScanLine,   tint: 'text-amber-700 bg-amber-50' },
  { label: 'Reports',       href: '/dashboard/reports',                      icon: BarChart3,  tint: 'text-fuchsia-700 bg-fuchsia-50' },
  { label: 'Finance',       href: '/dashboard/finance',                      icon: Banknote,   tint: 'text-emerald-700 bg-emerald-50' },
]

// Feature flag — the "Platform updates" widget is built but not yet enabled for
// organizers. Kept in the tree (not deleted) so a future release can flip this
// to true and reuse the widget as-is. While false it is hidden entirely — no
// "Coming soon" placeholder is shown. Typed as boolean so the render guard is
// not a constant expression.
const PLATFORM_UPDATES_ENABLED: boolean = false

// ─── Page ───────────────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const [data,    setData]    = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)
  // Tier display name from the effective (config-aware) catalog — resolves a V1 OR V2 tier
  // (RD-LICENSE-GA-03), unknown → as-is.
  const catalog   = useLicenseCatalog()
  const catalogV2 = useLicenseCatalogV2()
  const tierName  = (tier: string): string =>
    isEventLicenseTier(tier) ? catalog[tier].name
    : isEventLicenseTierV2(tier) ? catalogV2[tier].name
    : tier

  const load = useCallback(async () => {
    const u = auth.currentUser
    if (!u) { setError('Not authenticated'); setLoading(false); return }
    setLoading(true); setError(null)
    try {
      const token = await u.getIdToken()
      const res = await fetch('/api/organizer/dashboard', {
        headers: { authorization: `Bearer ${token}` },
        cache:   'no-store',
      })
      if (!res.ok) throw new Error(`Request failed (${res.status})`)
      setData(await res.json() as DashboardData)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load dashboard')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { const t = setTimeout(() => void load(), 0); return () => clearTimeout(t) }, [load])

  // ── Derived view models (memoized — no recompute unless data changes) ────────

  const activity = useMemo<ActivityItem[]>(() => {
    if (!data) return []
    return data.activity.map((a, i) => ({
      id:          `act-${i}-${a.timestamp}`,
      kind:        a.type === 'checkin' ? 'checkin' : 'registration',
      title:       a.type === 'checkin' ? `${a.attendeeName} checked in` : `${a.attendeeName} registered`,
      description: [a.eventName, a.passName].filter(Boolean).join(' · '),
      timestamp:   a.timestamp,
    }))
  }, [data])

  const attention = useMemo<AttentionItem[]>(() => {
    if (!data) return []
    const items: AttentionItem[] = []

    data.alerts.forEach((a, i) => {
      const icon = a.type === 'nearly_full' ? Flame
        : a.type === 'cert_missing'     ? Award
        : a.type === 'reg_closing_soon' ? Clock
        : CreditCard
      const category = a.type === 'comm_payment_pending' ? 'financial' as const
        : a.type === 'cert_missing' ? 'certificates' as const
        : 'registrations' as const
      items.push({
        id: `alert-${i}`, severity: a.severity, title: a.title, meta: a.meta, icon,
        href: '/dashboard/events', category,
      })
    })

    if (data.walletBalancePaise < 10_000) {
      items.push({
        id: 'wallet-low', severity: 'warning', title: 'Wallet balance is low',
        meta: `${rupees(data.walletBalancePaise)} remaining`, icon: Wallet, href: '/dashboard/wallet',
        category: 'financial',
      })
    }
    if (data.communications.emailsFailedToday > 0) {
      items.push({
        id: 'email-failed', severity: 'warning',
        title: `${data.communications.emailsFailedToday} email${data.communications.emailsFailedToday > 1 ? 's' : ''} failed today`,
        meta: 'Review delivery in Communications', icon: MailWarning, href: '/dashboard/communications/email-logs',
        category: 'broadcasts',
      })
    }
    // Events needing review action — surfaced from the summary endpoint.
    data.actionEvents.forEach(e => {
      if (e.reviewStatus === 'rejected') {
        items.push({ id: `rej-${e.draftId}`, severity: 'critical', title: `${e.name} was not approved`,
          meta: 'Review the reason and resubmit', icon: MailWarning, href: '/dashboard/events', category: 'registrations' })
      } else if (e.lifecycleStatus === 'changes_requested' || e.reviewStatus === 'changes_requested') {
        items.push({ id: `chg-${e.draftId}`, severity: 'warning', title: `${e.name} — changes requested`,
          meta: 'Update your event and resubmit', icon: MailWarning, href: '/dashboard/events', category: 'registrations' })
      } else if (e.lifecycleStatus === 'pending_review') {
        items.push({ id: `pnd-${e.draftId}`, severity: 'info', title: `${e.name} is pending approval`,
          meta: 'Awaiting admin review', icon: Clock, href: `/dashboard/events/${e.draftId}`, category: 'registrations' })
      }
    })

    const today = todayYmd()
    data.events.forEach(e => {
      if (e.startDate && e.startDate.slice(0, 10) === today && e.lifecycleStatus !== 'completed') {
        items.push({
          id: `starts-${e.draftId}`, severity: 'info', title: `${e.name} starts today`,
          meta: `${e.registered} registered`, icon: CalendarDays, href: `/dashboard/events/${e.draftId}`,
          category: 'registrations',
        })
      }
    })
    return items
  }, [data])

  const switchable = useMemo<SwitchableEvent[]>(
    () => (data?.events ?? []).map(e => ({ draftId: e.draftId, name: e.name, lifecycleStatus: e.lifecycleStatus })),
    [data],
  )

  const upcoming = useMemo(() => {
    if (!data) return []
    return [...data.events]
      .filter(e => e.lifecycleStatus !== 'completed')
      .sort((a, b) => (a.startDate ?? '').localeCompare(b.startDate ?? ''))
      .slice(0, 6)
  }, [data])

  // Chart series — derived ONCE from the single payload (memoized). All presentational
  // arrays are handed to the lazy DashboardCharts; no calculation is duplicated there.
  const charts = useMemo(() => {
    if (!data) return null
    const td     = data.trendDays
    const last30 = td.slice(Math.max(0, td.length - 30))
    return {
      revenueTrend:   last30.map(d => ({ label: shortDate(d.date), value: Math.round(d.revenuePaise / 100) } as ChartPoint)),
      regTrend:       last30.map(d => ({ label: shortDate(d.date), value: d.count } as ChartPoint)),
      passDist:       data.passDistribution.map(p => ({ label: p.label, value: p.count } as ChartPoint)),
      passRows:       data.passDistribution,
      regStatus:      data.registrationStatus.map(s => ({ label: s.label, value: s.count } as ChartPoint)),
      // Server-computed: the SAME organizer-wide event scope and the SAME confirmed figures
      // the two breakdowns use, already Top-N with a real "Other". The old client-side
      // `.slice(0, 6)` over `data.events` did neither — it ranked a DIFFERENT event set
      // (current lifecycle status only, so an unpublished event's registrations counted in
      // the totals while its row was invisible) and silently discarded the 7th onward.
      eventPerf:      data.eventPerformance.map(e => ({ label: e.label, value: e.count } as ChartPoint)),
      revenue30Paise: last30.reduce((s, d) => s + d.revenuePaise, 0),
      regs30:         last30.reduce((s, d) => s + d.count, 0),
    }
  }, [data])

  // Real-data insights — each card is emitted ONLY when its condition genuinely holds.
  // No placeholder/AI text; every claim is backed by the payload.
  const insights = useMemo<Insight[]>(() => {
    if (!data) return []
    const out: Insight[] = []
    const td = data.trendDays
    if (td.length >= 14) {
      const last7 = td.slice(td.length - 7).reduce((s, d) => s + d.count, 0)
      const prev7 = td.slice(td.length - 14, td.length - 7).reduce((s, d) => s + d.count, 0)
      if (prev7 > 0) {
        const pct = Math.round(((last7 - prev7) / prev7) * 100)
        if (Math.abs(pct) >= 5) {
          out.push({
            tone: pct > 0 ? 'positive' : 'negative',
            icon: pct > 0 ? TrendingUp : TrendingDown,
            text: `Registrations ${pct > 0 ? 'increased' : 'dropped'} ${Math.abs(pct)}% vs the previous week — ${last7} in the last 7 days.`,
          })
        }
      }
    }
    const topPass = data.passDistribution[0]
    if (topPass && topPass.count > 0 && data.passDistribution.length > 1) {
      // "recent" was wrong: this figure is organizer-wide and all-time, from the counters.
      out.push({ tone: 'info', icon: Sparkles, text: `“${topPass.label}” is your most-registered pass — ${topPass.count} confirmed across all events.` })
    }
    const hot = [...data.events].filter(e => e.capacity && e.fillPct >= 90).sort((a, b) => b.fillPct - a.fillPct)[0]
    if (hot) {
      out.push({ tone: 'positive', icon: Flame, text: `“${hot.name}” is ${hot.fillPct}% full — nearly sold out.` })
    }
    if (data.overview.todayRegistrations === 0 && data.overview.activeEvents > 0) {
      out.push({ tone: 'warning', icon: AlertTriangle, text: 'No registrations yet today across your live events.' })
    }
    return out.slice(0, 4)
  }, [data])

  // Revenue-today delta vs yesterday — the one hero delta backed by a like-for-like
  // daily comparison from trendDays (revenue per day). Omitted when yesterday was ₹0.
  const revenueTodayDelta = useMemo(() => {
    if (!data || data.trendDays.length < 2) return undefined
    const td = data.trendDays
    return pctDelta(td[td.length - 1].revenuePaise, td[td.length - 2].revenuePaise)
  }, [data])

  // ── Header (always rendered, even while loading) ─────────────────────────────
  const header = (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="text-[32px] font-bold leading-tight tracking-tight text-foreground">
          {greeting()}{data?.organizer.name ? `, ${data.organizer.name.split(' ')[0]}` : ''}
        </h1>
        <p className="mt-0.5 text-[14px] text-muted-foreground">
          Manage your events, approvals, participants and finances.
        </p>
      </div>
      <div className="flex items-center gap-2">
        <EventSwitcher events={switchable} />
        <Link
          href="/dashboard/wallet"
          className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-border px-3.5 text-[14px] font-semibold text-foreground transition-colors hover:bg-muted"
        >
          <Wallet className="size-4" aria-hidden /> Top up wallet
        </Link>
        <Link
          href={CREATE_EVENT_HREF}
          className="inline-flex h-9 items-center gap-1.5 rounded-xl px-3.5 text-[14px] font-semibold text-primary-foreground shadow-sm transition-opacity hover:opacity-90"
          style={{ backgroundImage: 'var(--primary-gradient)' }}
        >
          <Plus className="size-4" aria-hidden /> Create event
        </Link>
      </div>
    </div>
  )

  if (loading && !data) {
    return (
      <div className="space-y-6">
        {header}
        {/* Hero KPIs (6) */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
          {Array.from({ length: 6 }).map((_, i) => <KpiCardSkeleton key={i} />)}
        </div>
        {/* Charts — two wide + three panels (mirrors the loaded layout) */}
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-xl border border-border bg-card shadow-sm"><ChartSkeleton /></div>
          <div className="rounded-xl border border-border bg-card shadow-sm"><ChartSkeleton /></div>
        </div>
        <div className="grid gap-4 lg:grid-cols-3">
          <div className="rounded-xl border border-border bg-card shadow-sm"><ChartSkeleton /></div>
          <div className="rounded-xl border border-border bg-card shadow-sm"><ChartSkeleton /></div>
          <div className="rounded-xl border border-border bg-card shadow-sm"><ChartSkeleton /></div>
        </div>
        {/* Main two-column card layout */}
        <div className="grid gap-4 lg:grid-cols-3">
          <div className="space-y-4 lg:col-span-2">
            <Skeleton className="h-56 rounded-xl" />
            <Skeleton className="h-72 rounded-xl" />
          </div>
          <div className="space-y-4">
            <Skeleton className="h-40 rounded-xl" />
            <Skeleton className="h-40 rounded-xl" />
            <Skeleton className="h-44 rounded-xl" />
          </div>
        </div>
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="space-y-6">
        {header}
        <div className="rounded-2xl border border-border bg-card">
          <ErrorState message={error ?? 'No data available.'} onRetry={() => void load()} />
        </div>
      </div>
    )
  }

  const { overview, settlement, communications, healthScore } = data
  // Defaulted rather than asserted: a degraded aggregation (or a payload cached from before
  // this field existed) must leave the rest of the dashboard rendering.
  //
  // The fallback is written out here rather than imported from lib/analytics/couponPerformance
  // ON PURPOSE. That module imports firebase-admin for its reader half, and this is a
  // 'use client' page — importing a value from it drags the Admin SDK into the browser bundle
  // (the build fails on `child_process`). Only its TYPE crosses the boundary, via DashboardData,
  // and types are erased at compile time.
  const coupons = data.couponPerformance ?? {
    totalRedemptions: 0, totalDiscountPaise: 0, activeCoupons: 0, totalCoupons: 0,
    rows: [], discountUnavailable: false, partial: false,
  }

  return (
    <div className="space-y-6">
      {header}

      {/* ── Hero KPIs — the 10-second read of the business ── */}
      {/* Six premium tiles from the single payload. Colour communicates meaning:
          green = revenue, blue = registrations, violet = events, amber = attention.
          Only Revenue today carries a delta (real like-for-like vs yesterday). */}
      <section aria-label="Key metrics" className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        <MetricCard label="Revenue today" value={rupees(overview.todayRevenuePaise)}
          hint={revenueTodayDelta ? 'vs yesterday' : 'Today'} delta={revenueTodayDelta}
          icon={Banknote} iconColor="text-emerald-700" iconBg="bg-emerald-50" href="/dashboard/finance" />
        <MetricCard label="Revenue this month" value={rupees(overview.monthRevenuePaise)} hint="Month to date"
          icon={TrendingUp} iconColor="text-emerald-700" iconBg="bg-emerald-50" href="/dashboard/finance" />
        <MetricCard label="Total registrations" value={overview.totalRegistrations.toLocaleString('en-IN')} hint="All-time"
          icon={Ticket} iconColor="text-sky-700" iconBg="bg-sky-50" href="/dashboard/registrations" />
        <MetricCard label="Active events" value={overview.activeEvents.toLocaleString('en-IN')} hint="Live now"
          icon={CalendarDays} iconColor="text-violet-700" iconBg="bg-violet-50" href="/dashboard/events" />
        <MetricCard label="Pending review" value={data.licenseSummary.pendingApproval.toLocaleString('en-IN')} hint="Awaiting approval"
          icon={Clock} iconColor="text-amber-700" iconBg="bg-amber-50" href="/dashboard/events" />
        <MetricCard label="Wallet balance" value={rupees(data.walletBalancePaise)} hint="Available"
          icon={Wallet} iconColor="text-primary" iconBg="bg-primary/10" href="/dashboard/wallet" />
      </section>

      {/* ── Insights — real-data highlights (rendered only when something is true) ── */}
      {insights.length > 0 && (
        <section aria-label="Insights" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {insights.map((ins, i) => {
            const Icon = ins.icon
            const tone = INSIGHT_TONE[ins.tone]
            return (
              <div key={i} className="flex items-start gap-3 rounded-2xl border border-border bg-card p-4 shadow-sm">
                <div className={cn('flex size-8 shrink-0 items-center justify-center rounded-lg', tone.bg)}>
                  <Icon className={cn('size-4', tone.icon)} aria-hidden />
                </div>
                <p className="text-[13px] leading-snug text-foreground">{ins.text}</p>
              </div>
            )
          })}
        </section>
      )}

      {/* ── Charts — lazy-loaded, real data, graceful degrade ── */}
      {charts && (
        <Suspense fallback={
          <div className="space-y-4">
            <div className="grid gap-4 lg:grid-cols-2">
              <div className="rounded-xl border border-border bg-card shadow-sm"><ChartSkeleton /></div>
              <div className="rounded-xl border border-border bg-card shadow-sm"><ChartSkeleton /></div>
            </div>
            <div className="grid gap-4 lg:grid-cols-3">
              <div className="rounded-xl border border-border bg-card shadow-sm"><ChartSkeleton /></div>
              <div className="rounded-xl border border-border bg-card shadow-sm"><ChartSkeleton /></div>
              <div className="rounded-xl border border-border bg-card shadow-sm"><ChartSkeleton /></div>
            </div>
          </div>
        }>
          <DashboardCharts
            revenueTrend={charts.revenueTrend}
            regTrend={charts.regTrend}
            passDist={charts.passDist}
            passRows={charts.passRows}
            regStatus={charts.regStatus}
            regTotals={data.registrationTotals}
            passCancelledUnavailable={data.passCancelledUnavailable}
            eventPerf={charts.eventPerf}
            revenue30Paise={charts.revenue30Paise}
            regs30={charts.regs30}
          />
        </Suspense>
      )}

      {/* ── Quick actions — premium cards to existing routes ── */}
      <section aria-label="Quick actions">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {QUICK_ACTIONS.map(a => {
            const Icon = a.icon
            return (
              <Link key={a.label} href={a.href}
                className="group flex flex-col items-start gap-2.5 rounded-2xl border border-border bg-card p-4 shadow-sm transition-colors hover:border-primary/30 hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
                <div className={cn('flex size-9 items-center justify-center rounded-xl', a.tint)}>
                  <Icon className="size-[17px]" aria-hidden />
                </div>
                <span className="flex items-center gap-1 text-[13px] font-semibold text-foreground">
                  {a.label}
                  <ArrowRight className="size-3 text-muted-foreground/40 transition-colors group-hover:text-foreground" aria-hidden />
                </span>
              </Link>
            )
          })}
        </div>
      </section>

      {/* ── Main grid ── */}
      <div className="grid gap-4 lg:grid-cols-3">

        {/* Left column (2/3) */}
        <div className="space-y-4 lg:col-span-2">
          <DashboardCard title="Needs attention">
            <AttentionPanel items={attention} grouped />
          </DashboardCard>

          <DashboardCard title="Live activity" viewHref="/dashboard/registrations" viewLabel="View registrations">
            <ActivityTimeline items={activity} limit={12}
              emptyTitle="No recent activity"
              emptyDescription="Registrations and check-ins will stream in here." />
          </DashboardCard>

          <DashboardCard title="Recent events" viewHref="/dashboard/events">
            {upcoming.length === 0 ? (
              <EmptyState icon={CalendarDays} title="No events yet"
                description="Create an event to start taking registrations."
                action={{ label: 'Create event', href: CREATE_EVENT_HREF }} />
            ) : (
              <ul className="divide-y divide-border">
                {upcoming.map(e => (
                  <li key={e.draftId}>
                    <Link href={`/dashboard/events/${e.draftId}`}
                      className="flex items-center gap-4 px-5 py-3.5 transition-colors hover:bg-muted/40">
                      {e.bannerUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={e.bannerUrl} alt="" className="h-10 w-14 shrink-0 rounded-lg object-cover" />
                      ) : (
                        <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted">
                          <CalendarDays className="size-4 text-muted-foreground" aria-hidden />
                        </div>
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <p className="truncate text-[14px] font-medium text-foreground">{e.name}</p>
                          <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1', STATUS_STYLE[e.lifecycleStatus] ?? STATUS_STYLE.completed)}>
                            {STATUS_LABEL[e.lifecycleStatus] ?? e.lifecycleStatus}
                          </span>
                          <span className="rounded-full bg-muted px-1.5 py-0.5 text-[11px] font-semibold text-muted-foreground">{tierName(e.licenseTier)}</span>
                        </div>
                        <p className="mt-0.5 truncate text-[12px] text-muted-foreground">
                          {e.registered} registered{e.capacity ? ` · ${e.fillPct}% full` : ''}{e.revenuePaise > 0 ? ` · ${rupees(e.revenuePaise)}` : ''}{e.startDate ? ` · ${e.startDate.slice(0, 10)}` : ''}
                        </p>
                        {e.capacity ? (
                          <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                            <div className="h-full rounded-full bg-primary" style={{ width: `${Math.min(100, e.fillPct)}%` }} aria-hidden />
                          </div>
                        ) : null}
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </DashboardCard>
        </div>

        {/* Right column (1/3) */}
        <div className="space-y-4">
          <DashboardCard title="Settlement summary" viewHref="/dashboard/finance">
            <dl className="divide-y divide-border">
              <MoneyRow label="Gross revenue"        value={rupees(settlement.grossRevenuePaise)} />
              <MoneyRow label={`Platform & gateway fees (${(settlement.platformFeeRateBps / 100).toFixed(1)}%)`} value={`– ${rupees(settlement.platformFeePaise)}`} muted />
              <MoneyRow label="Net revenue"          value={rupees(settlement.netPayoutPaise)} strong />
            </dl>
          </DashboardCard>

          {/*
            COUPON PERFORMANCE — organizer-wide, on THIS page (/dashboard), not the analytics
            page. Every figure comes from the single dashboard payload: coupon documents for
            uses/limits, plus one sum() aggregate for the discount total. No registration is
            read for it, so the card costs nothing per attendee.
          */}
          <DashboardCard title="Coupon performance" viewHref="/dashboard/analytics">
            {coupons.totalCoupons === 0 ? (
              <div className="px-5 pb-5 pt-3">
                <p className="text-[13px] font-medium text-foreground">No coupons created yet</p>
                <p className="mt-1 text-[12.5px] text-muted-foreground">
                  Create a coupon on an event to start tracking redemptions and discounts.
                </p>
              </div>
            ) : (
              <div className="space-y-4 px-5 pb-4 pt-3">
                <div className="grid grid-cols-3 gap-2 text-center">
                  {[
                    { label: 'Coupons',     value: String(coupons.totalCoupons) },
                    { label: 'Redemptions', value: String(coupons.totalRedemptions) },
                    {
                      label: 'Discount',
                      // Never render an unavailable aggregate as ₹0 — that is a claim, not a gap.
                      value: coupons.discountUnavailable ? '—' : rupees(coupons.totalDiscountPaise),
                    },
                  ].map(s => (
                    <div key={s.label}>
                      <p className="text-[17px] font-bold tabular-nums text-foreground">{s.value}</p>
                      <p className="text-[11px] uppercase tracking-wider text-muted-foreground">{s.label}</p>
                    </div>
                  ))}
                </div>

                <p className="text-[12px] text-muted-foreground">
                  <span className="font-semibold text-foreground">{coupons.activeCoupons}</span> active
                  {coupons.partial && <span className="ml-2">· showing your most recent events</span>}
                </p>

                <ul className="space-y-3">
                  {coupons.rows.slice(0, 4).map(c => (
                    <li key={`${c.eventSlug}:${c.code}`}>
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="truncate font-mono text-[12.5px] font-semibold text-foreground">{c.code}</span>
                        <span className="shrink-0 text-[12px] tabular-nums text-muted-foreground">
                          {c.maxUses === null ? `${c.uses} used` : `${c.uses} / ${c.maxUses}`}
                        </span>
                      </div>
                      <p className="truncate text-[11.5px] text-muted-foreground">
                        {c.maxUses === null ? 'Unlimited' : c.eventName}
                      </p>
                      {/* Capped coupons only. A bar for an unlimited coupon would be a
                          fabricated percentage; percentUsed is already clamped to 100. */}
                      {c.percentUsed !== null && (
                        <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                          <div className="h-full rounded-full bg-primary" style={{ width: `${c.percentUsed}%` }} />
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </DashboardCard>

          <DashboardCard title="Wallet" viewHref="/dashboard/wallet" viewLabel="Manage">
            <div className="px-5 pb-4 pt-3">
              <div className="flex items-baseline justify-between">
                <p className="text-[12px] text-muted-foreground">Balance</p>
                <p className="text-[18px] font-bold text-foreground">{rupees(data.walletBalancePaise)}</p>
              </div>
              <ul className="mt-2.5 space-y-1.5">
                {data.recentTransactions.length === 0 ? (
                  <li className="text-[12.5px] text-muted-foreground">No wallet activity yet.</li>
                ) : data.recentTransactions.slice(0, 5).map(t => {
                  const credit = t.type === 'fund_added' || t.type === 'refund'
                  return (
                    <li key={t.id} className="flex items-center justify-between gap-2 text-[12.5px]">
                      <span className="truncate text-muted-foreground">{t.description || t.type}</span>
                      <span className={cn('shrink-0 font-semibold', credit ? 'text-emerald-600' : 'text-foreground')}>{credit ? '+' : '−'}{rupees(t.amountPaise)}</span>
                    </li>
                  )
                })}
              </ul>
            </div>
          </DashboardCard>

          <DashboardCard title="Communication usage" viewHref="/dashboard/communications">
            <div className="grid grid-cols-2 gap-px overflow-hidden rounded-b-2xl bg-border">
              <MiniStat icon={Send} label="Emails sent" value={communications.emailsSent} />
              <MiniStat icon={ActivityIcon} label="WhatsApp" value={communications.whatsappSent} />
              <MiniStat icon={UsersIcon} label="SMS" value={isChannelImplemented('sms') ? communications.smsSent : 'N/A'} />
              <MiniStat icon={Megaphone} label="Campaigns" value={communications.campaignsSent} />
            </div>
          </DashboardCard>

          <DashboardCard title="Workspace health"
            action={<span className="text-[13px] font-semibold text-foreground tabular-nums">{healthScore.score}%</span>}>
            <div className="px-5 pb-4 pt-3">
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div className={cn('h-full rounded-full', healthScore.score >= 80 ? 'bg-emerald-500' : healthScore.score >= 50 ? 'bg-amber-500' : 'bg-rose-500')}
                  style={{ width: `${healthScore.score}%` }} aria-hidden />
              </div>
              <ul className="mt-3 space-y-1.5">
                {healthScore.items.map(item => (
                  <li key={item.label} className="flex items-center gap-2 text-[13px]">
                    {item.done
                      ? <CheckCircle2 className="size-4 shrink-0 text-emerald-500" aria-hidden />
                      : <Circle className="size-4 shrink-0 text-muted-foreground/40" aria-hidden />}
                    <span className={item.done ? 'text-muted-foreground line-through' : 'text-foreground'}>{item.label}</span>
                  </li>
                ))}
              </ul>
            </div>
          </DashboardCard>

          {PLATFORM_UPDATES_ENABLED && (
            <DashboardCard title="Platform updates">
              <div className="px-5 pb-4 pt-3 text-[13px] text-muted-foreground">
                <p>Product updates, maintenance, and announcements will appear here.</p>
                <p className="mt-2 inline-flex rounded-lg bg-muted/50 px-3 py-1 text-[12px] font-semibold">Coming soon</p>
              </div>
            </DashboardCard>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Small presentational helpers ───────────────────────────────────────────────

function MoneyRow({ label, value, muted, strong }: { label: string; value: string; muted?: boolean; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between px-5 py-2.5">
      <dt className="text-[13px] text-muted-foreground">{label}</dt>
      <dd className={cn('text-[14px] tabular-nums', strong ? 'font-bold text-foreground' : muted ? 'text-muted-foreground' : 'font-medium text-foreground')}>{value}</dd>
    </div>
  )
}

function MiniStat({ icon: Icon, label, value }: { icon: typeof Send; label: string; value: number | string }) {
  return (
    <div className="bg-card px-4 py-3">
      <div className="flex items-center gap-1.5 text-muted-foreground">
        <Icon className="size-3.5" aria-hidden />
        <span className="text-[12px]">{label}</span>
      </div>
      <p className="mt-1 text-[18px] font-bold tabular-nums text-foreground">{value.toLocaleString('en-IN')}</p>
    </div>
  )
}
