'use client'

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { cn }    from '@/lib/utils/cn'
import {
  Users, CheckCircle, XCircle, UserCheck, TrendingUp,
  Loader2, RotateCcw, Activity, Clock, Ticket,
  RefreshCw, AlertCircle,
} from 'lucide-react'
import type {
  AttendanceDashboardResponse,
  HourlyBucket,
  PassAttendanceStat,
  RecentCheckIn,
} from '@/app/api/organizer/events/[eventId]/attendance/route'

// ─── Constants ────────────────────────────────────────────────────────────────

const REFRESH_INTERVAL_MS = 30_000

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-IN', {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
}

function fmtTimeShort(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-IN', {
    hour: '2-digit', minute: '2-digit',
  })
}

function timeSince(iso: string): string {
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (secs < 60)   return `${secs}s ago`
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`
  return `${Math.floor(secs / 3600)}h ago`
}

// ─── Stat Card ────────────────────────────────────────────────────────────────

function StatCard({
  icon: Icon, label, value, sub, iconCls, valueCls,
}: {
  icon:     React.ElementType
  label:    string
  value:    string | number
  sub?:     string
  iconCls?: string
  valueCls?: string
}) {
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border bg-card p-4">
      <div className="flex items-center justify-between">
        <span className="text-[13px] font-medium text-muted-foreground">{label}</span>
        <div className={cn('flex size-7 items-center justify-center rounded-lg', iconCls ?? 'bg-muted')}>
          <Icon className="size-3.5 text-muted-foreground" aria-hidden />
        </div>
      </div>
      <p className={cn('text-[24px] font-bold tabular-nums leading-none', valueCls ?? 'text-foreground')}>
        {value}
      </p>
      {sub && <p className="text-[13px] text-muted-foreground">{sub}</p>}
    </div>
  )
}

// ─── Hourly Chart ─────────────────────────────────────────────────────────────

function HourlyChart({ buckets }: { buckets: HourlyBucket[] }) {
  const maxCount = useMemo(() => Math.max(...buckets.map(b => b.count), 1), [buckets])
  const totalCheckIns = useMemo(() => buckets.reduce((s, b) => s + b.count, 0), [buckets])

  if (buckets.length === 0) {
    return (
      <div className="flex h-40 items-center justify-center">
        <p className="text-[13px] italic text-muted-foreground/60">No check-ins yet today</p>
      </div>
    )
  }

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <span className="text-[13px] text-muted-foreground">
          {totalCheckIns} check-in{totalCheckIns !== 1 ? 's' : ''} shown
        </span>
        <span className="text-[13px] text-muted-foreground">Peak: {maxCount}</span>
      </div>

      {/* Bars */}
      <div className="flex h-32 items-end gap-1 sm:gap-1.5">
        {buckets.map(b => {
          const heightPct = maxCount > 0 ? (b.count / maxCount) * 100 : 0
          return (
            <div key={b.hour} className="group relative flex flex-1 flex-col items-center">
              {/* Count label on hover */}
              {b.count > 0 && (
                <span className="mb-0.5 text-[12px] font-semibold tabular-nums text-muted-foreground">
                  {b.count}
                </span>
              )}
              <div className="relative w-full flex-1">
                <div className="absolute inset-0 rounded-sm bg-muted/50" />
                <div
                  className={cn(
                    'absolute bottom-0 left-0 right-0 rounded-t-sm transition-all duration-300',
                    b.count > 0 ? 'bg-primary' : 'bg-transparent',
                  )}
                  style={{ height: `${heightPct}%` }}
                />
              </div>
            </div>
          )
        })}
      </div>

      {/* Hour labels — show every other label to prevent crowding */}
      <div className="mt-1 flex gap-1 sm:gap-1.5">
        {buckets.map((b, i) => (
          <div key={b.hour} className="flex-1 text-center">
            <span className={cn(
              'text-[12px] leading-none text-muted-foreground',
              // Show label every 2 hours to avoid crowding on small screens
              i % 2 !== 0 && 'hidden sm:block',
            )}>
              {b.label}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Recent Check-Ins List ────────────────────────────────────────────────────

function RecentCheckInsList({ items }: { items: RecentCheckIn[] }) {
  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-8 text-center">
        <UserCheck className="size-8 text-muted-foreground/20" aria-hidden />
        <p className="text-[13px] text-muted-foreground">No check-ins yet</p>
      </div>
    )
  }

  return (
    <div className="divide-y divide-border/40">
      {items.map((item, i) => (
        <div
          key={item.registrationId}
          className={cn(
            'flex items-center gap-3 px-4 py-3',
            i === 0 && 'bg-emerald-50/50',
          )}
        >
          {/* Avatar placeholder */}
          <div className={cn(
            'flex size-8 shrink-0 items-center justify-center rounded-full text-[12px] font-bold',
            i === 0 ? 'bg-emerald-100 text-emerald-700' : 'bg-muted text-muted-foreground',
          )}>
            {item.attendeeName.charAt(0).toUpperCase()}
          </div>

          <div className="min-w-0 flex-1">
            <p className="truncate text-[14px] font-semibold text-foreground">
              {item.attendeeName}
            </p>
            <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
              <span className="font-mono">{item.ticketCode}</span>
              <span className="text-muted-foreground/40">·</span>
              <span>{item.passName}</span>
            </div>
          </div>

          <div className="shrink-0 text-right">
            <p className="text-[13px] font-medium text-foreground">{fmtTimeShort(item.checkedInAt)}</p>
            <p className="text-[12px] text-muted-foreground">{timeSince(item.checkedInAt)}</p>
          </div>
        </div>
      ))}
    </div>
  )
}

// ─── Pass Breakdown Table ─────────────────────────────────────────────────────

function PassBreakdown({ stats }: { stats: PassAttendanceStat[] }) {
  if (stats.length === 0) {
    return (
      <p className="py-4 text-center text-[13px] italic text-muted-foreground/60">
        No pass data available
      </p>
    )
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[14px]">
        <thead>
          <tr className="border-b border-border/60">
            {['Pass', 'Capacity', 'Registered', 'Checked In', 'Rate'].map(h => (
              <th
                key={h}
                className="pb-2 text-left text-[12px] font-semibold uppercase tracking-wider text-muted-foreground first:pl-0 last:text-right"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border/40">
          {stats.map(p => (
            <tr key={p.passId}>
              <td className="py-3 font-medium text-foreground">{p.passName}</td>
              <td className="py-3 tabular-nums text-muted-foreground">
                {p.capacity === null ? '∞' : p.capacity.toLocaleString('en-IN')}
              </td>
              <td className="py-3 tabular-nums text-foreground">{p.registered.toLocaleString('en-IN')}</td>
              <td className="py-3 tabular-nums text-emerald-700 font-semibold">
                {p.checkedIn.toLocaleString('en-IN')}
              </td>
              <td className="py-3 text-right">
                <div className="flex items-center justify-end gap-2">
                  <div className="hidden h-1.5 w-16 overflow-hidden rounded-full bg-muted sm:block">
                    <div
                      className={cn(
                        'h-full rounded-full',
                        p.attendancePct >= 80 ? 'bg-emerald-500'
                          : p.attendancePct >= 50 ? 'bg-primary'
                          : 'bg-amber-500',
                      )}
                      style={{ width: `${p.attendancePct}%` }}
                    />
                  </div>
                  <span className="font-semibold tabular-nums text-foreground">
                    {p.attendancePct}%
                  </span>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────

interface AttendanceTabProps {
  eventId: string
  token:   string
}

export default function AttendanceTab({ eventId, token }: AttendanceTabProps) {
  const [data,         setData]         = useState<AttendanceDashboardResponse | null>(null)
  const [loading,      setLoading]      = useState(true)
  const [refreshing,   setRefreshing]   = useState(false)
  const [error,        setError]        = useState<string | null>(null)
  const [lastRefresh,  setLastRefresh]  = useState<Date | null>(null)
  const [countdown,    setCountdown]    = useState(REFRESH_INTERVAL_MS / 1000)

  const tokenRef = useRef(token)
  useEffect(() => { tokenRef.current = token }, [token])

  // ── Fetch ─────────────────────────────────────────────────────────────────

  const fetchData = useCallback(async (silent = false) => {
    if (!tokenRef.current) return
    if (!silent) setLoading(true)
    else setRefreshing(true)
    setError(null)

    try {
      const res = await fetch(`/api/organizer/events/${eventId}/attendance`, {
        headers: { Authorization: `Bearer ${tokenRef.current}` },
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string }
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      const json = await res.json() as AttendanceDashboardResponse
      setData(json)
      setLastRefresh(new Date())
      setCountdown(REFRESH_INTERVAL_MS / 1000)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load attendance data')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [eventId])

  // Initial load
  useEffect(() => {
    if (token) void fetchData(false)
  }, [token, fetchData])

  // Auto-refresh interval
  useEffect(() => {
    if (!token) return
    const interval = setInterval(() => void fetchData(true), REFRESH_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [token, fetchData])

  // Countdown timer (cosmetic — ticks every second)
  useEffect(() => {
    const tick = setInterval(() => {
      setCountdown(prev => {
        if (prev <= 1) return REFRESH_INTERVAL_MS / 1000
        return prev - 1
      })
    }, 1000)
    return () => clearInterval(tick)
  }, [])

  // ── Loading / error ────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="h-24 animate-pulse rounded-xl bg-muted" />
          ))}
        </div>
        <div className="h-64 animate-pulse rounded-xl bg-muted" />
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="h-72 animate-pulse rounded-xl bg-muted" />
          <div className="h-72 animate-pulse rounded-xl bg-muted" />
        </div>
      </div>
    )
  }

  if (error && !data) {
    return (
      <div className="flex flex-col items-center gap-4 py-16 text-center">
        <div className="flex size-12 items-center justify-center rounded-full bg-destructive/10">
          <AlertCircle className="size-6 text-destructive" aria-hidden />
        </div>
        <div>
          <p className="text-[15px] font-semibold text-foreground">Failed to load dashboard</p>
          <p className="mt-1 text-[13px] text-muted-foreground">{error}</p>
        </div>
        <button
          type="button"
          onClick={() => void fetchData(false)}
          className="flex items-center gap-2 rounded-xl border border-border px-4 py-2 text-[14px] font-semibold hover:bg-muted/50"
        >
          <RotateCcw className="size-3.5" aria-hidden /> Retry
        </button>
      </div>
    )
  }

  if (!data) return null

  const {
    totalRegistrations, confirmedRegistrations, cancelledRegistrations,
    checkedInCount, attendanceRate,
    recentCheckIns, passStats, hourlyBuckets,
  } = data

  const rateColor = attendanceRate >= 80 ? 'text-emerald-600'
    : attendanceRate >= 50 ? 'text-primary'
    : 'text-amber-600'

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-5">

      {/* Live header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="relative flex size-2.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
            <span className="relative inline-flex size-2.5 rounded-full bg-emerald-500" />
          </span>
          <span className="text-[15px] font-semibold text-foreground">Live Attendance</span>
          {refreshing && (
            <RefreshCw className="size-3.5 animate-spin text-muted-foreground" aria-hidden />
          )}
        </div>
        <div className="flex items-center gap-3">
          {lastRefresh && (
            <span className="text-[13px] text-muted-foreground">
              Updated {fmtTime(lastRefresh.toISOString())} · refreshes in {countdown}s
            </span>
          )}
          <button
            type="button"
            onClick={() => void fetchData(true)}
            disabled={refreshing}
            className="flex items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 py-1.5 text-[13px] font-medium text-foreground hover:bg-muted/50 disabled:opacity-50"
          >
            <RefreshCw className={cn('size-3', refreshing && 'animate-spin')} aria-hidden />
            Refresh
          </button>
        </div>
      </div>

      {/* Error banner (soft — data still shows) */}
      {error && data && (
        <div className="flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-[13px] text-amber-700">
          <AlertCircle className="size-4 shrink-0" aria-hidden />
          Refresh failed — showing last known data.
        </div>
      )}

      {/* ── Summary metric cards ── */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <StatCard
          icon={Users}
          label="Total Registrations"
          value={totalRegistrations.toLocaleString('en-IN')}
          iconCls="bg-muted"
        />
        <StatCard
          icon={CheckCircle}
          label="Confirmed"
          value={confirmedRegistrations.toLocaleString('en-IN')}
          iconCls="bg-emerald-100"
        />
        <StatCard
          icon={XCircle}
          label="Cancelled"
          value={cancelledRegistrations.toLocaleString('en-IN')}
          iconCls="bg-red-100"
        />
        <StatCard
          icon={UserCheck}
          label="Checked In"
          value={checkedInCount.toLocaleString('en-IN')}
          sub={`of ${confirmedRegistrations} confirmed`}
          iconCls="bg-primary/10"
          valueCls="text-primary"
        />
        <StatCard
          icon={TrendingUp}
          label="Attendance Rate"
          value={`${attendanceRate}%`}
          sub={confirmedRegistrations > 0 ? `${confirmedRegistrations - checkedInCount} not yet in` : undefined}
          iconCls="bg-muted"
          valueCls={rateColor}
        />
      </div>

      {/* ── Attendance progress bar ── */}
      <div className="rounded-xl border border-border bg-card p-4">
        <div className="mb-2 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Activity className="size-4 text-muted-foreground" aria-hidden />
            <span className="text-[15px] font-semibold text-foreground">Overall Attendance</span>
          </div>
          <span className={cn('text-[16px] font-bold tabular-nums', rateColor)}>
            {attendanceRate}%
          </span>
        </div>
        <div className="h-3 overflow-hidden rounded-full bg-muted">
          <div
            className={cn(
              'h-full rounded-full transition-all duration-500',
              attendanceRate >= 80 ? 'bg-emerald-500'
                : attendanceRate >= 50 ? 'bg-primary'
                : 'bg-amber-500',
            )}
            style={{ width: `${attendanceRate}%` }}
          />
        </div>
        <div className="mt-2 flex gap-4 text-[13px] text-muted-foreground">
          <span className="text-emerald-600 font-medium">{checkedInCount} checked in</span>
          <span>{confirmedRegistrations - checkedInCount} remaining</span>
          <span>{cancelledRegistrations} cancelled</span>
        </div>
      </div>

      {/* ── Hourly check-in chart ── */}
      <div className="rounded-xl border border-border bg-card p-4">
        <div className="mb-4 flex items-center gap-2">
          <Clock className="size-4 text-muted-foreground" aria-hidden />
          <span className="text-[15px] font-semibold text-foreground">Hourly Check-In Trend</span>
        </div>
        <HourlyChart buckets={hourlyBuckets} />
      </div>

      {/* ── Bottom two-column section ── */}
      <div className="grid gap-4 lg:grid-cols-2">

        {/* Recent Check-Ins */}
        <div className="overflow-hidden rounded-xl border border-border bg-card">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <div className="flex items-center gap-2">
              <UserCheck className="size-4 text-muted-foreground" aria-hidden />
              <span className="text-[15px] font-semibold text-foreground">Recent Check-Ins</span>
            </div>
            <span className="rounded-full bg-muted px-2 py-0.5 text-[12px] font-semibold text-muted-foreground">
              {recentCheckIns.length}
            </span>
          </div>
          <div className="max-h-[400px] overflow-y-auto">
            <RecentCheckInsList items={recentCheckIns} />
          </div>
        </div>

        {/* Pass Breakdown */}
        <div className="overflow-hidden rounded-xl border border-border bg-card">
          <div className="flex items-center gap-2 border-b border-border px-4 py-3">
            <Ticket className="size-4 text-muted-foreground" aria-hidden />
            <span className="text-[15px] font-semibold text-foreground">Pass Breakdown</span>
          </div>
          <div className="p-4">
            <PassBreakdown stats={passStats} />
          </div>
        </div>
      </div>

      {/* Footer note */}
      <p className="text-center text-[12px] text-muted-foreground/50">
        Auto-refreshes every 30 seconds &middot; Data reflects current event state
      </p>
    </div>
  )
}
