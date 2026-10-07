'use client'

// Organizer Analytics & Insights (RD-ANA-01). A per-event deep-dive derived
// entirely from existing data via /api/organizer/analytics/[eventId]. Reuses the
// dashboard cards (MetricCard/DashboardCard/Widget) + the shared chart primitives.
// Export (CSV/XLSX/PDF) reuses the lib/reports serializer.

import { useEffect, useState, type ReactNode } from 'react'
import { auth } from '@/lib/firebase/auth'
import {
  Loader2, BarChart3, Banknote, Ticket, CheckCircle2, TrendingUp, CreditCard,
  Percent, Users, Download, Gift, AlertTriangle,
} from 'lucide-react'
import { MetricCard } from '@/components/dashboard/MetricCard'
import { DashboardCard } from '@/components/dashboard/DashboardCard'
import { Widget } from '@/components/dashboard/Widget'
import { Bars, HBars, Donut, Funnel } from '@/components/analytics/Charts'
import { AnalyticsModuleNav } from '@/components/analytics/AnalyticsModuleNav'
import type { EventAnalytics } from '@/lib/analytics/eventAnalytics'
import type { MaybeMoney } from '@/lib/finance/financeAnalytics'

const rupees = (p: number) => `₹${Math.round(p / 100).toLocaleString('en-IN')}`

/**
 * RD-ANALYTICS-01 · what a money row reads as when its source could not be read.
 *
 * The service now returns null / ledgerAvailable:false instead of the zeros a failed
 * query used to leave behind, and this is the other half of that: "₹0" and "we could not
 * measure this" must never look the same on screen.
 */
const UNAVAILABLE = 'Unavailable'

/**
 * RD-ANALYTICS-02 · render a canonical money value, or say why there isn't one.
 *
 * Every financial figure is now MaybeMoney, so "we could not read this" arrives as data
 * rather than as a zero that looks like an answer.
 */
const rupeesOf = (m: MaybeMoney): string => (m.ok ? rupees(m.paise) : UNAVAILABLE)

/**
 * RD-ANALYTICS-03 · a count, or an em dash.
 *
 * Counts arrive from aggregates now and are `number | null`. "0" and "we could not read
 * it" must not look the same on a KPI card.
 */
const countOf = (v: number | null): string => (v === null ? '—' : String(v))
const pctOf   = (v: number | null): string => (v === null ? '—' : `${v}%`)

async function getToken(): Promise<string> {
  const u = auth.currentUser
  if (!u) throw new Error('Not authenticated')
  return u.getIdToken()
}

interface EventOpt { slug: string; name: string }

