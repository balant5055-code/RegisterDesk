'use client'

import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import Link                  from 'next/link'
import { onAuthStateChanged } from 'firebase/auth'
import { auth }               from '@/lib/firebase/auth'
import { motion }             from 'framer-motion'
import {
  AlertCircle, AlertTriangle, Award, BarChart3,
  CalendarDays, Check, CheckCircle2, ChevronRight,
  Clock, CreditCard, Loader2, Mail, MessageSquare,
  Plus, QrCode, ScanLine, Ticket, TrendingUp, Users, Zap,
} from 'lucide-react'
import { DashboardCard }        from '@/components/dashboard/DashboardCard'
import { EmptyState, ErrorState } from '@/components/dashboard/EmptyState'
import { Skeleton }             from '@/components/dashboard/Skeleton'
import { buttonVariants }       from '@/components/ui'
import { ROUTES }               from '@/config/navigation'
import { cn }                   from '@/lib/utils/cn'
import type { DashboardData }   from '@/app/api/organizer/dashboard/route'

// ─── Animation ────────────────────────────────────────────────────────────────

const EASE   = [0.22, 1, 0.36, 1] as const
const stagger = { hidden: {}, show: { transition: { staggerChildren: 0.045, delayChildren: 0.02 } } }
const fadeUp  = { hidden: { opacity: 0, y: 10 }, show: { opacity: 1, y: 0, transition: { duration: 0.35, ease: EASE } } }

// ─── Types ────────────────────────────────────────────────────────────────────

type TrendRange = '7d' | '30d' | '90d'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function deriveGreeting(): { greeting: string; dateStr: string } {
  const hour = new Date().getHours()
  return {
    greeting: hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening',
    dateStr:  new Date().toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
    }),
  }
}

function formatCurrency(paise: number): string {
  const r = paise / 100
  if (r >= 10_00_000) return `₹${(r / 10_00_000).toFixed(1)}L`
  if (r >= 1_000)     return `₹${(r / 1_000).toFixed(1)}K`
  return `₹${r.toFixed(0)}`
}

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime()
  const mins   = Math.floor(diffMs / 60_000)
  if (mins < 1)    return 'just now'
  if (mins < 60)   return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs  < 24)   return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  return `${days}d ago`
}

function daysUntil(dateStr: string | null): number | null {
  if (!dateStr) return null
  return Math.ceil((new Date(dateStr).getTime() - Date.now()) / 86_400_000)
}

// ─── Static ───────────────────────────────────────────────────────────────────

const TREND_RANGES: TrendRange[] = ['7d', '30d', '90d']

const QUICK_ACTIONS = [
  { label: 'Create Event',    icon: Plus,         href: ROUTES.NEW_EVENT,               primary: true  },
  { label: 'View Events',     icon: CalendarDays, href: ROUTES.DASHBOARD_EVENTS,        primary: false },
  { label: 'Check-In Hub',    icon: QrCode,       href: ROUTES.DASHBOARD_CHECK_IN,      primary: false },
  { label: 'Certificates',    icon: Award,        href: ROUTES.DASHBOARD_CERTIFICATES,  primary: false },
  { label: 'Send Message',    icon: MessageSquare,href: ROUTES.DASHBOARD_COMMUNICATIONS, primary: false },
]

const ALERT_STYLES = {
  critical: { dot: 'bg-destructive', bg: 'bg-destructive/[0.04]', border: 'border-destructive/20', icon: 'text-destructive' },
  warning:  { dot: 'bg-amber-400',   bg: 'bg-amber-50/60',        border: 'border-amber-200',      icon: 'text-amber-600' },
}

const LIFECYCLE_BADGE: Record<string, { label: string; cls: string }> = {
  published:           { label: 'Live',    cls: 'bg-emerald-100 text-emerald-700'       },
  registration_closed: { label: 'Closed',  cls: 'bg-amber-100 text-amber-700'           },
  completed:           { label: 'Done',    cls: 'bg-muted text-muted-foreground'         },
  cancelled:           { label: 'Cancelled', cls: 'bg-destructive/10 text-destructive'  },
}

// ─── Skeleton variants ────────────────────────────────────────────────────────

function KpiSkeleton() {
  return (
    <div className="rounded-xl border border-border bg-card p-4 shadow-sm" aria-hidden>
      <div className="flex items-start justify-between">
        <Skeleton className="size-9 rounded-lg" />
        <Skeleton className="h-3 w-16 rounded" />
      </div>
      <Skeleton className="mt-3 h-7 w-20 rounded" />
      <Skeleton className="mt-1.5 h-3 w-28 rounded" />
    </div>
  )
}

