'use client'

import { useState, useEffect, useMemo, useRef } from 'react'
import { onAuthStateChanged }                    from 'firebase/auth'
import { auth }                                  from '@/lib/firebase/auth'
import Link                                      from 'next/link'
import {
  BarChart3, CalendarDays, Users, TrendingUp, TrendingDown,
  IndianRupee, Loader2, AlertCircle, ArrowRight, RefreshCw,
  ChevronDown, Trophy, Target, Minus,
} from 'lucide-react'
import { cn }                        from '@/lib/utils/cn'
import { PageHeader, EmptyState }    from '@/components/ui'
import type { EventsListResponse, EventListItem } from '@/app/api/organizer/events/route'
import type { AllRegistrationsResponse }          from '@/app/api/organizer/registrations/route'

type DateRange = '7d' | '30d' | '90d' | 'all'
type Reg = AllRegistrationsResponse['registrations'][number]

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

function getRangeStart(range: DateRange): Date | null {
  if (range === 'all') return null
  const days = range === '7d' ? 7 : range === '30d' ? 30 : 90
  const d = new Date()
  d.setDate(d.getDate() - days)
  d.setHours(0, 0, 0, 0)
  return d
}

type Bucket = { label: string; registrations: number; revenue: number }

function buildBuckets(range: DateRange): Map<string, Bucket> {
  const now = new Date()
  const m   = new Map<string, Bucket>()

  if (range === 'all') {
    for (let i = 11; i >= 0; i--) {
      const d   = new Date(now.getFullYear(), now.getMonth() - i, 1)
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
      m.set(key, {
        label: d.toLocaleDateString('en-IN', { month: 'short', year: '2-digit' }),
        registrations: 0, revenue: 0,
      })
    }
    return m
  }

  if (range === '90d') {
    for (let i = 12; i >= 0; i--) {
      const anchor = new Date(now)
      anchor.setDate(anchor.getDate() - i * 7)
      const key = anchor.toISOString().slice(0, 10)
      m.set(key, {
        label: anchor.toLocaleDateString('en-IN', { month: 'short', day: 'numeric' }),
        registrations: 0, revenue: 0,
      })
    }
    return m
  }

  const days = range === '7d' ? 7 : 30
  for (let i = days - 1; i >= 0; i--) {
    const d   = new Date(now)
    d.setDate(d.getDate() - i)
    const key = d.toISOString().slice(0, 10)
    m.set(key, {
      label: d.toLocaleDateString('en-IN', { month: 'short', day: 'numeric' }),
      registrations: 0, revenue: 0,
    })
  }
  return m
}

