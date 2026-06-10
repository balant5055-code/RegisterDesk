'use client'

import { useState, useEffect, useMemo } from 'react'
import { onAuthStateChanged }           from 'firebase/auth'
import { auth }                         from '@/lib/firebase/auth'
import Link                             from 'next/link'
import {
  BarChart3, CalendarDays, Users, TrendingUp,
  IndianRupee, Loader2, AlertCircle, ArrowRight,
  CheckCircle2,
} from 'lucide-react'
import { cn }                           from '@/lib/utils/cn'
import type { EventsListResponse, EventListItem } from '@/app/api/organizer/events/route'

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

// ─── Stat card ────────────────────────────────────────────────────────────────

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
        <p className="mt-1 text-[12px] text-muted-foreground">{label}</p>
        {sub && <p className="mt-0.5 text-[11px] text-muted-foreground">{sub}</p>}
      </div>
    </div>
  )
}

// ─── Event row ────────────────────────────────────────────────────────────────

function EventRow({ event, rank }: { event: EventListItem; rank: number }) {
  const pct = event.totalCapacity
    ? Math.round((event.totalRegistrations / event.totalCapacity) * 100)
    : null

  return (
    <tr className="hover:bg-muted/20">
      <td className="px-4 py-3 text-center">
        <span className="inline-flex size-6 items-center justify-center rounded-full bg-muted text-[11px] font-bold text-muted-foreground">
          {rank}
        </span>
      </td>
      <td className="px-4 py-3">
        <p className="text-[13px] font-medium text-foreground">{event.name}</p>
        {event.startDate && (
          <p className="text-[11px] text-muted-foreground">{fmtDate(event.startDate)}</p>
        )}
      </td>
      <td className="hidden px-4 py-3 text-right tabular-nums text-[13px] text-foreground sm:table-cell">
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
            <span className="text-[11px] tabular-nums text-muted-foreground">{pct}%</span>
          </div>
        ) : (
          <span className="text-[12px] text-muted-foreground">—</span>
        )}
      </td>
      <td className="hidden px-4 py-3 text-right text-[12.5px] text-muted-foreground lg:table-cell">
        {event.estimatedRevenue > 0 ? fmtINR(event.estimatedRevenue) : 'Free'}
      </td>
      <td className="px-4 py-3 text-right">
        <Link
          href={`/dashboard/events/${event.draftId}`}
          className="inline-flex items-center gap-1 text-[11.5px] font-medium text-primary hover:underline"
        >
          View <ArrowRight className="size-3" />
        </Link>
      </td>
    </tr>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function ReportsHubPage() {
  const [events,  setEvents]  = useState<EventListItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async user => {
      if (!user) { setLoading(false); return }
      try {
        const token = await user.getIdToken()
        const res   = await fetch('/api/organizer/events', {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (!res.ok) throw new Error('Failed to load events')
        const data = await res.json() as EventsListResponse
        setEvents(data.events)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Error')
      } finally {
        setLoading(false)
      }
    })
    return unsub
  }, [])

  const summary = useMemo(() => {
    const total        = events.length
    const published    = events.filter(e => e.status === 'published').length
    const totalRegs    = events.reduce((s, e) => s + e.totalRegistrations, 0)
    const totalRevPaise = events.reduce((s, e) => s + e.estimatedRevenue, 0)
    const totalCap     = events.reduce((s, e) => s + (e.totalCapacity ?? 0), 0)
    const fillRate     = totalCap > 0 ? Math.round((totalRegs / totalCap) * 100) : null
    const topEvents    = [...events]
      .sort((a, b) => b.totalRegistrations - a.totalRegistrations)
      .slice(0, 10)
    return { total, published, totalRegs, totalRevPaise, fillRate, topEvents }
  }, [events])

  return (
    <div className="space-y-6">

      {/* ── Header ── */}
      <div>
        <h1 className="text-[32px] font-bold text-foreground">Analytics</h1>
        <p className="mt-0.5 text-[14px] text-muted-foreground">
          Aggregated performance across all your events.
        </p>
      </div>

      {loading && (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      )}

      {!loading && error && (
        <div className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-700">
          <AlertCircle className="size-4 shrink-0" /> {error}
        </div>
      )}

      {!loading && !error && (
        <>
          {/* ── Summary stats ── */}
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
              sub={summary.fillRate !== null ? 'across events with capacity' : 'no capacity set'}
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

          {/* ── Top events ── */}
          {summary.topEvents.length > 0 ? (
            <div>
              <h2 className="mb-3 text-[14px] font-semibold text-foreground">
                Top Events by Registrations
              </h2>
              <div className="overflow-hidden rounded-xl border border-border">
                <table className="w-full text-[12.5px]">
                  <thead>
                    <tr className="border-b border-border bg-muted/40">
                      <th className="px-4 py-2.5 text-center font-semibold text-muted-foreground">#</th>
                      <th className="px-4 py-2.5 text-left font-semibold text-muted-foreground">Event</th>
                      <th className="hidden px-4 py-2.5 text-right font-semibold text-muted-foreground sm:table-cell">Registrations</th>
                      <th className="hidden px-4 py-2.5 text-left font-semibold text-muted-foreground md:table-cell">Fill Rate</th>
                      <th className="hidden px-4 py-2.5 text-right font-semibold text-muted-foreground lg:table-cell">Revenue</th>
                      <th className="px-4 py-2.5 text-right font-semibold text-muted-foreground">Details</th>
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
            <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-border py-20 text-center">
              <BarChart3 className="size-10 text-muted-foreground/30" aria-hidden />
              <p className="text-[15px] font-semibold text-foreground">No data yet</p>
              <p className="max-w-xs text-[13px] text-muted-foreground">
                Create and publish events to see analytics here.
              </p>
              <Link
                href="/dashboard/events/new/visibility"
                className="mt-1 rounded-xl bg-primary px-5 py-2.5 text-[13px] font-semibold text-white hover:opacity-90"
              >
                Create Event
              </Link>
            </div>
          )}

          {/* ── Status breakdown ── */}
          {events.length > 0 && (
            <div>
              <h2 className="mb-3 text-[14px] font-semibold text-foreground">Event Status Breakdown</h2>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
                {(['draft', 'published', 'registration_closed', 'completed', 'cancelled', 'archived'] as const).map(s => {
                  const count = events.filter(e => e.lifecycleStatus === s).length
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
                      <p className="mt-0.5 text-[11px] text-muted-foreground">{labels[s]}</p>
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
