'use client'

// Organizer Analytics & Insights (RD-ANA-01). A per-event deep-dive derived
// entirely from existing data via /api/organizer/analytics/[eventId]. Reuses the
// dashboard cards (MetricCard/DashboardCard/Widget) + the shared chart primitives.
// Export (CSV/XLSX/PDF) reuses the lib/reports serializer.

import { useEffect, useState, type ReactNode } from 'react'
import { auth } from '@/lib/firebase/auth'
import {
  Loader2, BarChart3, Banknote, Ticket, CheckCircle2, TrendingUp, CreditCard,
  Percent, Users, Download, Gift,
} from 'lucide-react'
import { MetricCard } from '@/components/dashboard/MetricCard'
import { DashboardCard } from '@/components/dashboard/DashboardCard'
import { Widget } from '@/components/dashboard/Widget'
import { Bars, HBars, Donut, Funnel } from '@/components/analytics/Charts'
import type { EventAnalytics } from '@/lib/analytics/eventAnalytics'

const rupees = (p: number) => `₹${Math.round(p / 100).toLocaleString('en-IN')}`

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

      {events.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border py-16 text-center text-muted-foreground">Publish an event to see analytics.</div>
      ) : loading || !data ? (
        <div className="flex justify-center py-20"><Loader2 className="size-6 animate-spin text-muted-foreground" /></div>
      ) : (
        <>
          {/* KPI cards */}
          <section className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-8">
            <MetricCard label="Revenue" value={rupees(data.kpis.revenuePaise)} icon={Banknote} iconColor="text-emerald-700" iconBg="bg-emerald-50" />
            <MetricCard label="Registrations" value={String(data.kpis.registrations)} icon={Ticket} iconColor="text-primary" iconBg="bg-primary/10" />
            <MetricCard label="Paid" value={String(data.kpis.paid)} icon={CreditCard} iconColor="text-violet-700" iconBg="bg-violet-50" />
            <MetricCard label="Free" value={String(data.kpis.free)} icon={Gift} iconColor="text-sky-700" iconBg="bg-sky-50" />
            <MetricCard label="Pending" value={String(data.kpis.pending)} icon={Percent} iconColor="text-amber-700" iconBg="bg-amber-50" />
            <MetricCard label="Checked in" value={String(data.kpis.checkedIn)} icon={CheckCircle2} iconColor="text-emerald-700" iconBg="bg-emerald-50" />
            <MetricCard label="Conversion" value={`${data.kpis.conversionPct}%`} hint="Paid / registrations" icon={TrendingUp} iconColor="text-rose-700" iconBg="bg-rose-50" />
            <MetricCard label="Capacity used" value={`${data.kpis.capacityUsedPct}%`} hint={data.kpis.remaining == null ? 'Unlimited' : `${data.kpis.remaining} left`} icon={Users} iconColor="text-slate-700" iconBg="bg-slate-100" />
          </section>

          {/* Charts */}
          <div className="grid gap-4 lg:grid-cols-2">
            <DashboardCard title="Registrations by day"><div className="px-5 pb-4 pt-3"><Bars data={data.registrationsByDay} /></div></DashboardCard>
            <DashboardCard title="Revenue by day"><div className="px-5 pb-4 pt-3"><Bars data={data.revenueByDay} format={rupees} /></div></DashboardCard>
            <DashboardCard title="Payment status"><div className="px-5 pb-4 pt-3"><Donut segments={data.paymentStatus} /></div></DashboardCard>
            <DashboardCard title="Check-ins by day"><div className="px-5 pb-4 pt-3"><Bars data={data.checkInsByDay} /></div></DashboardCard>
            <DashboardCard title="Pass sales"><div className="px-5 pb-4 pt-3">{data.passSales.length ? <HBars data={data.passSales} /> : <p className="text-[13px] text-muted-foreground">No passes sold yet.</p>}</div></DashboardCard>
            <Widget title="Coupon usage" state={data.couponUsage.length ? 'ready' : 'empty'} emptyText="No coupons redeemed."
              action={data.couponDiscountPaise > 0 ? <span className="text-[12px] font-semibold text-primary">{rupees(data.couponDiscountPaise)} off</span> : undefined}>
              <div className="px-5 pb-4 pt-3"><HBars data={data.couponUsage} /></div>
            </Widget>
          </div>

          {/* Funnel + Financial */}
          <div className="grid gap-4 lg:grid-cols-2">
            <DashboardCard title="Conversion funnel"><div className="px-5 pb-4 pt-3"><Funnel steps={data.funnel} /></div></DashboardCard>
            <DashboardCard title="Financial breakdown">
              <dl className="divide-y divide-border">
                <Row k="Gross revenue" v={rupees(data.financial.grossPaise)} />
                <Row k="Platform fee" v={`– ${rupees(data.financial.platformFeePaise)}`} muted />
                <Row k="GST" v={`– ${rupees(data.financial.gstPaise)}`} muted />
                <Row k="Gateway fee" v={`– ${rupees(data.financial.gatewayFeePaise)}`} muted />
                <Row k="Refunds" v={`– ${rupees(data.financial.refundsPaise)}`} muted />
                <Row k="Communication cost" v={`– ${rupees(data.financial.communicationCostPaise)}`} muted />
                <Row k="Net settlement" v={rupees(data.financial.netPaise)} />
                <Row k="Profit (est.)" v={rupees(data.financial.profitEstimatePaise)} strong />
              </dl>
            </DashboardCard>
          </div>

          {/* Communication + reminders + traffic (no data) */}
          <div className="grid gap-4 lg:grid-cols-3">
            <DashboardCard title="Communication performance">
              <div className="grid grid-cols-2 gap-px overflow-hidden bg-border">
                <Mini label="Sent" value={data.communication.sent} />
                <Mini label="Delivered" value={data.communication.delivered} />
                <Mini label="Failed" value={data.communication.failed} />
                <Mini label="Cost" value={rupees(data.communication.costPaise)} />
              </div>
            </DashboardCard>
            <DashboardCard title="Reminder performance">
              <div className="grid grid-cols-2 gap-px overflow-hidden bg-border">
                <Mini label="Scheduled" value={data.reminders.scheduled} />
                <Mini label="Sent" value={data.reminders.sent} />
                <Mini label="Failed" value={data.reminders.failed} />
                <Mini label="Recipients" value={data.reminders.recipients} />
              </div>
            </DashboardCard>
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
