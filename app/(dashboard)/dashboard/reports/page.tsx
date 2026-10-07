'use client'

import { useState, useEffect, useMemo } from 'react'
import { useAuth }                              from '@/components/auth/AuthProvider'
import Link                                      from 'next/link'
import {
  BarChart3, CalendarDays, Users, TrendingUp, TrendingDown,
  IndianRupee, Loader2, AlertCircle, ArrowRight, RefreshCw,
  Trophy, Target, Minus,
} from 'lucide-react'
import { cn }                        from '@/lib/utils/cn'
import { PageHeader, EmptyState }    from '@/components/ui'
import type { DashboardData, DashboardEvent } from '@/app/api/organizer/dashboard/route'
import {
  buildPerformanceInsights,
  type PerformanceInsight, type PerformanceInsightTone,
} from '@/lib/dashboard/insights'
// RD-ANALYTICS-05 · the ONE event-selection architecture. The provider is already mounted
// in app/(dashboard)/layout.tsx, so this page has always been inside it — it simply kept
// its own copy instead. The canonical one adds URL sync, persistence, search and a shared
// "All events" state that this page's local copy never had.
import { PRESET_DAYS } from '@/lib/analytics/dateRange'
import { EventSelector } from '@/components/dashboard/EventSelector'
import { useEventContext } from '@/components/dashboard/EventContextProvider'

/**
 * ═══ RD-REPORT-02 · WHY THIS PAGE CHANGED ════════════════════════════════════
 *
 * Every number here was computed in the browser from two capped requests:
 *
 *   GET /api/organizer/events          → 25 events   (default page size; cursor ignored)
 *   GET /api/organizer/registrations   → 300 rows    (NO orderBy — an arbitrary slice
 *                                                     by document id, then sorted in
 *                                                     memory and charted as a time series)
 *
 * So "Total Registrations" meant "across your first 25 events", and the trend charts and
 * the week-over-week insight were drawn from an arbitrary 300 of however many
 * registrations existed. Neither limit was disclosed anywhere in the UI.
 *
 * This page now reads ONE endpoint — the same one the organizer Dashboard uses — whose
 * figures are already correct and already exact:
 *
 *   events[]            EVERY event the organizer owns (the route pages its entire
 *                       eventDrafts collection; there is no 25 or 500 ceiling)
 *   registrationTotals  organizer-wide, all-time, from the registrationCounters docs
 *   trendDays[]         90 days of {count, revenuePaise} from organizerDailyStats
 *                       rollups — ONE document read per day, independent of volume
 *   trendRanges[]       the 7/30/90 windows with totals and deltas already resolved
 *                       server-side, so this page never reduces a series into a claim
 *
 * No new endpoint, no new query, no new index, and strictly fewer reads than before.
 */
type DateRange = '7d' | '30d' | '90d'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtINR(paise: number): string {
  if (paise === 0) return '₹0'
  return new Intl.NumberFormat('en-IN', {
    style: 'currency', currency: 'INR', maximumFractionDigits: 0,
  }).format(paise / 100)
}

function fmtDate(dateStr: string | null): string {
  if (!dateStr) return '—'
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric',
  })
}

/**
 * RD-REPORT-02 · the chart series, taken straight from the server rollups.
 *
 * There is no bucketing left to do here. `trendDays` arrives as 90 ordered daily rows
 * (oldest → newest) built from organizerDailyStats, so a window is a SLICE — not a
 * re-derivation from rows the browser happened to hold.
 */
function sliceTrend(
  trendDays: { date: string; count: number; revenuePaise: number | null }[],
  range: DateRange,
): { label: string; registrations: number; revenue: number | null }[] {
  const days = range === '7d' ? 7 : range === '30d' ? 30 : 90
  return trendDays.slice(-days).map(d => {
    const [y, m, dd] = d.date.split('-').map(Number)
    return {
      label: new Date(y, m - 1, dd).toLocaleDateString('en-IN', { month: 'short', day: 'numeric' }),
      registrations: d.count,
      revenue: d.revenuePaise,
    }
  })
}

