'use client'

// OE-4 Sprint 5 — Operations Reports & Analytics. ORCHESTRATION only. Every number
// comes from an EXISTING source; nothing is re-aggregated server-side and no new
// report/export engine is built:
//   overview + hourly + pass stats → the attendance API (`att`, already loaded)
//   operator / category / daily    → client grouping over `regs` (already loaded)
//   communications KPIs            → GET /api/organizer/communications (existing)
//   print / certificate stats      → GET /print-ops/*-jobs + /certificates/records
//   charts                         → components/analytics/Charts (Bars/HBars/Donut)
//   CSV export                     → GET /events/[id]/registrations/export (existing)
//   full export / print jobs       → deep-links to Reports Center / Print Operations

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { auth } from '@/lib/firebase/auth'
import { buttonVariants, EmptyState } from '@/components/ui'
import { Bars, Donut, HBars, type ChartPoint } from '@/components/analytics/Charts'
import {
  Users, UserCheck, UserRound, Percent, UserPlus, Boxes, Clock, ScanLine, Mail,
  IdCard, Award, Package, Download, FileBarChart, Printer, TrendingUp,
} from 'lucide-react'
import type { SerializedRegistration } from '@/app/api/organizer/events/[eventId]/registrations/route'
import type { AttendanceDashboardResponse } from '@/app/api/organizer/events/[eventId]/attendance/route'
import type { CommKpis } from '@/app/api/organizer/communications/route'
import type { PrintGenerationJobView } from '@/lib/printAssets/generationJob'
import type { PrintPackageJobView } from '@/lib/printAssets/packageJob'

