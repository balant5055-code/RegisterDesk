'use client'

import { useEffect, useState } from 'react'
import Link                    from 'next/link'
import { getAuth }             from 'firebase/auth'
import { cn }                  from '@/lib/utils/cn'
import {
  AlertCircle, BarChart3, CalendarDays,
  ChevronRight, Heart, RefreshCw, Users, Activity,
} from 'lucide-react'
import type { AdminStats } from '@/app/api/admin/stats/route'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function paise(n: number) {
  const r = n / 100
  if (r >= 10_00_000) return `₹${(r / 10_00_000).toFixed(2)}L`
  if (r >= 1_000)     return `₹${(r / 1_000).toFixed(2)}K`
  return `₹${r.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function fmt(n: number) {
  return n.toLocaleString('en-IN')
}

async function getToken() {
  const user = getAuth().currentUser
  return user ? user.getIdToken() : ''
}

// ─── KPI card ─────────────────────────────────────────────────────────────────

function KpiCard({
  label, value, sub, icon: Icon, accent, href,
}: {
  label:  string
  value:  string
  sub?:   string
  icon:   React.ElementType
  accent: string
  href?:  string
}) {
  const content = (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="text-[12px] font-medium text-muted-foreground">{label}</p>
        <p className="mt-1 text-[26px] font-bold leading-none tracking-tight text-foreground">
          {value}
        </p>
        {sub && <p className="mt-1 text-[12.5px] text-muted-foreground">{sub}</p>}
      </div>
      <div className={cn('flex size-9 shrink-0 items-center justify-center rounded-lg', accent)}>
        <Icon className="size-4" aria-hidden />
      </div>
    </div>
  )

  if (href) {
    return (
      <Link
        href={href}
        className="group rounded-xl border border-border bg-card p-5 shadow-sm transition-shadow hover:shadow-md"
      >
        {content}
        <p className="mt-3 flex items-center gap-0.5 text-[12px] font-medium text-primary opacity-0 transition-opacity group-hover:opacity-100">
          View <ChevronRight className="size-3" aria-hidden />
        </p>
      </Link>
    )
  }

  return (
    <div className="rounded-xl border border-border bg-card p-5 shadow-sm">
      {content}
    </div>
  )
}

function KpiSkeleton() {
  return (
    <div className="rounded-xl border border-border bg-card p-5 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 space-y-2">
          <div className="h-3 w-24 animate-pulse rounded bg-muted" />
          <div className="h-7 w-20 animate-pulse rounded bg-muted" />
          <div className="h-3 w-32 animate-pulse rounded bg-muted" />
        </div>
        <div className="size-9 animate-pulse rounded-lg bg-muted" />
      </div>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function AdminDashboardPage() {
  const [stats,   setStats]   = useState<AdminStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)

  async function loadStats() {
    setLoading(true)
    setError(null)
    try {
      const token = await getToken()
      const res   = await fetch('/api/admin/stats', {
        headers: { authorization: `Bearer ${token}` },
        cache:   'no-store',
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setStats(await res.json() as AdminStats)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load stats.')
    } finally {
      setLoading(false)
    }
  }

  // Deferred so the initial setState runs off the synchronous effect path.
  useEffect(() => { const t = setTimeout(() => { void loadStats() }, 0); return () => clearTimeout(t) }, [])

  const kpis = stats
    ? [
        {
          label:  'Organizers',
          value:  fmt(stats.organizerCount),
          sub:    'Registered accounts',
          icon:   Users,
          accent: 'bg-primary/10 text-primary',
          href:   undefined,
        },
        {
          label:  'Published Events',
          value:  fmt(stats.eventCount),
          sub:    'Across all organizers',
          icon:   CalendarDays,
          accent: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
          href:   undefined,
        },
        {
          label:  'Campaigns',
          value:  fmt(stats.campaignCount),
          sub:    'Donation campaigns',
          icon:   Heart,
          accent: 'bg-pink-100 text-pink-700 dark:bg-pink-900/30 dark:text-pink-300',
          href:   undefined,
        },
        {
          label:  'Pending Settlements',
          value:  fmt(stats.pendingSettlements),
          sub:    stats.pendingSettlementPaise > 0
                    ? `${paise(stats.pendingSettlementPaise)} outstanding`
                    : 'None outstanding',
          icon:   AlertCircle,
          accent: stats.pendingSettlements > 0
                    ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300'
                    : 'bg-muted text-muted-foreground',
          href:   '/admin/finance',
        },
        {
          label:  'Lifetime Platform Revenue',
          value:  paise(stats.lifetimeGrossPaise),
          sub:    'Gross across all organizers',
          icon:   BarChart3,
          accent: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300',
          href:   '/admin/finance',
        },
      ]
    : []

  return (
    <div className="space-y-6">

      {/* ── Header ── */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-[22px] font-bold tracking-tight text-foreground">Dashboard</h1>
          <p className="mt-0.5 text-[13.5px] text-muted-foreground">
            Platform-wide overview.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/admin/platform-monitor"
            className="flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2 text-[13px] font-medium text-foreground shadow-sm transition-colors hover:bg-muted"
          >
            <Activity className="size-3.5" aria-hidden />
            Platform Monitoring
          </Link>
          <button
            onClick={() => void loadStats()}
            disabled={loading}
            className="flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2 text-[13px] font-medium text-foreground shadow-sm transition-colors hover:bg-muted disabled:opacity-50"
          >
            <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} aria-hidden />
            Refresh
          </button>
        </div>
      </div>

      {/* ── Error ── */}
      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/[0.06] px-4 py-3 text-[13.5px] text-destructive">
          <AlertCircle className="size-4 shrink-0" aria-hidden />
          {error}
        </div>
      )}

      {/* ── KPI grid ── */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        {loading
          ? Array.from({ length: 5 }).map((_, i) => <KpiSkeleton key={i} />)
          : kpis.map(k => (
              <KpiCard
                key={k.label}
                label={k.label}
                value={k.value}
                sub={k.sub}
                icon={k.icon}
                accent={k.accent}
                href={k.href}
              />
            ))
        }
      </div>

      {/* ── Quick actions ── */}
      {!loading && !error && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">

          {/* Settlement queue */}
          <div className="rounded-xl border border-border bg-card p-5 shadow-sm">
            <div className="flex items-center justify-between">
              <h2 className="text-[14px] font-semibold text-foreground">Settlement Queue</h2>
              <Link
                href="/admin/finance"
                className="text-[12.5px] font-medium text-primary hover:underline"
              >
                Manage →
              </Link>
            </div>
            <p className="mt-2 text-[13px] text-muted-foreground">
              {stats && stats.pendingSettlements > 0
                ? `${stats.pendingSettlements} request${stats.pendingSettlements === 1 ? '' : 's'} pending — ${paise(stats.pendingSettlementPaise)} to be processed.`
                : 'No pending settlement requests.'}
            </p>
          </div>

          {/* Release engine */}
          <div className="rounded-xl border border-border bg-card p-5 shadow-sm">
            <div className="flex items-center justify-between">
              <h2 className="text-[14px] font-semibold text-foreground">T+2 Release Engine</h2>
              <Link
                href="/admin/finance"
                className="text-[12.5px] font-medium text-primary hover:underline"
              >
                Finance →
              </Link>
            </div>
            <p className="mt-2 text-[13px] text-muted-foreground">
              Run manually from the Finance console to move eligible pending balances
              to available.
            </p>
          </div>

        </div>
      )}

    </div>
  )
}