function getBucketKey(date: Date, range: DateRange): string {
  if (range === 'all') {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
  }
  if (range === '90d') {
    const now       = new Date()
    const daysDiff  = Math.floor((now.getTime() - date.getTime()) / 86_400_000)
    const weekIdx   = Math.min(12, Math.floor(daysDiff / 7))
    const anchor    = new Date(now)
    anchor.setDate(anchor.getDate() - weekIdx * 7)
    return anchor.toISOString().slice(0, 10)
  }
  return date.toISOString().slice(0, 10)
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

function EventSelector({
  events, loading, eventId, onSelect,
}: {
  events: EventListItem[]; loading: boolean; eventId: string | null
  onSelect: (id: string | null) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  useEffect(() => {
    function handler(e: KeyboardEvent) { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [])

  const publishedEvents = events.filter(
    e => e.status === 'published' &&
         e.lifecycleStatus !== 'cancelled' &&
         e.lifecycleStatus !== 'archived' &&
         e.lifecycleStatus !== 'unpublished',   // Phase L2 recognition — never emitted yet; keeps future totals correct
  )
  const selected = publishedEvents.find(e => e.draftId === eventId)
  const label    = selected ? selected.name : 'All Events'

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        disabled={loading}
        className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-[13px] font-medium text-foreground shadow-sm transition-colors hover:bg-muted/50 disabled:opacity-60"
      >
        {loading && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
        <span className="max-w-[160px] truncate">{label}</span>
        <ChevronDown className={cn('size-3.5 text-muted-foreground transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 w-64 overflow-hidden rounded-xl border border-border bg-card shadow-lg">
          <button
            onClick={() => { onSelect(null); setOpen(false) }}
            className={cn(
              'flex w-full items-center px-3 py-2.5 text-left text-[13px] transition-colors hover:bg-muted/50',
              !eventId && 'font-semibold text-primary',
            )}
          >
            All Events
          </button>
          {publishedEvents.length === 0 ? (
            <p className="border-t border-border px-3 py-2.5 text-[13px] text-muted-foreground">
              No published events available
            </p>
          ) : (
            <div className="max-h-60 overflow-y-auto border-t border-border">
              {publishedEvents.map(e => (
                <button
                  key={e.draftId}
                  onClick={() => { onSelect(e.draftId); setOpen(false) }}
                  className={cn(
                    'flex w-full items-center px-3 py-2.5 text-left text-[13px] transition-colors hover:bg-muted/50',
                    eventId === e.draftId && 'font-semibold text-primary',
                  )}
                >
                  <span className="line-clamp-1">{e.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── DateRangeSelector ────────────────────────────────────────────────────────

const DATE_RANGE_OPTIONS: { value: DateRange; label: string }[] = [
  { value: '7d',  label: '7D'  },
  { value: '30d', label: '30D' },
  { value: '90d', label: '90D' },
  { value: 'all', label: 'All' },
]

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

function RevenueHeroCard({ paise, paidEventCount }: { paise: number; paidEventCount: number }) {
  return (
    <div
      className="relative overflow-hidden rounded-2xl p-6 text-white"
      style={{ backgroundImage: 'var(--primary-gradient)' }}
    >
      <div className="relative z-10">
        <p className="text-[12px] font-semibold uppercase tracking-widest opacity-80">
          Estimated Revenue
        </p>
        <p className="mt-1.5 text-[40px] font-bold leading-none tracking-tight">
          {fmtINR(paise)}
        </p>
        <p className="mt-2 text-[13px] opacity-70">
          {paise === 0
            ? 'No paid registrations yet'
            : `across ${paidEventCount} paid event${paidEventCount !== 1 ? 's' : ''}`}
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

function EventRow({ event, rank }: { event: EventListItem; rank: number }) {
  const pct       = event.totalCapacity
    ? Math.round((event.totalRegistrations / event.totalCapacity) * 100)
    : null
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
        {event.totalRegistrations.toLocaleString('en-IN')}
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
        <span className={event.estimatedRevenue > 0 ? 'font-semibold text-foreground' : 'text-muted-foreground'}>
          {event.estimatedRevenue > 0 ? fmtINR(event.estimatedRevenue) : 'Free'}
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
  const [events,        setEvents]        = useState<EventListItem[]>([])
  const [registrations, setRegistrations] = useState<Reg[]>([])
  const [loading,       setLoading]       = useState(true)
  const [error,         setError]         = useState<string | null>(null)
  const [refreshKey,    setRefreshKey]    = useState(0)
  const [refreshing,    setRefreshing]    = useState(false)
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null)
  const [dateRange,     setDateRange]     = useState<DateRange>('30d')
  // Plan gate — advanced reports is a Pro+ feature. null = unknown (loading).
  const [advancedReports, setAdvancedReports] = useState<boolean | null>(null)

  useEffect(() => {
    // Show full loading spinner only on first load; not on explicit refresh
    if (events.length === 0) setLoading(true)
    setError(null)

    const unsub = onAuthStateChanged(auth, async user => {
      if (!user) { setLoading(false); return }
      try {
        const token   = await user.getIdToken()
        const headers = { Authorization: `Bearer ${token}` }
        // Entitlement check first — gate the page before loading analytics data.
        try {
          const entRes = await fetch('/api/organizer/entitlements', { headers, cache: 'no-store' })
          if (entRes.ok) {
            const ent = await entRes.json() as { features?: { advancedReports?: boolean } }
            setAdvancedReports(ent.features?.advancedReports ?? false)
          } else { setAdvancedReports(false) }
        } catch { setAdvancedReports(false) }
        const [evRes, regRes] = await Promise.all([
          fetch('/api/organizer/events',        { headers }),
          fetch('/api/organizer/registrations', { headers }),
        ])
        if (!evRes.ok) throw new Error('Failed to load events')
        const evData = await evRes.json() as EventsListResponse
        setEvents(evData.events)
        if (regRes.ok) {
          const regData = await regRes.json() as AllRegistrationsResponse
          setRegistrations(regData.registrations)
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Error loading analytics')
      } finally {
        setLoading(false)
        setRefreshing(false)
      }
    })
    return unsub
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey])

  function handleRefresh() {
    setRefreshing(true)
    setRefreshKey(k => k + 1)
  }

  // ── Filtered slices ────────────────────────────────────────────────────────

  const selectedEvent = useMemo(
    () => events.find(e => e.draftId === selectedEventId) ?? null,
    [events, selectedEventId],
  )

  const filteredEvents = useMemo(() => {
    if (!selectedEventId) return events
    return events.filter(e => e.draftId === selectedEventId)
  }, [events, selectedEventId])

  const filteredRegistrations = useMemo(() => {
    const slug = selectedEvent?.slug
    if (!slug) return registrations
    return registrations.filter(r => r.eventSlug === slug)
  }, [registrations, selectedEvent])

  // ── Summary stats (event-filtered; not date-filtered) ─────────────────────

  const summary = useMemo(() => {
    const total          = filteredEvents.length
    const published      = filteredEvents.filter(e => e.status === 'published').length
    const totalRegs      = filteredEvents.reduce((s, e) => s + e.totalRegistrations, 0)
    const totalRevPaise  = filteredEvents.reduce((s, e) => s + e.estimatedRevenue, 0)
    const paidEvents     = filteredEvents.filter(e => !e.isFreeEvent && e.estimatedRevenue > 0)
    // Fill rate: paid events with explicit capacity only (free events have a dummy 100 cap)
    const paidWithCap    = filteredEvents.filter(e => !e.isFreeEvent && e.totalCapacity)
    const paidCap        = paidWithCap.reduce((s, e) => s + (e.totalCapacity ?? 0), 0)
    const paidRegs       = paidWithCap.reduce((s, e) => s + e.totalRegistrations, 0)
    const fillRate       = paidCap > 0 ? Math.round((paidRegs / paidCap) * 100) : null
    const topEvents      = [...filteredEvents]
      .sort((a, b) => b.totalRegistrations - a.totalRegistrations)
      .slice(0, 10)
    return { total, published, totalRegs, totalRevPaise, fillRate, paidEvents, topEvents }
  }, [filteredEvents])

  // ── Trend charts (event + date filtered) ──────────────────────────────────

  const { regTrend, revTrend } = useMemo(() => {
    const buckets    = buildBuckets(dateRange)
    const rangeStart = getRangeStart(dateRange)

    filteredRegistrations.forEach(r => {
      if (!r.registeredAt) return
      const date = new Date(r.registeredAt)
      if (rangeStart && date < rangeStart) return
      const key    = getBucketKey(date, dateRange)
      const bucket = buckets.get(key)
      if (bucket) {
        bucket.registrations++
        bucket.revenue += r.amount ?? 0
      }
    })

    const arr = [...buckets.values()]
    return {
      regTrend: arr.map(b => ({ label: b.label, value: b.registrations })),
      revTrend: arr.map(b => ({ label: b.label, value: Math.round(b.revenue / 100) })),
    }
  }, [filteredRegistrations, dateRange])

  // ── Smart insights ─────────────────────────────────────────────────────────

  type InsightType = 'positive' | 'neutral' | 'warning'
  type InsightEntry = { icon: React.ElementType; text: string; type: InsightType }

  const insights = useMemo((): InsightEntry[] => {
    const result: InsightEntry[] = []

    // Best event
    const best = [...filteredEvents].sort((a, b) => b.totalRegistrations - a.totalRegistrations)[0]
    if (best && best.totalRegistrations > 0) {
      result.push({
        icon: Trophy,
        text: `"${best.name}" leads with ${best.totalRegistrations.toLocaleString('en-IN')} registration${best.totalRegistrations !== 1 ? 's' : ''}`,
        type: 'positive',
      })
    }

    // Week-over-week velocity
    const now = new Date()
    const d7  = new Date(now); d7.setDate(d7.getDate() - 7);   d7.setHours(0, 0, 0, 0)
    const d14 = new Date(now); d14.setDate(d14.getDate() - 14); d14.setHours(0, 0, 0, 0)
    const recent = filteredRegistrations.filter(r => r.registeredAt && new Date(r.registeredAt) >= d7).length
    const prev   = filteredRegistrations.filter(r => r.registeredAt && new Date(r.registeredAt) >= d14 && new Date(r.registeredAt) < d7).length

    if (recent > 0 && prev > 0) {
      const delta = recent - prev
      const pct   = Math.abs(Math.round((delta / prev) * 100))
      if (delta > 0) {
        result.push({ icon: TrendingUp,   text: `${pct}% more registrations in the last 7 days vs the prior week`, type: 'positive' })
      } else if (delta < 0) {
        result.push({ icon: TrendingDown, text: `${pct}% fewer registrations in the last 7 days vs the prior week`, type: 'warning' })
      } else {
        result.push({ icon: Minus,        text: `Registration pace is steady week-over-week`,                       type: 'neutral' })
      }
    } else if (recent > 0) {
      result.push({
        icon: TrendingUp,
        text: `${recent} new registration${recent !== 1 ? 's' : ''} in the last 7 days`,
        type: 'positive',
      })
    }

    // Published events with no registrations
    const emptyPublished = filteredEvents.filter(e => e.status === 'published' && e.totalRegistrations === 0)
    if (emptyPublished.length > 0) {
      result.push({
        icon: AlertCircle,
        text: emptyPublished.length === 1
          ? `"${emptyPublished[0].name}" has no registrations yet — consider promoting it`
          : `${emptyPublished.length} published events have no registrations yet`,
        type: 'warning',
      })
    }

    // High fill-rate events (paid, 80%+)
    const highFill = filteredEvents.filter(
      e => !e.isFreeEvent && e.totalCapacity && (e.totalRegistrations / e.totalCapacity) >= 0.8,
    )
    if (highFill.length > 0) {
      result.push({
        icon: Target,
        text: `${highFill.length} event${highFill.length !== 1 ? 's are' : ' is'} at 80%+ capacity — consider opening a waitlist`,
        type: 'positive',
      })
    }

    return result.slice(0, 4)
  }, [filteredEvents, filteredRegistrations])

  // ── Header slot ───────────────────────────────────────────────────────────

  const headerAction = (
    <div className="flex items-center gap-2">
      <EventSelector
        events={events}
        loading={loading}
        eventId={selectedEventId}
        onSelect={setSelectedEventId}
      />
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

  // ── Plan gate: advanced reports requires Pro+ ──────────────────────────────
  if (advancedReports === false) {
    return (
      <div className="space-y-6">
        <PageHeader title="Analytics" subtitle="Advanced reports are a Pro feature." />
        <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-border py-20 text-center">
          <div className="flex size-12 items-center justify-center rounded-full bg-primary/[0.08]"><BarChart3 className="size-6 text-primary" aria-hidden /></div>
          <p className="text-[16px] font-semibold text-foreground">Advanced reports aren&apos;t on your plan</p>
          <p className="max-w-sm text-[13.5px] text-muted-foreground">Upgrade to Pro to unlock detailed analytics, trends, and performance insights across your events.</p>
          <Link href="/dashboard/settings/billing" className="mt-2 inline-flex items-center gap-2 rounded-lg px-4 py-2 text-[14px] font-semibold text-primary-foreground shadow-sm hover:opacity-90" style={{ backgroundImage: 'var(--primary-gradient)' }}>
            View plans <ArrowRight className="size-4" aria-hidden />
          </Link>
        </div>
      </div>
    )
  }

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
      {loading && events.length === 0 && (
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
      {events.length > 0 && !error && (
        <>
          {/* ── Revenue hero ── */}
          <RevenueHeroCard
            paise={summary.totalRevPaise}
            paidEventCount={summary.paidEvents.length}
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
              value={summary.totalRegs.toLocaleString('en-IN')}
              icon={Users}
              color="bg-emerald-100"
            />
            <StatCard
              label="Fill Rate"
              value={summary.fillRate !== null ? `${summary.fillRate}%` : '—'}
              sub={summary.fillRate !== null ? 'across paid events with capacity' : 'no paid events with capacity'}
              icon={TrendingUp}
              color="bg-amber-100"
            />
            <StatCard
              label="Estimated Revenue"
              value={fmtINR(summary.totalRevPaise)}
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
            <div className="grid gap-6 sm:grid-cols-2">
              <div>
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Registrations
                </p>
                <BarChart data={regTrend} useGradient />
              </div>
              <div>
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Revenue (₹)
                </p>
                <BarChart data={revTrend} useGradient={false} />
              </div>
            </div>
          </div>

          {/* ── Smart insights ── */}
          {insights.length > 0 && (
            <div className="rounded-xl border border-border bg-card p-5">
              <h2 className="mb-4 text-[16px] font-semibold text-foreground">Smart Insights</h2>
              <div className="space-y-2.5">
                {insights.map((ins, i) => {
                  const Icon = ins.icon
                  return (
                    <div
                      key={i}
                      className={cn(
                        'flex items-start gap-3 rounded-lg px-3 py-2.5 text-[13px]',
                        ins.type === 'positive' ? 'bg-emerald-50 text-emerald-800' :
                        ins.type === 'warning'  ? 'bg-amber-50 text-amber-800'    :
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
                  const count  = events.filter(e => e.lifecycleStatus === s).length
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
