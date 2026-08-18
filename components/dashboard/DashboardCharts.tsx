'use client'

// RD-DASHBOARD-02 Phase 1 — Dashboard chart section (lazy-loaded).
//
// This module is imported via React.lazy from the dashboard page, so the SVG/chart
// primitives (components/analytics/Charts) are code-split into a separate chunk that
// loads only after the dashboard payload arrives — the initial page bundle stays light.
//
// Every series is derived by the page from the SINGLE /api/organizer/dashboard payload
// (no fetching here) and passed in as plain ChartPoint[] — this component is purely
// presentational. ONE wrapper (ChartPanel) frames every chart with a consistent card,
// heading, optional accent subtitle, and a graceful "degrade" state when a series is
// empty, so no chart ever renders as a blank/one-bar artifact.

import { TrendingUp } from 'lucide-react'
import { Bars, HBars, Donut, type ChartPoint } from '@/components/analytics/Charts'
import { DashboardCard } from '@/components/dashboard/DashboardCard'
import { formatINR } from '@/components/event-templates/shared/utils/format'
import type { PassRow, RegistrationTotals } from '@/lib/analytics/dashboardAnalytics'

const sum = (a: ChartPoint[]) => a.reduce((s, d) => s + d.value, 0)
const n   = (v: number) => v.toLocaleString('en-IN')

/** Percentage of a total. Returns null when the base is 0 — never renders a fake "0%". */
function pct(part: number, total: number): string | null {
  if (total <= 0) return null
  return `${Math.round((part / total) * 1000) / 10}%`
}

// ─── The single chart wrapper ───────────────────────────────────────────────────

function ChartPanel({
  title, viewHref, subtitle, empty, emptyLabel, children,
}: {
  title:       string
  viewHref?:   string
  subtitle?:   React.ReactNode
  empty:       boolean
  emptyLabel:  string
  children:    React.ReactNode
}) {
  return (
    <DashboardCard title={title} viewHref={viewHref}>
      <div className="px-5 py-4">
        {subtitle && !empty && <p className="mb-3 text-[12.5px] text-muted-foreground">{subtitle}</p>}
        {empty ? (
          <div className="flex h-[132px] flex-col items-center justify-center gap-1.5 text-center">
            <TrendingUp className="size-5 text-muted-foreground/40" aria-hidden />
            <p className="text-[12.5px] text-muted-foreground">{emptyLabel}</p>
          </div>
        ) : children}
      </div>
    </DashboardCard>
  )
}

// ─── Section ────────────────────────────────────────────────────────────────────

export default function DashboardCharts({
  revenueTrend, regTrend, passDist, passRows, regStatus, regTotals,
  passCancelledUnavailable, eventPerf, revenue30Paise, regs30,
}: {
  revenueTrend:   ChartPoint[]
  regTrend:       ChartPoint[]
  passDist:       ChartPoint[]
  passRows:       PassRow[]
  regStatus:      ChartPoint[]
  regTotals:      RegistrationTotals
  passCancelledUnavailable?: boolean
  eventPerf:      ChartPoint[]
  revenue30Paise: number
  regs30:         number
}) {
  // Show the cancelled column only when EVERY event's split was computed. A partial split
  // would print 0 for events whose cancellations simply could not be attributed.
  const showCancelled = !passCancelledUnavailable && passRows.some(p => p.cancelled > 0)
  return (
    <div className="space-y-4">
      {/* Trends — two wide panels */}
      <div className="grid gap-4 lg:grid-cols-2">
        <ChartPanel
          title="Revenue trend"
          viewHref="/dashboard/finance"
          empty={revenue30Paise <= 0}
          emptyLabel="No revenue in the last 30 days yet."
          subtitle={<><span className="font-semibold text-emerald-600">{formatINR(revenue30Paise / 100)}</span> collected in the last 30 days</>}
        >
          <Bars data={revenueTrend} height={132} format={n => formatINR(n)} />
        </ChartPanel>

        <ChartPanel
          title="Registration trend"
          viewHref="/dashboard/registrations"
          empty={regs30 <= 0}
          emptyLabel="No registrations in the last 30 days yet."
          subtitle={<><span className="font-semibold text-sky-600">{regs30.toLocaleString('en-IN')}</span> registrations in the last 30 days</>}
        >
          <Bars data={regTrend} height={132} />
        </ChartPanel>
      </div>

      {/* Breakdowns — three panels */}
      <div className="grid gap-4 lg:grid-cols-3">
        <ChartPanel
          title="Pass distribution"
          empty={passRows.length === 0}
          emptyLabel="No registrations yet."
          subtitle="Confirmed by pass · all events, all time"
        >
          <HBars data={passDist} />
          {showCancelled && (
            <dl className="mt-3 space-y-1 border-t border-border pt-2.5">
              {passRows.map(p => (
                <div key={p.label} className="flex items-baseline justify-between gap-3 text-[12px]">
                  <dt className="truncate text-muted-foreground">{p.label}</dt>
                  <dd className="shrink-0 tabular-nums">
                    <span className="font-semibold text-foreground">{n(p.count)}</span>
                    <span className="text-muted-foreground"> confirmed</span>
                    {p.cancelled > 0 && (
                      <>
                        <span className="text-muted-foreground"> · </span>
                        <span className="font-semibold text-red-600">{n(p.cancelled)}</span>
                        <span className="text-muted-foreground"> cancelled</span>
                      </>
                    )}
                    <span className="text-muted-foreground"> · {n(p.total)} total</span>
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </ChartPanel>

        <ChartPanel
          title="Registration status"
          viewHref="/dashboard/registrations"
          empty={regTotals.total <= 0}
          emptyLabel="No registrations yet."
          subtitle={<><span className="font-semibold text-foreground">{n(regTotals.total)}</span> registrations · all events, all time</>}
        >
          <Donut segments={regStatus} />
          {/* Counts AND shares from ONE source, so the legend can never disagree with the
              donut. A status that is genuinely zero is still listed — "0 cancelled" is
              information; omitting it would leave the reader guessing. */}
          <dl className="mt-3 space-y-1 border-t border-border pt-2.5">
            {([
              ['Confirmed',  regTotals.confirmed],
              ['Pending',    regTotals.pending],
              ['Waitlisted', regTotals.waitlisted],
              ['Cancelled',  regTotals.cancelled],
              ['Rejected',   regTotals.rejected],
            ] as Array<[string, number]>).map(([label, value]) => (
              <div key={label} className="flex items-baseline justify-between gap-3 text-[12px]">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="shrink-0 tabular-nums">
                  <span className="font-semibold text-foreground">{n(value)}</span>
                  {pct(value, regTotals.total) && (
                    <span className="text-muted-foreground"> · {pct(value, regTotals.total)}</span>
                  )}
                </dd>
              </div>
            ))}
          </dl>
        </ChartPanel>

        <ChartPanel
          title="Event performance"
          viewHref="/dashboard/events"
          empty={sum(eventPerf) <= 0}
          emptyLabel="No registrations across your events yet."
        >
          <HBars data={eventPerf} />
        </ChartPanel>
      </div>
    </div>
  )
}