export function ReportsTab({ regs, att, eventId, eventSlug }: {
  regs: SerializedRegistration[] | null
  att:  AttendanceDashboardResponse | null
  eventId:   string
  eventSlug: string
}) {
  const [kpis, setKpis]       = useState<CommKpis | null>(null)
  const [genJobs, setGenJobs] = useState<PrintGenerationJobView[]>([])
  const [pkgJobs, setPkgJobs] = useState<PrintPackageJobView[]>([])
  const [certCount, setCertCount] = useState<number | null>(null)
  const [token, setToken]     = useState('')

  const loadExtra = useCallback(async () => {
    const t = await auth.currentUser?.getIdToken() ?? ''
    setToken(t)
    const headers = { Authorization: `Bearer ${t}` }
    const j = async (url: string) => { try { const r = await fetch(url, { headers, cache: 'no-store' }); return r.ok ? await r.json() : {} } catch { return {} } }
    const [c, gen, pkg, cert] = await Promise.all([
      eventSlug ? j(`/api/organizer/communications?event=${encodeURIComponent(eventSlug)}&limit=500`) : Promise.resolve({}),
      j('/api/organizer/print-ops/generation-jobs'),
      j('/api/organizer/print-ops/package-jobs'),
      j(`/api/organizer/events/${eventId}/certificates/records`),
    ])
    setKpis(((c as { kpis?: CommKpis }).kpis) ?? null)
    setGenJobs((((gen as { jobs?: PrintGenerationJobView[] }).jobs) ?? []).filter(x => x.eventId === eventId))
    setPkgJobs(((pkg as { jobs?: PrintPackageJobView[] }).jobs) ?? [])
    setCertCount(((cert as { certificates?: unknown[] }).certificates ?? []).length)
  }, [eventId, eventSlug])

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void loadExtra() }, [loadExtra])

  // ── Overview (from the attendance API — no duplicate calculation) ────────────
  const walkIns = useMemo(() => (regs ?? []).filter(r => r.registrationSource === 'walkin').length, [regs])
  const capacity = useMemo(() => {
    const ps = att?.passStats ?? []
    if (ps.length === 0 || ps.some(p => p.capacity === null)) return null
    return ps.reduce((s, p) => s + (p.capacity ?? 0), 0)
  }, [att])

  // ── Hourly + peak (attendance API) ───────────────────────────────────────────
  const hourly: ChartPoint[] = (att?.hourlyBuckets ?? []).map(b => ({ label: b.label, value: b.count }))
  const peak = useMemo(() => (att?.hourlyBuckets ?? []).reduce<{ label: string; count: number } | null>((m, b) => (!m || b.count > m.count ? { label: b.label, count: b.count } : m), null), [att])

  // ── Pass distribution (attendance API) + category (regs) ─────────────────────
  const passDist: ChartPoint[] = (att?.passStats ?? []).map(p => ({ label: p.passName, value: p.checkedIn, hint: `${p.checkedIn}/${p.registered}` }))
  const categoryDist: ChartPoint[] = useMemo(() => {
    const map = new Map<string, number>()
    for (const r of regs ?? []) if (r.checkedIn) { const k = r.bibCategory || r.passType || r.passName || 'Uncategorized'; map.set(k, (map.get(k) ?? 0) + 1) }
    return [...map.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value).slice(0, 8)
  }, [regs])

  // ── Daily trend (client grouping over already-loaded regs) ───────────────────
  const daily: ChartPoint[] = useMemo(() => {
    const map = new Map<string, number>()
    for (const r of regs ?? []) if (r.checkedIn && typeof r.checkedInAt === 'string') {
      const d = r.checkedInAt.slice(0, 10); map.set(d, (map.get(d) ?? 0) + 1)
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([d, v]) => ({ label: d.slice(5), value: v }))
  }, [regs])

  // ── Operator performance (from checkedInBy — never estimated) ────────────────
  const operators = useMemo(() => {
    const map = new Map<string, { count: number; last: string }>()
    for (const r of regs ?? []) if (r.checkedIn && r.checkedInBy && typeof r.checkedInAt === 'string') {
      const cur = map.get(r.checkedInBy) ?? { count: 0, last: '' }
      map.set(r.checkedInBy, { count: cur.count + 1, last: r.checkedInAt > cur.last ? r.checkedInAt : cur.last })
    }
    return [...map.entries()].map(([op, v]) => ({ op, ...v })).sort((a, b) => b.count - a.count)
  }, [regs])

  // ── Print summary (existing job lists + cert records) ────────────────────────
  const badgesGenerated = genJobs.reduce((s, j) => s + j.counts.succeeded, 0)
  const packagesReady   = pkgJobs.filter(p => p.ready).length

  const exportHref = token ? `/api/organizer/events/${eventId}/registrations/export?token=${encodeURIComponent(token)}` : '#'

  return (
    <div className="space-y-4">
      {/* Quick actions */}
      <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-border bg-card p-3">
        <span className="mr-auto text-[13px] font-bold text-foreground">Operations reports</span>
        <a href={exportHref} className={buttonVariants({ variant: 'primary', size: 'sm' })}><Download className="size-4" /> Download check-in report (CSV)</a>
        <Link href="/dashboard/reports" className={buttonVariants({ variant: 'outline', size: 'sm' })}><FileBarChart className="size-4" /> Reports Center</Link>
        <Link href="/dashboard/print-assets/operations" className={buttonVariants({ variant: 'outline', size: 'sm' })}><Printer className="size-4" /> Print Operations</Link>
      </div>

      {/* Attendance overview */}
      <Section title="Attendance overview">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
          <Stat label="Total" value={att?.totalRegistrations ?? 0} icon={Users} />
          <Stat label="Checked in" value={att?.checkedInCount ?? 0} icon={UserCheck} tone="text-emerald-600" />
          <Stat label="Remaining" value={Math.max(0, (att?.confirmedRegistrations ?? 0) - (att?.checkedInCount ?? 0))} icon={UserRound} />
          <Stat label="Attendance %" value={`${att?.attendanceRate ?? 0}%`} icon={Percent} tone="text-sky-600" />
          <Stat label="Walk-ins" value={walkIns} icon={UserPlus} />
          <Stat label="Capacity" value={capacity ?? '—'} icon={Boxes} />
        </div>
      </Section>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Hourly trend */}
        <Section title="Hourly check-ins" right={peak && peak.count > 0 ? <span className="flex items-center gap-1 text-[12px] text-muted-foreground"><TrendingUp className="size-3.5" /> Peak {peak.label}</span> : undefined}>
          {hourly.length ? <Bars data={hourly} /> : <EmptyState icon={Clock} title="No check-ins yet" description="Hourly trend appears once attendees arrive." />}
        </Section>
        {/* Daily trend */}
        <Section title="Daily check-ins">
          {daily.length ? <Bars data={daily} /> : <EmptyState icon={Clock} title="No daily data" description="Multi-day trend appears across event days." />}
        </Section>
        {/* Pass distribution */}
        <Section title="Attendance by pass">
          {passDist.some(p => p.value > 0) ? <Donut segments={passDist} /> : <EmptyState icon={IdCard} title="No pass data" description="Per-pass attendance appears once registrations exist." />}
        </Section>
        {/* Category distribution */}
        <Section title="Category distribution">
          {categoryDist.length ? <HBars data={categoryDist} /> : <EmptyState icon={Boxes} title="No category data" description="Category breakdown appears as attendees check in." />}
        </Section>
      </div>

      {/* Operator performance */}
      <Section title="Operator performance">
        {operators.length === 0 ? <EmptyState icon={ScanLine} title="No operator activity" description="Check-ins attributed to operators appear here." /> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[420px] text-left text-[13px]">
              <thead className="text-[11px] uppercase tracking-wide text-muted-foreground"><tr><th className="py-2 pr-3 font-semibold">Operator</th><th className="py-2 pr-3 font-semibold">Check-ins</th><th className="py-2 font-semibold">Last check-in</th></tr></thead>
              <tbody className="divide-y divide-border">
                {operators.map(o => (
                  <tr key={o.op}><td className="py-2 pr-3 font-mono text-[11.5px] text-foreground">{o.op}</td><td className="py-2 pr-3 font-semibold text-foreground">{o.count}</td><td className="py-2 text-muted-foreground">{o.last ? new Date(o.last).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'}</td></tr>
                ))}
              </tbody>
            </table>
            <p className="mt-1.5 text-[11px] text-muted-foreground">Check-in counts from attributed scans. Undo/error/speed metrics are not recorded and are intentionally omitted.</p>
          </div>
        )}
      </Section>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Communications summary */}
        <Section title="Communications">
          {!kpis ? <EmptyState icon={Mail} title="No communications data" description="Delivery stats appear once messages are sent." /> : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <Stat label="Emails sent" value={kpis.emailsSent} icon={Mail} />
              <Stat label="WhatsApp sent" value={kpis.whatsappSent} icon={Mail} />
              <Stat label="Failed" value={kpis.failed} icon={Mail} tone={kpis.failed ? 'text-rose-600' : undefined} />
              <Stat label="Skipped" value={kpis.skipped} icon={Mail} />
              <Stat label="Delivery %" value={`${kpis.deliverySuccessRate}%`} icon={Percent} tone="text-emerald-600" />
            </div>
          )}
        </Section>
        {/* Print summary */}
        <Section title="Print & certificates">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Stat label="Badges generated" value={badgesGenerated} icon={IdCard} />
            <Stat label="Certificates" value={certCount ?? 0} icon={Award} />
            <Stat label="Packages" value={packagesReady} icon={Package} />
          </div>
        </Section>
      </div>
      <p className="text-[11px] text-muted-foreground">Composed from existing sources (attendance API, registrations, communications, print jobs, certificate records). No separate report engine or re-aggregation.</p>
    </div>
  )
}

// ─── Local helpers ──────────────────────────────────────────────────────────────
function Section({ title, right, children }: { title: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-4">
      <div className="mb-3 flex items-center justify-between"><p className="text-[13px] font-bold text-foreground">{title}</p>{right}</div>
      {children}
    </div>
  )
}
function Stat({ label, value, icon: Icon, tone }: { label: string; value: number | string; icon: React.ElementType; tone?: string }) {
  return (
    <div className="rounded-xl border border-border bg-background p-3">
      <div className="flex items-center gap-1.5 text-muted-foreground"><Icon className="size-3.5" /><span className="text-[11px] font-medium">{label}</span></div>
      <p className={`mt-1 text-xl font-bold tabular-nums ${tone ?? 'text-foreground'}`}>{typeof value === 'number' ? value.toLocaleString('en-IN') : value}</p>
    </div>
  )
}