function AlertSkeleton() {
  return (
    <div className="flex items-start gap-3 px-5 py-3.5 border-b border-border last:border-0" aria-hidden>
      <Skeleton className="mt-0.5 size-4 rounded" />
      <div className="flex-1 space-y-1.5">
        <Skeleton className="h-3.5 w-48 rounded" />
        <Skeleton className="h-3 w-36 rounded" />
      </div>
    </div>
  )
}

function EventRowSkeleton() {
  return (
    <div className="flex items-center gap-4 border-b border-border px-5 py-3.5 last:border-0" aria-hidden>
      <div className="flex-1 space-y-2">
        <div className="flex items-center gap-2">
          <Skeleton className="h-3.5 w-40 rounded" />
          <Skeleton className="h-4 w-10 rounded-full" />
        </div>
        <div className="flex items-center gap-4">
          <Skeleton className="h-3 w-20 rounded" />
          <Skeleton className="h-1.5 w-24 rounded-full" />
          <Skeleton className="h-3 w-16 rounded" />
        </div>
      </div>
      <Skeleton className="h-3 w-12 rounded" />
    </div>
  )
}

function ActivitySkeleton() {
  return (
    <div className="flex items-center gap-3 border-b border-border px-5 py-3 last:border-0" aria-hidden>
      <Skeleton className="size-8 shrink-0 rounded-full" />
      <div className="flex-1 space-y-1.5">
        <Skeleton className="h-3.5 w-32 rounded" />
        <Skeleton className="h-3 w-44 rounded" />
      </div>
      <Skeleton className="h-5 w-20 rounded-full" />
      <Skeleton className="h-3 w-10 rounded" />
    </div>
  )
}

function LedgerSkeleton() {
  return (
    <div className="space-y-3 px-5 py-4" aria-hidden>
      {[1, 2, 3, 4].map(i => (
        <div key={i} className="flex items-center justify-between">
          <Skeleton className="h-3.5 w-36 rounded" />
          <Skeleton className="h-3.5 w-20 rounded" />
        </div>
      ))}
    </div>
  )
}

// ─── MiniBarChart ─────────────────────────────────────────────────────────────

const MiniBarChart = memo(function MiniBarChart({ values }: { values: number[] }) {
  const max = Math.max(...values, 1)
  return (
    <div className="flex h-[72px] items-end gap-px" aria-hidden role="img" aria-label="Registration trend bar chart">
      {values.map((v, i) => (
        <div
          key={i}
          className="min-w-0 flex-1 rounded-[2px]"
          style={{
            height:          `${Math.max(4, (v / max) * 100)}%`,
            backgroundImage: 'var(--primary-gradient)',
            opacity:          0.45 + 0.55 * (v / max),
          }}
        />
      ))}
    </div>
  )
})

// ─── Attendee initial avatar ──────────────────────────────────────────────────

