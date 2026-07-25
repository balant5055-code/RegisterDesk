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

const sum = (a: ChartPoint[]) => a.reduce((s, d) => s + d.value, 0)

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
  revenueTrend, regTrend, passDist, regStatus, eventPerf, revenue30Paise, regs30,
}: {
  revenueTrend:   ChartPoint[]
  regTrend:       ChartPoint[]
  passDist:       ChartPoint[]
  regStatus:      ChartPoint[]
  eventPerf:      ChartPoint[]
  revenue30Paise: number
  regs30:         number
}) {
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
          empty={sum(passDist) <= 0}
          emptyLabel="No paid registrations yet."
        >
          <HBars data={passDist} />
        </ChartPanel>

        <ChartPanel
          title="Registration status"
          viewHref="/dashboard/registrations"
          empty={sum(regStatus) <= 0}
          emptyLabel="No registrations yet."
        >
          <Donut segments={regStatus} />
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