export default function AnalyticsPage() {
  const [events, setEvents]   = useState<EventOpt[]>([])
  const [eventId, setEventId] = useState('')
  const [data, setData]       = useState<EventAnalytics | null>(null)
  const [loadingEvents, setLoadingEvents] = useState(true)
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState<string | null>(null)
  const [exporting, setExporting] = useState<string | null>(null)

  // Load the workspace's events (reuses the licenses endpoint).
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const token = await getToken()
        const res = await fetch('/api/organizer/licenses', { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' })
        if (res.ok && alive) {
          const d = await res.json() as { licenses: { slug: string; eventName: string }[] }
          const opts = d.licenses.map(l => ({ slug: l.slug, name: l.eventName }))
          setEvents(opts)
          if (opts.length > 0) setEventId(opts[0].slug)
        }
      } catch (e) { if (alive) setError(e instanceof Error ? e.message : 'Failed to load events') }
      finally { if (alive) setLoadingEvents(false) }
    })()
    return () => { alive = false }
  }, [])

  // Load analytics for the selected event. State updates run inside a deferred
  // task (setTimeout) so no setState fires synchronously in the effect body.
  useEffect(() => {
    if (!eventId) return
    let alive = true
    const t = setTimeout(() => { void (async () => {
      setLoading(true); setError(null)
      try {
        const token = await getToken()
        const res = await fetch(`/api/organizer/analytics/${eventId}`, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' })
        if (!res.ok) throw new Error(`Request failed (${res.status})`)
        const d = await res.json() as { analytics: EventAnalytics }
        if (alive) setData(d.analytics)
      } catch (e) { if (alive) setError(e instanceof Error ? e.message : 'Failed to load analytics') }
      finally { if (alive) setLoading(false) }
    })() }, 0)
    return () => { alive = false; clearTimeout(t) }
  }, [eventId])

  async function exportAs(format: 'csv' | 'xlsx' | 'pdf') {
    if (!eventId) return
    setExporting(format)
    try {
      const token = await getToken()
      const res = await fetch(`/api/organizer/analytics/${eventId}?format=${format}`, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' })
      if (!res.ok) throw new Error(`Export failed (${res.status})`)
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = Object.assign(document.createElement('a'), { href: url, download: `analytics-${eventId}.${format}` })
      document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url)
    } catch (e) { setError(e instanceof Error ? e.message : 'Export failed') }
    finally { setExporting(null) }
  }

  if (loadingEvents) return <div className="flex justify-center py-20"><Loader2 className="size-6 animate-spin text-muted-foreground" /></div>

  return (
    <div className="space-y-6">
      {/* RD-ANALYTICS-12-13 · the module strip.
          This page is the sidebar's Analytics destination, and until now it was a dead end:
          the five modules of the Analytics workspace had no link from anywhere, including
          from here. The strip is the only change to this page — its layout, data, exports
          and event picker are exactly as they were. */}
      <AnalyticsModuleNav />
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-xl bg-primary/[0.09] text-primary"><BarChart3 className="size-5" /></div>
          <div>
            <h1 className="text-[24px] font-bold tracking-tight text-foreground">Analytics</h1>
            <p className="text-[13.5px] text-muted-foreground">Insights for each of your events — registrations, revenue, funnel, and communication.</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select value={eventId} onChange={e => setEventId(e.target.value)} className="rounded-lg border border-border bg-background px-3 py-2 text-[13px]">
            {events.length === 0 && <option value="">No published events</option>}
            {events.map(ev => <option key={ev.slug} value={ev.slug}>{ev.name}</option>)}
          </select>
          {(['csv', 'xlsx', 'pdf'] as const).map(f => (
            <button key={f} onClick={() => exportAs(f)} disabled={!eventId || exporting !== null}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-[12.5px] font-medium text-foreground hover:bg-muted disabled:opacity-50">
              {exporting === f ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}{f.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      {error && <div className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-[13.5px] text-destructive">{error}</div>}

      {/*
        RD-ANALYTICS-01 · the truncation disclosure.

        `truncated` has always been computed by the service and has always been written into
        the CSV/XLSX/PDF exports — but it never reached the screen, so the page and its own
        export disagreed about whether the numbers were complete. Above the cap the figures
        below are derived from the first 5,000 registrations only, which on a 20,000-person
        event is roughly a quarter of it, presented until now as the whole.

        The cap itself is NOT removed here — that is RD-ANALYTICS-03, which replaces the scan
        with the counters and daily rollups the dashboard already uses. This phase only stops
        the page claiming to know something it does not.
      */}
      {/*
        RD-ANALYTICS-03 · the "first 5,000 registrations" notice is GONE, because the cap it
        described is gone: counts come from aggregates and trends from the daily rollups, so
        the registration figures are complete at any event size.

        What replaces it is narrower and still honest — the remaining capped sources name
        themselves. Communications, reminders and certificates already render their own
        unavailable states, so only the two that would otherwise pass unnoticed are listed.
      */}
      {data && (() => {
        const partial = [
          !data.limits.ledger    && 'payment ledger',
          !data.limits.passValue && 'per-pass revenue',
        ].filter(Boolean) as string[]
        if (partial.length === 0) return null
        return (
          <div role="status"
            className="flex items-start gap-2.5 rounded-xl border border-amber-500/35 bg-amber-500/[0.07] px-4 py-3 text-[13px] text-foreground">
            <AlertTriangle className="mt-px size-4 shrink-0 text-amber-600" aria-hidden />
            <p>
              <strong className="font-semibold">Some figures are incomplete.</strong>{' '}
              Could not be fully measured for this event: {partial.join(' and ')}. Registration
              counts and trends are complete.
            </p>
          </div>
        )
      })()}

      {events.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border py-16 text-center text-muted-foreground">Publish an event to see analytics.</div>
      ) : loading || !data ? (
        <div className="flex justify-center py-20"><Loader2 className="size-6 animate-spin text-muted-foreground" /></div>
      ) : (
        <>
          {/* KPI cards */}
          <section className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-8">
            {/*
              RD-ANALYTICS-02 · "Revenue" is the CANONICAL confirmed ticket revenue —
              Σ amount over confirmed registrations, the same figure the Dashboard, the
              Events list and Finance publish, read through the same helper. It used to be
              Σ amount over paymentStatus 'paid', which counted cancelled-but-paid rows and
              dropped confirmed-but-refunded ones, and was then overwritten by the gateway
              ledger's gross whenever that read succeeded.

              Absent — not zeroed — for a caller without the finance permission.
            */}
            {data.financial && (
              <MetricCard label="Revenue" value={rupeesOf(data.financial.confirmedRevenuePaise)}
                hint="Confirmed registrations" icon={Banknote} iconColor="text-emerald-700" iconBg="bg-emerald-50" />
            )}
            <MetricCard label="Registrations" value={countOf(data.kpis.registrations)} icon={Ticket} iconColor="text-primary" iconBg="bg-primary/10" />
            <MetricCard label="Paid" value={countOf(data.kpis.paidCharged)} icon={CreditCard} iconColor="text-violet-700" iconBg="bg-violet-50" />
            <MetricCard label="Free" value={countOf(data.kpis.free)} icon={Gift} iconColor="text-sky-700" iconBg="bg-sky-50" />
            <MetricCard label="Pending" value={countOf(data.kpis.paymentPending)} icon={Percent} iconColor="text-amber-700" iconBg="bg-amber-50" />
            <MetricCard label="Checked in" value={countOf(data.kpis.checkedIn)} icon={CheckCircle2} iconColor="text-emerald-700" iconBg="bg-emerald-50" />
            <MetricCard label="Conversion" value={pctOf(data.kpis.conversionPct)} hint="Paid / registrations" icon={TrendingUp} iconColor="text-rose-700" iconBg="bg-rose-50" />
            <MetricCard label="Capacity used" value={pctOf(data.kpis.capacityUsedPct)} hint={data.kpis.remaining == null ? 'Unlimited' : `${data.kpis.remaining} left`} icon={Users} iconColor="text-slate-700" iconBg="bg-slate-100" />
          </section>

          {/* Charts */}
          <div className="grid gap-4 lg:grid-cols-2">
            <Widget title="Registrations by day" state={data.registrationsByDay ? 'ready' : 'unknown'}
              unknownText="Daily rollups could not be read for this event.">
              {data.registrationsByDay && <div className="px-5 pb-4 pt-3"><Bars data={data.registrationsByDay} /></div>}
            </Widget>
            {data.financial && (
              <Widget title="Revenue by day" state={data.revenueByDay ? 'ready' : 'unknown'}
                unknownText="Daily rollups could not be read for this event.">
                {data.revenueByDay && <div className="px-5 pb-4 pt-3"><Bars data={data.revenueByDay} format={rupees} /></div>}
              </Widget>
            )}
            <DashboardCard title="Payment status"><div className="px-5 pb-4 pt-3"><Donut segments={data.paymentStatus} /></div></DashboardCard>
            <Widget title="Check-ins by day" state={data.checkInsByDay ? 'ready' : 'unknown'}
              unknownText="Daily rollups could not be read for this event.">
              {data.checkInsByDay && <div className="px-5 pb-4 pt-3"><Bars data={data.checkInsByDay} /></div>}
            </Widget>
            <DashboardCard title="Pass sales"><div className="px-5 pb-4 pt-3">{data.passSales.length ? <HBars data={data.passSales} /> : <p className="text-[13px] text-muted-foreground">No passes sold yet.</p>}</div></DashboardCard>
            {/*
              COUPON PERFORMANCE — the figures here are the one part of this page that the
              `truncated` cap does NOT apply to. They used to be derived from the capped
              registration scan (first 5,000 docs), which silently under-reported every coupon
              on a large event; they now come from the coupon documents plus a single sum()
              aggregate, so they are exact at any size and cost O(#coupons) to produce.

              Usage counts are the coupon's own `currentUses` — the same counter the validator
              enforces `maxUses` against — so "84 / 100" here agrees with what the 101st
              attempt will be told.
            */}
            <Widget title="Coupon performance"
              state={!data.couponPerformance ? 'unknown' : data.couponPerformance.rows.length ? 'ready' : 'empty'}
              unknownText="Coupon performance includes discount totals, which need the finance permission."
              emptyText="No coupons configured for this event."
              action={!data.couponPerformance ? undefined : data.couponPerformance.discountUnavailable
                ? <span className="text-[12px] text-muted-foreground">Discount total unavailable</span>
                : data.couponPerformance.totalDiscountPaise > 0
                  ? <span className="text-[12px] font-semibold text-primary">{rupees(data.couponPerformance.totalDiscountPaise)} off</span>
                  : undefined}>
              {data.couponPerformance && <div className="space-y-3 px-5 pb-4 pt-3">
                <div className="flex flex-wrap gap-x-6 gap-y-1 text-[12px] text-muted-foreground">
                  <span><strong className="text-foreground">{data.couponPerformance.totalRedemptions}</strong> redemptions</span>
                  <span><strong className="text-foreground">{data.couponPerformance.activeCoupons}</strong> active</span>
                  <span><strong className="text-foreground">{data.couponPerformance.totalCoupons}</strong> configured</span>
                </div>
                <ul className="space-y-2.5">
                  {data.couponPerformance.rows.slice(0, 8).map(c => (
                    <li key={c.code}>
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="truncate font-mono text-[12px] font-semibold text-foreground">{c.code}</span>
                        <span className="shrink-0 text-[12px] text-muted-foreground">
                          {c.maxUses === null ? `${c.uses} used` : `${c.uses} / ${c.maxUses} used`}
                                        </span>
                      </div>
                      {/* Only a capped coupon gets a progress bar — a share of unlimited is
                          meaningless, so it is left out rather than drawn as 0%. */}
                      {c.percentUsed !== null && (
                        <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                          {/* RD-DASH-07 — `percentUsed` is no longer clamped at the source, because
                              clamping the FIGURE hid coupons that are genuinely over a lowered cap.
                              The WIDTH is clamped here instead, which is where clamping belongs: a
                              bar cannot be 104% long, but the number can and should say 104%. */}
                          <div className="h-full rounded-full bg-primary" style={{ width: `${Math.min(100, c.percentUsed)}%` }} />
                        </div>
                      )}
                      {c.remaining !== null && (
                        <p className="mt-0.5 text-[11px] text-muted-foreground">{c.remaining} remaining</p>
                      )}
                    </li>
                  ))}
                </ul>
              </div>}
            </Widget>
          </div>

          {/* Funnel + Financial */}
          <div className="grid gap-4 lg:grid-cols-2">
            <DashboardCard title="Conversion funnel"><div className="px-5 pb-4 pt-3"><Funnel steps={data.funnel} /></div></DashboardCard>
            {/*
              RD-ANALYTICS-02 · six DIFFERENT financial quantities, each labelled as itself.
              "Confirmed ticket revenue" (registrations) and "Gross collected" (the payment
              ledger) are separate populations and are no longer allowed to substitute for
              one another — the old card showed one row called "Gross revenue" whose meaning
              depended on whether a Firestore read had succeeded.
            */}
            {data.financial && (
            <DashboardCard title="Financial breakdown">
              <dl className="divide-y divide-border">
                <Row k="Confirmed ticket revenue" v={rupeesOf(data.financial.confirmedRevenuePaise)} />
                <Row k="Gross collected (gateway)" v={rupeesOf(data.financial.grossPaise)} muted />
                <Row k="Platform fee" v={data.financial.platformFeePaise.ok ? `– ${rupeesOf(data.financial.platformFeePaise)}` : UNAVAILABLE} muted />
                <Row k="GST" v={data.financial.gstPaise.ok ? `– ${rupeesOf(data.financial.gstPaise)}` : UNAVAILABLE} muted />
                <Row k="Gateway fee" v={data.financial.gatewayFeePaise.ok ? `– ${rupeesOf(data.financial.gatewayFeePaise)}` : UNAVAILABLE} muted />
                {/* Completed refunds only, from the refund ledger. Money still in flight is
                    counted beneath as a COUNT, never added to this amount. */}
                <Row k={data.financial.refundCount === null ? 'Refunds completed' : `Refunds completed (${data.financial.refundCount})`}
                     v={data.financial.refundsPaise.ok ? `– ${rupeesOf(data.financial.refundsPaise)}` : UNAVAILABLE} muted />
                {(data.kpis.refundPending ?? 0) > 0 && (
                  <Row k="Refunds in progress" v={`${data.kpis.refundPending} registration${data.kpis.refundPending === 1 ? '' : 's'}`} muted />
                )}
                <Row k="Communication cost" v={data.financial.communicationCostPaise.ok ? `– ${rupeesOf(data.financial.communicationCostPaise)}` : UNAVAILABLE} muted />
                <Row k="Net settlement" v={rupeesOf(data.financial.netPaise)} />
                {/* The basis is in the label, because it is an estimate over three sources
                    and is published only when all three of them actually read. */}
                <Row k="Est. profit (net – refunds – comms)" v={rupeesOf(data.financial.profitEstimatePaise)} strong />
              </dl>
            </DashboardCard>
            )}
          </div>

          {/* Communication + reminders + traffic (no data) */}
          <div className="grid gap-4 lg:grid-cols-3">
            {/* null ⇒ the emailLogs / scheduledReminders read failed. Four zeros would say
                "nothing was ever sent", which is a different statement entirely — so these
                fall back to the SAME 'unknown' state the Traffic sources widget beside them
                already uses, rather than a new one. */}
            <Widget title="Communication performance" state={data.communication ? 'ready' : 'unknown'}
              unknownText="Communication data could not be read for this event.">
              {data.communication && (
                <div className="grid grid-cols-2 gap-px overflow-hidden bg-border">
                  <Mini label="Sent" value={data.communication.sent} />
                  <Mini label="Delivered" value={data.communication.delivered} />
                  <Mini label="Failed" value={data.communication.failed} />
                  {data.financial && <Mini label="Cost" value={rupeesOf(data.financial.communicationCostPaise)} />}
                </div>
              )}
            </Widget>
            <Widget title="Reminder performance" state={data.reminders ? 'ready' : 'unknown'}
              unknownText="Reminder data could not be read for this event.">
              {data.reminders && (
                <div className="grid grid-cols-2 gap-px overflow-hidden bg-border">
                  <Mini label="Scheduled" value={data.reminders.scheduled} />
                  <Mini label="Sent" value={data.reminders.sent} />
                  <Mini label="Failed" value={data.reminders.failed} />
                  <Mini label="Recipients" value={data.reminders.recipients} />
                </div>
              )}
            </Widget>
            <Widget title="Traffic sources" state="unknown"
              unknownText="Referral & traffic-source tracking isn't captured yet — registrations don't record a source." />
          </div>
        </>
      )}
    </div>
  )
}

function Row({ k, v, muted, strong }: { k: string; v: string; muted?: boolean; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between px-5 py-2.5">
      <dt className="text-[13px] text-muted-foreground">{k}</dt>
      <dd className={strong ? 'text-[14px] font-bold text-foreground tabular-nums' : muted ? 'text-[14px] text-muted-foreground tabular-nums' : 'text-[14px] font-medium text-foreground tabular-nums'}>{v}</dd>
    </div>
  )
}

function Mini({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="bg-card px-4 py-3">
      <p className="text-[12px] text-muted-foreground">{label}</p>
      <p className="mt-1 text-[18px] font-bold tabular-nums text-foreground">{value}</p>
    </div>
  )
}