// ─── BarChart ─────────────────────────────────────────────────────────────────

function BarChart({
  data,
  useGradient = true,
}: {
  data: { label: string; value: number }[]
  useGradient?: boolean
}) {
  if (data.length === 0 || data.every(d => d.value === 0)) {
    return (
      <div className="flex h-20 items-center justify-center text-[13px] text-muted-foreground">
        No activity for this period
      </div>
    )
  }

  const max       = Math.max(...data.map(d => d.value), 1)
  const showEvery = data.length <= 7 ? 1 : data.length <= 14 ? 2 : data.length <= 31 ? 7 : 3

  return (
    <div>
      <div className="flex h-20 items-end gap-px">
        {data.map((d, i) => (
          <div
            key={i}
            className="group relative flex flex-1 flex-col justify-end"
            title={`${d.label}: ${d.value}`}
          >
            <div
              className="w-full rounded-t-[2px] transition-opacity group-hover:opacity-70"
              style={{
                height: `${Math.max(d.value > 0 ? 5 : 0, (d.value / max) * 100)}%`,
                backgroundImage:   d.value > 0 && useGradient  ? 'var(--primary-gradient)' : undefined,
                backgroundColor:   d.value > 0 && !useGradient ? 'rgb(16 185 129)'          : d.value === 0 ? 'transparent' : undefined,
              }}
            />
          </div>
        ))}
      </div>
      <div className="mt-1 flex gap-px">
        {data.map((d, i) => (
          <div key={i} className="flex-1 overflow-hidden text-center text-[9px] text-muted-foreground">
            {i % showEvery === 0 ? d.label.split(' ')[0] : ''}
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── EventSelector ────────────────────────────────────────────────────────────

// RD-ANALYTICS-05 · the inline EventSelector that stood here is GONE.
//
// It was a second event picker: its own dropdown, its own search, its own option list
// captured from the unscoped payload, and no URL synchronisation — so a scoped analytics
// view could not be linked to or restored, and switching events here did not move the rest
// of the workspace. components/dashboard/EventSelector.tsx does all of that already and is
// what every other event-scoped surface uses.

/**
 * RD-ANALYTICS-05 · the window options are DERIVED from the canonical preset table.
 *
 * This was a private list of three literals that happened to agree with
 * lib/analytics/dateRange.ts. Deriving it means the page cannot offer a window the shared
 * model does not define, and a preset added there appears here without an edit.
 */
const DATE_RANGE_OPTIONS: { value: DateRange; label: string }[] =
  (Object.keys(PRESET_DAYS) as DateRange[]).map(value => ({ value, label: value.toUpperCase() }))

function DateRangeSelector({ value, onChange }: { value: DateRange; onChange: (v: DateRange) => void }) {
  return (
    <div className="flex items-center rounded-lg border border-border bg-muted/30 p-0.5">
      {DATE_RANGE_OPTIONS.map(opt => (
        <button
          key={opt.value}
          onClick={() => onChange(opt.value)}
          className={cn(
            'rounded-md px-3 py-1.5 text-[12px] font-medium transition-colors',
            value === opt.value
              ? 'bg-card text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}

// ─── StatCard ─────────────────────────────────────────────────────────────────

function StatCard({
  label, value, sub, icon: Icon, color,
}: {
  label: string; value: string; sub?: string; icon: React.ElementType; color: string
}) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-border bg-card p-5">
      <div className={cn('flex size-10 shrink-0 items-center justify-center rounded-xl', color)}>
        <Icon className="size-5 text-foreground/70" aria-hidden />
      </div>
      <div>
        <p className="text-[22px] font-bold leading-none text-foreground">{value}</p>
        <p className="mt-1 text-[13px] text-muted-foreground">{label}</p>
        {sub && <p className="mt-0.5 text-[13px] text-muted-foreground">{sub}</p>}
      </div>
    </div>
  )
}

// ─── RevenueHeroCard ──────────────────────────────────────────────────────────

/**
 * `paise: null` means revenue was not readable for every event in scope (a caller without
 * the finance permission receives no per-event figure). The card shows "—": a ₹0 hero
 * would report a business result the page did not measure.
 *
 * "Estimated Revenue" was a misnomer. The figure is `registrationCounters.revenuePaise` —
 * the platform's canonical CONFIRMED revenue — so the label now says what it is.
 */
function RevenueHeroCard({ paise, eventCount }: { paise: number | null; eventCount: number }) {
  return (
    <div
      className="relative overflow-hidden rounded-2xl p-6 text-white"
      style={{ backgroundImage: 'var(--primary-gradient)' }}
    >
      <div className="relative z-10">
        <p className="text-[12px] font-semibold uppercase tracking-widest opacity-80">
          Confirmed Revenue
        </p>
        <p className="mt-1.5 text-[40px] font-bold leading-none tracking-tight">
          {paise === null ? '—' : fmtINR(paise)}
        </p>
        <p className="mt-2 text-[13px] opacity-70">
          {paise === null
            ? 'Revenue is not available for your role'
            : paise === 0
              ? 'No confirmed revenue yet'
              : `across ${eventCount} event${eventCount !== 1 ? 's' : ''}`}
        </p>
      </div>
      <div className="pointer-events-none absolute -right-8 -top-8 size-44 rounded-full bg-white/10" />
      <div className="pointer-events-none absolute -bottom-10 right-20 size-32 rounded-full bg-white/[0.06]" />
    </div>
  )
}

// ─── EventRow ─────────────────────────────────────────────────────────────────

const RANK_BADGE: Record<number, string> = {
  1: 'bg-amber-100 text-amber-700',
  2: 'bg-slate-100 text-slate-600',
  3: 'bg-orange-100 text-orange-700',
}

function EventRow({ event, rank }: { event: DashboardEvent; rank: number }) {
  // `fillPct` is resolved server-side against the event's real capacity, so this row no
  // longer divides two numbers it fetched separately. Null capacity ⇒ no rate exists.
  const pct       = event.capacity ? event.fillPct : null
  const badgeColor = RANK_BADGE[rank] ?? 'bg-muted/60 text-muted-foreground'

  return (
    <tr className="transition-colors hover:bg-muted/20">
      <td className="px-4 py-3 text-center">
        <span className={cn('inline-flex size-6 items-center justify-center rounded-full text-[11px] font-bold', badgeColor)}>
          {rank}
        </span>
      </td>
      <td className="px-4 py-3">
        <p className="text-[14px] font-medium text-foreground">{event.name}</p>
        {event.startDate && (
          <p className="text-[12px] text-muted-foreground">{fmtDate(event.startDate)}</p>
        )}
      </td>
      <td className="hidden px-4 py-3 text-right tabular-nums text-[13px] font-semibold text-foreground sm:table-cell">
        {event.registered.toLocaleString('en-IN')}
      </td>
      <td className="hidden px-4 py-3 md:table-cell">
        {pct !== null ? (
          <div className="flex items-center gap-2">
            <div className="h-1.5 w-24 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full"
                style={{ width: `${Math.min(pct, 100)}%`, backgroundImage: 'var(--primary-gradient)' }}
              />
            </div>
            <span className={cn('text-[12px] tabular-nums font-medium', pct >= 80 ? 'text-emerald-600' : 'text-muted-foreground')}>
              {pct}%
            </span>
          </div>
        ) : (
          <span className="text-[13px] text-muted-foreground">—</span>
        )}
      </td>
      <td className="hidden px-4 py-3 text-right text-[13px] lg:table-cell">
        {/* null ⇒ the caller holds no finance permission. Omitted, never rendered as ₹0.
            RD-ANALYTICS-12-21 (F1) ⇒ `revenueUnavailable` means the read failed, so the 0 on
            the wire is a placeholder. Both absences render the dash; neither invents a zero. */}
        <span className={event.confirmedRevenuePaise && !event.revenueUnavailable
          ? 'font-semibold text-foreground' : 'text-muted-foreground'}>
          {event.confirmedRevenuePaise === null || event.revenueUnavailable ? '—'
            : event.confirmedRevenuePaise > 0 ? fmtINR(event.confirmedRevenuePaise) : '₹0'}
        </span>
      </td>
      <td className="px-4 py-3 text-right">
        <Link
          href={`/dashboard/events/${event.draftId}`}
          className="inline-flex items-center gap-1 text-[13px] font-medium text-primary hover:underline"
        >
          View <ArrowRight className="size-3" />
        </Link>
      </td>
    </tr>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function ReportsHubPage() {
  const [data,          setData]          = useState<DashboardData | null>(null)
  /**
   * The selector's option list, captured from the UNSCOPED load.
   *
   * A scoped response contains only the selected event, so reading the list off `data`
   * would collapse the picker to one option the moment anything was picked.
   */
  // RD-ANALYTICS-05 · the option list is no longer captured from the payload; the context
  // owns it. What remains local is only what THIS page fetches.
  const [loading,       setLoading]       = useState(true)
  const [error,         setError]         = useState<string | null>(null)
  const [refreshKey,    setRefreshKey]    = useState(0)
  const [refreshing,    setRefreshing]    = useState(false)
  const { selectedEventId, selectedEvent } = useEventContext()
  const [dateRange,     setDateRange]     = useState<DateRange>('30d')
  // Plan gate — advanced reports is a Pro+ feature. null = unknown (loading).
  // RD-CAPACITY-02 · the `advancedReports` entitlement flag is gone. Analytics is included for
  // every organizer, so there is no plan state to hold and nothing to gate on.

  const { user, getToken } = useAuth()

  useEffect(() => {
    if (user === undefined) return
    let cancelled = false
    const run = async () => {
      // Show full loading spinner only on first load; not on explicit refresh
      if (!data) setLoading(true)
      setError(null)

      if (!user) { setLoading(false); return }
      try {
        const token   = await getToken()
        if (cancelled || !token) return
        const headers = { Authorization: `Bearer ${token}` }
        // RD-REPORT-02 · scope is resolved on the SERVER. The event id travels as
        // `?eventId=`, whose ownership is proven by the `users/{uid}/eventDrafts/{id}`
        // path — so a scoped view narrows this organizer's own data and can never widen.
        // The page used to filter the fetched arrays instead, which meant a scoped view
        // was a subset of an already-wrong sample.
        const res = await fetch(
          selectedEventId
            ? `/api/organizer/dashboard?eventId=${encodeURIComponent(selectedEventId)}`
            : '/api/organizer/dashboard',
          { headers, cache: 'no-store' },
        )
        if (!res.ok) throw new Error('Failed to load analytics')
        const payload = await res.json() as DashboardData
        if (cancelled) return
        setData(payload)
        // Only an unscoped response carries every event, so only it may refresh the picker.
        // The picker's options are the context's concern now — nothing to capture here.
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Error loading analytics')
      } finally {
        if (!cancelled) { setLoading(false); setRefreshing(false) }
      }
    }
    run()
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, getToken, refreshKey, selectedEventId])

  function handleRefresh() {
    setRefreshing(true)
    setRefreshKey(k => k + 1)
  }

  // ── Derived views ──────────────────────────────────────────────────────────
  //
  // Nothing below re-derives a business figure from rows. Each value is either read
  // straight off the payload or is a presentation-level arrangement of values the server
  // already resolved.

  /** The events in the CURRENT scope — all of them when unscoped, one when scoped. */
  const scopedEvents  = useMemo(() => data?.events ?? [], [data])
  // `selectedEvent` now comes from the context above, resolved from the SAME event list
  // the selector renders — so the heading and the picker can no longer disagree.

  const summary = useMemo(() => {
    const totals = data?.registrationTotals ?? null
    // A published event is one that left draft. `lifecycleStatus` is archive-accurate,
    // unlike the legacy `status` field, which reports archived events as drafts forever.
    const published = scopedEvents.filter(e => e.lifecycleStatus !== 'draft').length

    // Revenue is `number | null` per event, where null means the caller holds no finance
    // permission. One null makes the SUM unknowable, so the card shows "—" rather than a
    // total that silently omits events.
    //
    // RD-ANALYTICS-12-21 (F1) · an UNREADABLE event is equally unknowable, and its `0` on
    // the wire is a placeholder. Summing it would understate the total by an unknown amount
    // while presenting it as exact — the same defect, one field down.
    const revenueKnown  = scopedEvents.every(
      e => e.confirmedRevenuePaise !== null && !e.revenueUnavailable)
    const totalRevPaise = revenueKnown
      ? scopedEvents.reduce((s, e) => s + (e.confirmedRevenuePaise ?? 0), 0)
      : null

    // Fill rate over every event that HAS a capacity. (The former rule excluded free
    // events on the belief that they carried a dummy capacity of 100; they do not — the
    // events API computes real capacity and returns null when a pass is unlimited.)
    const withCap = scopedEvents.filter(e => e.capacity !== null && e.capacity > 0)
    const cap     = withCap.reduce((s, e) => s + (e.capacity ?? 0), 0)
    const regs    = withCap.reduce((s, e) => s + e.registered, 0)

    return {
      total:        scopedEvents.length,
      published,
      registrations: totals?.total ?? null,     // all statuses; null ⇒ unmeasured
      confirmed:     totals?.confirmed ?? null,
      totalRevPaise,
      fillRate:      cap > 0 ? Math.round((regs / cap) * 100) : null,
      topEvents:     [...scopedEvents].sort((a, b) => b.registered - a.registered).slice(0, 10),
    }
  }, [data, scopedEvents])

  // Both charts are a SLICE of the server's daily rollups — exact at any event size.
  const { regTrend, revTrend, revVisible } = useMemo(() => {
    const series = sliceTrend(data?.trendDays ?? [], dateRange)
    return {
      regTrend: series.map(b => ({ label: b.label, value: b.registrations })),
      // RD-PREPROD · null revenue ⇒ the caller may not see money: the revenue chart is not drawn.
      revVisible: series.length > 0 && series.every(b => b.revenue !== null),
      revTrend: series.map(b => ({ label: b.label, value: Math.round((b.revenue ?? 0) / 100) })),
    }
  }, [data, dateRange])

  // ── Smart insights ─────────────────────────────────────────────────────────
  //
  // RD-ANALYTICS-04 · the rules moved to lib/dashboard/insights.ts.
  //
  // They used to live in this useMemo — correct, but a second insight engine sitting in a
  // render function beside the pure, tested one the dashboard uses. What remains here is
  // the only part that is genuinely presentational: mapping a rule's stable `kind` to an
  // icon. The rules themselves no longer know that icons exist.

  const insights: PerformanceInsight[] = useMemo(() => buildPerformanceInsights({
    events: scopedEvents.map(e => ({
      name:            e.name,
      lifecycleStatus: e.lifecycleStatus,
      registered:      e.registered,
      capacity:        e.capacity,
      fillPct:         e.fillPct,
    })),
    week:             data?.trendRanges?.find(r => r.days === 7)?.registrations ?? null,
    trendUnavailable: data?.trendUnavailable ?? false,
  }), [scopedEvents, data])

  const INSIGHT_ICON: Record<PerformanceInsight['kind'], React.ElementType> = {
    top_event:       Trophy,
    velocity_up:     TrendingUp,
    velocity_down:   TrendingDown,
    velocity_flat:   Minus,
    velocity_total:  TrendingUp,
    empty_published: AlertCircle,
    nearly_full:     Target,
  }

  // ── Header slot ───────────────────────────────────────────────────────────

  const headerAction = (
    <div className="flex items-center gap-2">
      <EventSelector />
      <button
        onClick={handleRefresh}
        disabled={loading || refreshing}
        title="Refresh data"
        className="flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2 text-[13px] font-medium text-muted-foreground shadow-sm transition-colors hover:bg-muted/50 hover:text-foreground disabled:opacity-50"
      >
        <RefreshCw className={cn('size-3.5', refreshing && 'animate-spin')} />
        Refresh
      </button>
    </div>
  )

  return (
    <div className="space-y-6">

      <PageHeader
        title={selectedEvent ? selectedEvent.name : 'Analytics'}
        subtitle={
          selectedEvent
            ? 'Event performance metrics.'
            : 'Aggregated performance across all your events.'
        }
        action={headerAction}
      />

      {/* ── Initial loading ── */}
      {loading && !data && (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      )}

      {/* ── Error ── */}
      {!loading && error && (
        <div className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-700">
          <AlertCircle className="size-4 shrink-0" /> {error}
        </div>
      )}

      {/* ── Content (visible once data is loaded; stays visible on refresh) ── */}
      {data && !error && (
        <>
          {/* RD-REPORT-02 · at least one event's counts could not be read, so the totals
              below cover less than they appear to. Said plainly rather than absorbed. */}
          {data.analyticsUnavailable && (
            <div className="flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] text-amber-800">
              <AlertCircle className="size-4 shrink-0" />
              Some events&rsquo; registration counts could not be read, so these totals are incomplete.
            </div>
          )}

          {/* ── Revenue hero ── */}
          <RevenueHeroCard
            paise={summary.totalRevPaise}
            eventCount={summary.total}
          />

          {/* ── Summary stat cards ── */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
              label="Total Events"
              value={summary.total.toString()}
              sub={`${summary.published} published`}
              icon={CalendarDays}
              color="bg-primary/[0.08]"
            />
            <StatCard
              label="Total Registrations"
              value={summary.registrations !== null ? summary.registrations.toLocaleString('en-IN') : '—'}
              sub={summary.confirmed !== null ? `${summary.confirmed.toLocaleString('en-IN')} confirmed` : 'all statuses'}
              icon={Users}
              color="bg-emerald-100"
            />
            <StatCard
              label="Fill Rate"
              value={summary.fillRate !== null ? `${summary.fillRate}%` : '—'}
              sub={summary.fillRate !== null ? 'across events with capacity' : 'no events with capacity'}
              icon={TrendingUp}
              color="bg-amber-100"
            />
            <StatCard
              label="Confirmed Revenue"
              value={summary.totalRevPaise !== null ? fmtINR(summary.totalRevPaise) : '—'}
              icon={IndianRupee}
              color="bg-sky-100"
            />
          </div>

          {/* ── Trend charts ── */}
          <div className="rounded-xl border border-border bg-card p-5">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-[16px] font-semibold text-foreground">Registration Trends</h2>
              <DateRangeSelector value={dateRange} onChange={setDateRange} />
            </div>
            {/* The rollups could not be read. A chart of zeros would assert that nobody
                registered on any of these days — so the failure is stated instead. */}
            {data.trendUnavailable ? (
              <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/30 px-4 py-6 text-[13px] text-muted-foreground">
                <AlertCircle className="size-4 shrink-0" />
                Trend data could not be loaded. Try refreshing.
              </div>
            ) : (
              <div className="grid gap-6 sm:grid-cols-2">
                <div>
                  <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Registrations
                  </p>
                  <BarChart data={regTrend} useGradient />
                </div>
                {revVisible && (
                  <div>
                    <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                      Revenue (₹)
                    </p>
                    <BarChart data={revTrend} useGradient={false} />
                  </div>
                )}
              </div>
            )}
          </div>

          {/* ── Smart insights ── */}
          {insights.length > 0 && (
            <div className="rounded-xl border border-border bg-card p-5">
              <h2 className="mb-4 text-[16px] font-semibold text-foreground">Smart Insights</h2>
              <div className="space-y-2.5">
                {insights.map((ins, i) => {
                  const Icon = INSIGHT_ICON[ins.kind]
                  const tone: PerformanceInsightTone = ins.tone
                  return (
                    <div
                      key={i}
                      className={cn(
                        'flex items-start gap-3 rounded-lg px-3 py-2.5 text-[13px]',
                        tone === 'positive' ? 'bg-emerald-50 text-emerald-800' :
                        tone === 'warning'  ? 'bg-amber-50 text-amber-800'    :
                                              'bg-muted/40 text-foreground',
                      )}
                    >
                      <Icon className="mt-0.5 size-4 shrink-0" />
                      <p>{ins.text}</p>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* ── Top events table ── */}
          {summary.topEvents.length > 0 ? (
            <div>
              <h2 className="mb-3 text-[18px] font-semibold text-foreground">
                {selectedEventId ? 'Event Details' : 'Top Events by Registrations'}
              </h2>
              <div className="overflow-hidden rounded-xl border border-border">
                <table className="w-full text-[14px]">
                  <thead>
                    <tr className="border-b border-border bg-muted/40">
                      <th className="px-4 py-2.5 text-center text-[12px] font-semibold text-muted-foreground">#</th>
                      <th className="px-4 py-2.5 text-left   text-[12px] font-semibold text-muted-foreground">Event</th>
                      <th className="hidden px-4 py-2.5 text-right text-[12px] font-semibold text-muted-foreground sm:table-cell">Registrations</th>
                      <th className="hidden px-4 py-2.5 text-left  text-[12px] font-semibold text-muted-foreground md:table-cell">Fill Rate</th>
                      <th className="hidden px-4 py-2.5 text-right text-[12px] font-semibold text-muted-foreground lg:table-cell">Revenue</th>
                      <th className="px-4 py-2.5 text-right text-[12px] font-semibold text-muted-foreground">Details</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {summary.topEvents.map((event, i) => (
                      <EventRow key={event.draftId} event={event} rank={i + 1} />
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            summary.total === 0 ? (
              <EmptyState
                icon={BarChart3}
                title="No data yet"
                description="Create and publish events to see analytics here."
                action={{ label: 'Create Event', href: '/dashboard/events/new/visibility' }}
                className="rounded-2xl border border-dashed border-border"
              />
            ) : (
              <div className="rounded-xl border border-dashed border-border p-8 text-center">
                <p className="text-[14px] text-muted-foreground">No matching events for the selected filter.</p>
              </div>
            )
          )}

          {/* ── Event status breakdown (hidden when scoped to one event) ── */}
          {!selectedEventId && (
            <div>
              <h2 className="mb-3 text-[18px] font-semibold text-foreground">Event Status Breakdown</h2>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
                {(['draft', 'published', 'registration_closed', 'completed', 'cancelled', 'archived'] as const).map(s => {
                  const count  = scopedEvents.filter(e => e.lifecycleStatus === s).length
                  const labels: Record<string, string> = {
                    draft:               'Draft',
                    published:           'Published',
                    registration_closed: 'Reg. Closed',
                    completed:           'Completed',
                    cancelled:           'Cancelled',
                    archived:            'Archived',
                  }
                  return (
                    <div key={s} className="rounded-xl border border-border bg-card p-3 text-center">
                      <p className="text-[18px] font-bold text-foreground">{count}</p>
                      <p className="mt-0.5 text-[13px] text-muted-foreground">{labels[s]}</p>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </>
      )}

    </div>
  )
}