function Avatar({ name, type }: { name: string; type: 'registration' | 'checkin' }) {
  const letters = name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase()
  return (
    <div
      className={cn(
        'flex size-8 shrink-0 items-center justify-center rounded-full text-[11px] font-bold',
        type === 'registration'
          ? 'text-primary-foreground'
          : 'bg-emerald-100 text-emerald-700',
      )}
      style={type === 'registration' ? { backgroundImage: 'var(--primary-gradient)' } : undefined}
      aria-hidden
    >
      {letters}
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const [data,       setData]       = useState<DashboardData | null>(null)
  const [loading,    setLoading]    = useState(true)
  const [error,      setError]      = useState<string | null>(null)
  const [retryKey,   setRetryKey]   = useState(0)
  const [trendRange, setTrendRange] = useState<TrendRange>('7d')

  const { greeting, dateStr } = useMemo(deriveGreeting, [])

  // ── Data fetch ──────────────────────────────────────────────────────────────

  useEffect(() => {
    setLoading(true)
    setError(null)
    const unsub = onAuthStateChanged(auth, async user => {
      if (!user) { setLoading(false); return }
      try {
        const token = await user.getIdToken(retryKey > 0)
        const res   = await fetch('/api/organizer/dashboard', {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (!res.ok) throw new Error(`Failed to load dashboard. (${res.status})`)
        setData(await res.json() as DashboardData)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load dashboard data.')
      } finally {
        setLoading(false)
      }
    })
    return unsub
  }, [retryKey])

  const handleRetry = useCallback(() => setRetryKey(k => k + 1), [])

  // ── Trend derivations ───────────────────────────────────────────────────────

  const trendValues = useMemo(() => {
    if (!data) return []
    const n = trendRange === '7d' ? 7 : trendRange === '30d' ? 30 : 90
    return data.trendDays.slice(-n).map(d => d.count)
  }, [data, trendRange])

  const trendLabels = useMemo(() => {
    if (!data) return []
    const n      = trendRange === '7d' ? 7 : trendRange === '30d' ? 30 : 90
    const slice  = data.trendDays.slice(-n)

    if (trendRange === '7d') {
      return slice.map(d =>
        new Date(d.date).toLocaleDateString('en-US', { weekday: 'short' }),
      )
    }
    if (trendRange === '30d') {
      const seen = new Set<number>()
      return slice
        .filter(d => {
          const week = Math.floor(
            (new Date(d.date).getTime() - new Date(slice[0].date).getTime()) / (7 * 86_400_000),
          )
          if (seen.has(week)) return false
          seen.add(week)
          return true
        })
        .map(d => new Date(d.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }))
    }
    // 90d — one label per calendar month
    const seen = new Set<string>()
    return slice
      .filter(d => {
        const month = new Date(d.date).toLocaleDateString('en-US', { month: 'short' })
        if (seen.has(month)) return false
        seen.add(month)
        return true
      })
      .map(d => new Date(d.date).toLocaleDateString('en-US', { month: 'short' }))
  }, [data, trendRange])

  const trendSummary = useMemo(() => {
    if (!data) return ''
    const n     = trendRange === '7d' ? 7 : trendRange === '30d' ? 30 : 90
    const slice = data.trendDays.slice(-n)
    const total = slice.reduce((s, d) => s + d.count, 0)
    const avg   = Math.round(total / Math.max(n, 1))
    return `${total.toLocaleString()} registrations · ${avg}/day avg`
  }, [data, trendRange])

  // ── Overview card data ──────────────────────────────────────────────────────

  const kpiCards = useMemo(() => {
    if (!data) return []
    const { overview, settlement } = data
    return [
      {
        label: 'Active Events',
        value: `${overview.activeEvents}`,
        sub:   'published events',
        icon:  CalendarDays,
        color: 'text-primary',
        bg:    'bg-primary/[0.09]',
      },
      {
        label: 'Total Registrations',
        value: `${overview.totalRegistrations.toLocaleString()}`,
        sub:   'confirmed',
        icon:  Ticket,
        color: 'text-[#fb5a6a]',
        bg:    'bg-[#fb5a6a]/[0.09]',
      },
      {
        label: 'Gross Revenue',
        value: formatCurrency(settlement.grossRevenuePaise),
        sub:   'paid registrations',
        icon:  CreditCard,
        color: 'text-emerald-600',
        bg:    'bg-emerald-500/[0.09]',
      },
      {
        label: "Today's Registrations",
        value: `${overview.todayRegistrations}`,
        sub:   'in the last 24 h',
        icon:  TrendingUp,
        color: 'text-amber-600',
        bg:    'bg-amber-500/[0.09]',
      },
      {
        label: "Today's Check-ins",
        value: `${overview.todayCheckins}`,
        sub:   'scanned today',
        icon:  ScanLine,
        color: 'text-teal-600',
        bg:    'bg-teal-500/[0.09]',
      },
      {
        label: 'Est. Net Payout',
        value: formatCurrency(settlement.netPayoutPaise),
        sub:   'after platform fees',
        icon:  BarChart3,
        color: 'text-violet-600',
        bg:    'bg-violet-500/[0.09]',
      },
    ]
  }, [data])

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <motion.div
      variants={stagger}
      initial="hidden"
      animate="show"
      className="space-y-5 pb-12"
      aria-label="Organizer dashboard"
    >

      {/* ═══════════════════════════════════════════════════════════════════════
          Hero
      ═══════════════════════════════════════════════════════════════════════ */}
      <motion.div variants={fadeUp}>
        <div className="relative overflow-hidden rounded-xl border border-border bg-card shadow-sm">
          <div
            className="pointer-events-none absolute -right-16 -top-16 h-64 w-64 rounded-full opacity-[0.06] blur-3xl"
            style={{ backgroundImage: 'var(--primary-gradient)' }}
            aria-hidden
          />
          <div className="relative px-6 py-5 sm:px-7 sm:py-6">
            <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">

              <div className="min-w-0">
                <p className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
                  Organizer Dashboard
                </p>
                <h1 className="mt-1 text-[28px] font-bold tracking-tight text-foreground">
                  {loading
                    ? <span className="inline-block">{greeting} 👋</span>
                    : `${greeting}${data?.organizer.name ? `, ${data.organizer.name.split(' ')[0]}` : ''} 👋`
                  }
                </h1>
                <p className="mt-0.5 text-[14px] text-muted-foreground">{dateStr}</p>

                {/* Live quick stats */}
                <div className="mt-4 flex flex-wrap gap-2" aria-label="At a glance">
                  {loading ? (
                    <>
                      <Skeleton className="h-7 w-28 rounded-lg" />
                      <Skeleton className="h-7 w-32 rounded-lg" />
                      <Skeleton className="h-7 w-24 rounded-lg" />
                    </>
                  ) : data ? (
                    [
                      { icon: CalendarDays, value: `${data.overview.activeEvents}`,                            label: 'active events',    color: 'text-primary'     },
                      { icon: Ticket,       value: `${data.overview.totalRegistrations.toLocaleString()}`,      label: 'registrations',    color: 'text-[#fb5a6a]'  },
                      { icon: TrendingUp,   value: `${data.overview.todayRegistrations}`,                       label: 'today',            color: 'text-emerald-500' },
                    ].map(({ icon: Icon, value, label, color }) => (
                      <div
                        key={label}
                        className="flex items-center gap-1.5 rounded-lg border border-border bg-muted/60 px-3 py-1.5"
                      >
                        <Icon className={cn('size-3.5', color)} aria-hidden />
                        <span className="text-[13px] font-semibold text-foreground">{value}</span>
                        <span className="text-[13px] text-muted-foreground">{label}</span>
                      </div>
                    ))
                  ) : null}
                </div>

                <div className="mt-5 flex flex-wrap gap-2">
                  <Link href={ROUTES.NEW_EVENT} className={buttonVariants({ variant: 'primary', size: 'sm' })}>
                    <Plus className="size-3.5" aria-hidden /> Create Event
                  </Link>
                  <Link href={ROUTES.DASHBOARD_EVENTS} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
                    View Events
                  </Link>
                </div>
              </div>

              {/* Desktop: organizer profile summary */}
              {data && (
                <div className="hidden shrink-0 flex-col gap-3 sm:flex" aria-label="Profile summary">
                  {[
                    {
                      label: 'Organization',
                      value: data.organizer.orgName || 'Not set',
                      sub:   data.organizer.orgName ? 'Your organization' : 'Complete your profile',
                    },
                    {
                      label: 'Profile health',
                      value: `${data.healthScore.score}%`,
                      sub:   `${data.healthScore.items.filter(i => i.done).length}/${data.healthScore.items.length} complete`,
                    },
                    {
                      label: 'Alerts',
                      value: data.alerts.length > 0 ? `${data.alerts.length} item${data.alerts.length > 1 ? 's' : ''}` : 'All clear',
                      sub:   data.alerts.length > 0 ? 'need attention' : 'No action required',
                    },
                  ].map(({ label, value, sub }) => (
                    <div key={label} className="rounded-lg border border-border bg-muted/40 px-4 py-2.5 text-right">
                      <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{label}</p>
                      <p className="mt-0.5 text-[14px] font-semibold text-foreground">{value}</p>
                      <p className="text-[12px] text-muted-foreground">{sub}</p>
                    </div>
                  ))}
                </div>
              )}

            </div>
          </div>
        </div>
      </motion.div>

      {/* ═══════════════════════════════════════════════════════════════════════
          Executive Overview — 6 KPI cards
      ═══════════════════════════════════════════════════════════════════════ */}
      <motion.div
        variants={fadeUp}
        className="grid grid-cols-2 gap-3 sm:grid-cols-3"
        aria-label="Key performance indicators"
        aria-live="polite"
        aria-busy={loading}
      >
        {loading
          ? Array.from({ length: 6 }).map((_, i) => <KpiSkeleton key={i} />)
          : error
            ? <div className="col-span-full"><ErrorState message={error} onRetry={handleRetry} /></div>
            : kpiCards.map(({ label, value, sub, icon: Icon, color, bg }) => (
                <div
                  key={label}
                  className="rounded-xl border border-border bg-card p-4 shadow-sm"
                  role="figure"
                  aria-label={`${label}: ${value}`}
                >
                  <div className={cn('flex size-9 items-center justify-center rounded-lg', bg)}>
                    <Icon className={cn('size-[17px]', color)} aria-hidden />
                  </div>
                  <p className="mt-3 text-[28px] font-bold leading-none tracking-tight text-foreground">
                    {value}
                  </p>
                  <p className="mt-1.5 text-[13px] font-medium text-foreground">{label}</p>
                  <p className="mt-0.5 text-[12px] text-muted-foreground">{sub}</p>
                </div>
              ))
        }
      </motion.div>

      {/* ═══════════════════════════════════════════════════════════════════════
          Attention Center — shown only when there are alerts
      ═══════════════════════════════════════════════════════════════════════ */}
      {!loading && !error && (
        <motion.div variants={fadeUp}>
          <DashboardCard title="Attention Center">
            {loading ? (
              Array.from({ length: 3 }).map((_, i) => <AlertSkeleton key={i} />)
            ) : (data?.alerts ?? []).length === 0 ? (
              <div className="flex items-center gap-3 px-5 py-4">
                <div className="flex size-8 items-center justify-center rounded-full bg-emerald-100">
                  <CheckCircle2 className="size-4 text-emerald-600" aria-hidden />
                </div>
                <div>
                  <p className="text-[13px] font-semibold text-foreground">Everything looks good</p>
                  <p className="text-[12px] text-muted-foreground">No action required today.</p>
                </div>
              </div>
            ) : (
              <ul aria-label="Action items">
                {data!.alerts.map((alert, i) => {
                  const style = ALERT_STYLES[alert.severity]
                  return (
                    <li
                      key={i}
                      className={cn(
                        'flex items-start gap-3 px-5 py-3.5 transition-colors',
                        i < data!.alerts.length - 1 && 'border-b border-border',
                      )}
                    >
                      <AlertTriangle
                        className={cn('mt-0.5 size-4 shrink-0', style.icon)}
                        aria-hidden
                      />
                      <div className="min-w-0 flex-1">
                        <p className="text-[13.5px] font-semibold text-foreground">{alert.title}</p>
                        <p className="mt-0.5 text-[13.5px] text-muted-foreground">{alert.meta}</p>
                      </div>
                      <span
                        className={cn(
                          'shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide',
                          alert.severity === 'critical'
                            ? 'bg-destructive/10 text-destructive'
                            : 'bg-amber-100 text-amber-700',
                        )}
                      >
                        {alert.severity}
                      </span>
                    </li>
                  )
                })}
              </ul>
            )}
          </DashboardCard>
        </motion.div>
      )}

      {/* ═══════════════════════════════════════════════════════════════════════
          Registration Trend Chart
      ═══════════════════════════════════════════════════════════════════════ */}
      <motion.div variants={fadeUp}>
        <DashboardCard
          title="Registration Trend"
          action={
            <div
              role="group"
              aria-label="Select time range"
              className="flex items-center gap-px rounded-lg border border-border bg-muted p-0.5"
            >
              {TREND_RANGES.map(r => (
                <button
                  key={r}
                  onClick={() => setTrendRange(r)}
                  aria-pressed={trendRange === r}
                  className={cn(
                    'rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors',
                    trendRange === r
                      ? 'bg-card text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {r}
                </button>
              ))}
            </div>
          }
        >
          {loading ? (
            <div className="px-5 py-4" aria-hidden>
              <Skeleton className="mb-3 h-3 w-52 rounded" />
              <Skeleton className="h-[72px] w-full rounded-md" />
              <div className="mt-2 flex justify-between gap-2">
                {[1, 2, 3, 4, 5].map(i => <Skeleton key={i} className="h-2.5 w-8 rounded" />)}
              </div>
            </div>
          ) : error ? (
            <ErrorState message={error} onRetry={handleRetry} />
          ) : trendValues.every(v => v === 0) ? (
            <EmptyState
              icon={BarChart3}
              title="No registrations yet"
              description="Registration data will appear here once attendees start signing up."
            />
          ) : (
            <div className="px-5 pb-4 pt-4">
              <p className="mb-3 text-[12px] text-muted-foreground" aria-live="polite">
                {trendSummary}
              </p>
              <MiniBarChart values={trendValues} />
              <div className="mt-2 flex justify-between" aria-hidden>
                {trendLabels.map(l => (
                  <span key={l} className="text-[11px] text-muted-foreground">{l}</span>
                ))}
              </div>
            </div>
          )}
        </DashboardCard>
      </motion.div>

      {/* ═══════════════════════════════════════════════════════════════════════
          Main grid — Event Health (2/3) + right rail (1/3)
      ═══════════════════════════════════════════════════════════════════════ */}
      <div className="grid gap-4 lg:grid-cols-3">

        {/* ── Event Health ── */}
        <motion.div variants={fadeUp} className="lg:col-span-2">
          <DashboardCard title="Event Health" viewHref={ROUTES.DASHBOARD_EVENTS}>
            {loading ? (
              Array.from({ length: 4 }).map((_, i) => <EventRowSkeleton key={i} />)
            ) : error ? (
              <ErrorState message={error} onRetry={handleRetry} />
            ) : (data?.events ?? []).length === 0 ? (
              <EmptyState
                icon={CalendarDays}
                title="No published events"
                description="Publish your first event to see health metrics here."
                action={{ label: 'Create Event', href: ROUTES.NEW_EVENT }}
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[520px] text-left text-[13.5px]" aria-label="Event health table">
                  <thead>
                    <tr className="border-b border-border">
                      {['Event', 'Registered', 'Fill', 'Event Date', 'Days'].map(h => (
                        <th key={h} className="px-5 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground first:pl-5">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data!.events.map((ev, i) => {
                      const badge  = LIFECYCLE_BADGE[ev.lifecycleStatus] ?? LIFECYCLE_BADGE.published
                      const days   = daysUntil(ev.startDate)
                      const capStr = ev.capacity !== null ? `/${ev.capacity}` : ''
                      const fillColor =
                        ev.fillPct >= 90 ? 'bg-destructive' :
                        ev.fillPct >= 70 ? 'bg-amber-400' :
                        'bg-primary'

                      return (
                        <tr
                          key={ev.draftId}
                          className={cn(
                            'transition-colors hover:bg-muted/40',
                            i < data!.events.length - 1 && 'border-b border-border',
                          )}
                        >
                          <td className="px-5 py-3.5">
                            <div className="flex flex-col gap-0.5">
                              <span className="font-semibold text-foreground leading-tight">{ev.name}</span>
                              <span className={cn('inline-flex w-fit items-center rounded-full px-1.5 py-0.5 text-[11px] font-semibold', badge.cls)}>
                                {badge.label}
                              </span>
                            </div>
                          </td>
                          <td className="px-5 py-3.5 tabular-nums text-foreground">
                            {ev.registered.toLocaleString()}{capStr}
                          </td>
                          <td className="px-5 py-3.5">
                            {ev.capacity !== null ? (
                              <div className="flex items-center gap-2">
                                <div className="h-1.5 w-16 overflow-hidden rounded-full bg-muted"
                                  role="progressbar"
                                  aria-valuenow={ev.fillPct}
                                  aria-valuemin={0}
                                  aria-valuemax={100}
                                >
                                  <div
                                    className={cn('h-full rounded-full transition-all', fillColor)}
                                    style={{ width: `${ev.fillPct}%` }}
                                  />
                                </div>
                                <span className="tabular-nums text-muted-foreground">{ev.fillPct}%</span>
                              </div>
                            ) : (
                              <span className="text-muted-foreground">∞</span>
                            )}
                          </td>
                          <td className="px-5 py-3.5 text-muted-foreground">
                            {ev.startDate
                              ? new Date(ev.startDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
                              : '—'}
                          </td>
                          <td className="px-5 py-3.5">
                            {days === null ? (
                              <span className="text-muted-foreground">—</span>
                            ) : days > 0 ? (
                              <span className="font-medium text-foreground">{days}d</span>
                            ) : days === 0 ? (
                              <span className="font-semibold text-amber-600">Today</span>
                            ) : (
                              <span className="text-muted-foreground">{Math.abs(days)}d ago</span>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </DashboardCard>
        </motion.div>

        {/* ── Right rail: Quick Actions ── */}
        <motion.div variants={fadeUp} className="space-y-4">
          <DashboardCard title="Quick Actions">
            <div className="grid grid-cols-2 gap-2 p-3" role="list" aria-label="Quick actions">
              {QUICK_ACTIONS.map(({ label, icon: Icon, href, primary }) => (
                <Link key={label} href={href} role="listitem">
                  <div
                    className={cn(
                      'flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border px-2 py-4 text-center text-[13px] font-semibold transition-all active:scale-[0.98]',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                      primary
                        ? 'border-primary/20 text-primary-foreground hover:opacity-90'
                        : 'border-border bg-card text-muted-foreground hover:border-primary/30 hover:bg-primary/[0.05] hover:text-primary',
                    )}
                    style={primary ? { backgroundImage: 'var(--primary-gradient)' } : undefined}
                  >
                    <Icon className={cn('size-[18px]', primary ? 'text-primary-foreground' : '')} aria-hidden />
                    {label}
                  </div>
                </Link>
              ))}
            </div>
          </DashboardCard>
        </motion.div>

      </div>

      {/* ═══════════════════════════════════════════════════════════════════════
          Activity Feed (2/3) + Settlement + Comms + Health (1/3)
      ═══════════════════════════════════════════════════════════════════════ */}
      <div className="grid gap-4 lg:grid-cols-3">

        {/* ── Live Activity Feed ── */}
        <motion.div variants={fadeUp} className="lg:col-span-2">
          <DashboardCard title="Live Activity Feed" viewHref={ROUTES.DASHBOARD_REGISTRATIONS}>
            {loading ? (
              Array.from({ length: 6 }).map((_, i) => <ActivitySkeleton key={i} />)
            ) : error ? (
              <ErrorState message={error} onRetry={handleRetry} />
            ) : (data?.activity ?? []).length === 0 ? (
              <EmptyState
                icon={Clock}
                title="No activity yet"
                description="Registrations and check-ins will appear here in real time."
              />
            ) : (
              <ul aria-label="Recent activity">
                {data!.activity.map((item, i) => (
                  <li
                    key={`${item.type}-${item.timestamp}-${i}`}
                    className={cn(
                      'flex items-center gap-3 px-5 py-3 transition-colors hover:bg-muted/40',
                      i < data!.activity.length - 1 && 'border-b border-border',
                    )}
                  >
                    <Avatar name={item.attendeeName} type={item.type} />

                    <div className="min-w-0 flex-1">
                      <p className="text-[14px] font-medium leading-none text-foreground">
                        {item.attendeeName}
                      </p>
                      <p className="mt-0.5 truncate text-[12px] text-muted-foreground">
                        {item.eventName}
                        {item.passName ? ` · ${item.passName}` : ''}
                      </p>
                    </div>

                    <span
                      className={cn(
                        'shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold',
                        item.type === 'registration'
                          ? 'bg-primary/10 text-primary'
                          : 'bg-emerald-100 text-emerald-700',
                      )}
                    >
                      {item.type === 'registration' ? 'Registered' : 'Checked in'}
                    </span>

                    <span className="shrink-0 text-[12px] text-muted-foreground">
                      {relativeTime(item.timestamp)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </DashboardCard>
        </motion.div>

        {/* ── Right rail: Settlement + Comms + Health Score ── */}
        <div className="space-y-4">

          {/* Settlement Center */}
          <motion.div variants={fadeUp}>
            <DashboardCard title="Settlement Center">
              {loading ? (
                <LedgerSkeleton />
              ) : error ? (
                <ErrorState message={error} onRetry={handleRetry} />
              ) : (
                <div className="px-5 py-4 space-y-0">
                  {[
                    {
                      label:  'Gross Revenue',
                      value:  formatCurrency(data!.settlement.grossRevenuePaise),
                      bold:   false,
                      color:  'text-foreground',
                    },
                    {
                      label:  'Platform Fee (2%)',
                      value:  `− ${formatCurrency(data!.settlement.platformFeePaise)}`,
                      bold:   false,
                      color:  'text-muted-foreground',
                    },
                    {
                      label:  'Communication Cost',
                      value:  `− ${formatCurrency(data!.settlement.communicationCostPaise)}`,
                      bold:   false,
                      color:  'text-muted-foreground',
                    },
                  ].map(row => (
                    <div key={row.label} className="flex items-center justify-between py-2.5 border-b border-border last:border-0">
                      <span className="text-[13.5px] text-muted-foreground">{row.label}</span>
                      <span className={cn('text-[12.5px] tabular-nums', row.color)}>{row.value}</span>
                    </div>
                  ))}
                  <div className="flex items-center justify-between pt-3">
                    <span className="text-[14px] font-bold text-foreground">Net Payout</span>
                    <span className="text-[16px] font-bold text-emerald-600 tabular-nums">
                      {formatCurrency(data!.settlement.netPayoutPaise)}
                    </span>
                  </div>
                  <p className="mt-2 text-[12px] text-muted-foreground">
                    Settlement dates depend on your payment gateway schedule.
                  </p>
                </div>
              )}
            </DashboardCard>
          </motion.div>

          {/* Communication Summary */}
          <motion.div variants={fadeUp}>
            <DashboardCard title="Communication Summary">
              {loading ? (
                <LedgerSkeleton />
              ) : error ? (
                <ErrorState message={error} onRetry={handleRetry} />
              ) : (
                <div className="px-5 py-4">
                  {[
                    {
                      icon:  Mail,
                      label: 'Emails Sent',
                      value: data!.communications.emailsSent.toLocaleString(),
                      color: 'text-primary',
                      bg:    'bg-primary/[0.09]',
                    },
                    {
                      icon:  MessageSquare,
                      label: 'SMS Sent',
                      value: data!.communications.smsSent.toLocaleString(),
                      color: 'text-emerald-600',
                      bg:    'bg-emerald-500/[0.09]',
                    },
                    {
                      icon:  Users,
                      label: 'WhatsApp Sent',
                      value: data!.communications.whatsappSent.toLocaleString(),
                      color: 'text-teal-600',
                      bg:    'bg-teal-500/[0.09]',
                    },
                    {
                      icon:  CreditCard,
                      label: 'Communication Cost',
                      value: formatCurrency(data!.communications.costPaise),
                      color: 'text-amber-600',
                      bg:    'bg-amber-500/[0.09]',
                    },
                  ].map(({ icon: Icon, label, value, color, bg }, i, arr) => (
                    <div
                      key={label}
                      className={cn(
                        'flex items-center gap-3 py-2.5',
                        i < arr.length - 1 && 'border-b border-border',
                      )}
                    >
                      <div className={cn('flex size-7 shrink-0 items-center justify-center rounded-lg', bg)}>
                        <Icon className={cn('size-3.5', color)} aria-hidden />
                      </div>
                      <span className="flex-1 text-[13.5px] text-muted-foreground">{label}</span>
                      <span className="tabular-nums text-[13.5px] font-semibold text-foreground">{value}</span>
                    </div>
                  ))}
                </div>
              )}
            </DashboardCard>
          </motion.div>

          {/* Organizer Health Score */}
          <motion.div variants={fadeUp}>
            <DashboardCard title="Profile Health">
              {loading ? (
                <div className="px-5 py-4 space-y-3" aria-hidden>
                  <div className="flex items-center gap-3">
                    <Skeleton className="size-14 rounded-full shrink-0" />
                    <div className="space-y-1.5">
                      <Skeleton className="h-5 w-16 rounded" />
                      <Skeleton className="h-3 w-24 rounded" />
                    </div>
                  </div>
                  {[1,2,3,4,5,6].map(i => (
                    <div key={i} className="flex items-center gap-2">
                      <Skeleton className="size-4 rounded-full" />
                      <Skeleton className="h-3 w-36 rounded" />
                    </div>
                  ))}
                </div>
              ) : error ? (
                <ErrorState message={error} onRetry={handleRetry} />
              ) : (
                <div className="px-5 py-4">
                  {/* Score badge */}
                  <div className="mb-4 flex items-center gap-3">
                    <div
                      className={cn(
                        'flex size-14 shrink-0 items-center justify-center rounded-full text-[1.1rem] font-bold text-white',
                        data!.healthScore.score >= 80 ? 'bg-emerald-500' :
                        data!.healthScore.score >= 50 ? 'bg-amber-400' :
                        'bg-destructive',
                      )}
                    >
                      {data!.healthScore.score}
                    </div>
                    <div>
                      <p className="text-[14px] font-bold text-foreground">
                        {data!.healthScore.score >= 80 ? 'Looking great!' :
                         data!.healthScore.score >= 50 ? 'Almost there' :
                         'Needs attention'}
                      </p>
                      <p className="text-[12px] text-muted-foreground">
                        {data!.healthScore.items.filter(i => i.done).length}/{data!.healthScore.items.length} items complete
                      </p>
                    </div>
                  </div>

                  {/* Checklist */}
                  <ul className="space-y-2" aria-label="Profile completion checklist">
                    {data!.healthScore.items.map(item => (
                      <li key={item.label} className="flex items-center gap-2">
                        <div
                          className={cn(
                            'flex size-4 shrink-0 items-center justify-center rounded-full',
                            item.done ? 'bg-emerald-500' : 'bg-muted',
                          )}
                          aria-hidden
                        >
                          {item.done
                            ? <Check className="size-2.5 text-white" />
                            : <span className="size-1.5 rounded-full bg-muted-foreground/40 block" />
                          }
                        </div>
                        <span
                          className={cn(
                            'text-[13px]',
                            item.done ? 'text-foreground' : 'text-muted-foreground',
                          )}
                        >
                          {item.label}
                        </span>
                      </li>
                    ))}
                  </ul>

                  {data!.healthScore.score < 100 && (
                    <Link
                      href={ROUTES.DASHBOARD_SETTINGS}
                      className="mt-4 flex items-center gap-1 text-[13px] font-medium text-primary hover:underline underline-offset-2"
                    >
                      Complete your profile <ChevronRight className="size-3.5" aria-hidden />
                    </Link>
                  )}
                </div>
              )}
            </DashboardCard>
          </motion.div>

        </div>
      </div>

    </motion.div>
  )
}
