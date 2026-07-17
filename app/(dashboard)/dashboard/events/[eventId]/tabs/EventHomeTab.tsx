'use client'

// Phase H.4.2 — Event Operating Center (per-event command home).
//
// The default landing for a single event. It answers: what's happening, what's
// broken, what to do next, where to click — WITHOUT opening another page.
//
// Pure ORCHESTRATION: the two richest signals (event detail + registrations) are
// passed in as props (already fetched by ManageEventClient → zero new reads).
// A few existing per-event endpoints enrich the rest, each fetched once and
// gracefully degrading to "Unknown". No new collections, no writes, no business
// logic, no invented stats/percentages. Composed from reusable widgets.

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import {
  RotateCcw, Award, Globe, Users2, ScanLine, IdCard, Megaphone,
  FileBarChart, CalendarClock, Download, UserPlus, Banknote, Heart,
  Wallet as WalletIcon, CheckCircle2, ArrowRight,
} from 'lucide-react'
import { formatINR } from '@/components/event-templates/shared/utils/format'
import type { EventDetailResponse } from '@/app/api/organizer/events/[eventId]/route'
import type { RegistrationsApiResponse, SerializedRegistration } from '@/app/api/organizer/events/[eventId]/registrations/route'
import { AttentionPanel, type AttentionItem } from '@/components/dashboard/AttentionPanel'
import { ActivityTimeline, type ActivityItem } from '@/components/dashboard/ActivityTimeline'
import { MetricCard } from '@/components/dashboard/MetricCard'
import { DashboardCard } from '@/components/dashboard/DashboardCard'
import { Widget } from '@/components/dashboard/Widget'
import { SETUP_MODULES } from '@/lib/eventSetup/registry'
import type { SetupState } from '@/lib/eventSetup/types'

const rupees = (paise: number) => formatINR(Math.round(paise) / 100)

// ─── Enrichment (existing endpoints, fetched once, graceful) ────────────────

interface SessionStat { count: number; upcoming: number; full: number }
interface Enrichment {
  cert:       { generated: number; pending: number } | 'unknown'
  identifier: { configured: boolean } | 'unknown'
  sessions:   SessionStat | 'unknown'
  conflicts:  number | 'unknown'
}
const EMPTY: Enrichment = { cert: 'unknown', identifier: 'unknown', sessions: 'unknown', conflicts: 'unknown' }

// ─── Action button ──────────────────────────────────────────────────────────

interface QuickAct { label: string; icon: typeof ScanLine; tab?: string; href?: string; download?: boolean }

function ActionButton({ act, onOpenTab }: { act: QuickAct; onOpenTab: (t: string) => void }) {
  const cls = 'flex items-center gap-2 rounded-xl border border-border bg-card px-3 py-2.5 text-[13px] font-medium text-foreground transition-colors hover:bg-muted'
  const Icon = act.icon
  const body = <><Icon className="size-4 text-primary" aria-hidden /> {act.label}</>
  if (act.href) return <Link href={act.href} {...(act.download ? { target: '_blank' } : {})} className={cls}>{body}</Link>
  return <button type="button" onClick={() => act.tab && onOpenTab(act.tab)} className={cls}>{body}</button>
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function EventHomeTab({
  event, regData, token, onOpenTab,
}: {
  event: EventDetailResponse
  regData: RegistrationsApiResponse | null
  token: string
  onOpenTab: (tab: string) => void
}) {
  const [enrich, setEnrich] = useState<Enrichment>(EMPTY)
  const [loading, setLoading] = useState(true)
  const eventId = event.draftId

  useEffect(() => {
    if (!token) return
    let cancelled = false
    const run = async () => {
      const headers = { Authorization: `Bearer ${token}` }
      const safe = async <T,>(url: string, map: (j: unknown) => T): Promise<T | 'unknown'> => {
        try { const r = await fetch(url, { headers, cache: 'no-store' }); return r.ok ? map(await r.json()) : 'unknown' }
        catch { return 'unknown' }
      }
      setLoading(true)
      const [cert, identifier, sessions] = await Promise.all([
        safe(`/api/organizer/events/${eventId}/certificates/stats`, (j) => {
          const d = j as { generated?: number; pending?: number }; return { generated: d.generated ?? 0, pending: d.pending ?? 0 }
        }),
        safe(`/api/organizer/events/${eventId}/identifiers`, (j) => ({ configured: (j as { configured?: boolean }).configured === true })),
        safe(`/api/organizer/events/${eventId}/sessions`, (j) => {
          const arr = Array.isArray((j as { sessions?: unknown[] }).sessions) ? (j as { sessions: Record<string, unknown>[] }).sessions : []
          const now = Date.now()
          const num = (v: unknown) => (typeof v === 'number' ? v : null)
          return {
            count: arr.length,
            upcoming: arr.filter(s => { const t = num(s.startTime); return t !== null && t > now && s.status !== 'cancelled' }).length,
            full: arr.filter(s => { const c = num(s.capacity); const r = num(s.registeredCount); return c !== null && r !== null && r >= c }).length,
          }
        }),
      ])
      // Identifier conflicts only matter (and the analyzer only runs) when the
      // engine is configured for this event — keeps the home load light.
      let conflicts: number | 'unknown' = 'unknown'
      if (identifier !== 'unknown' && identifier.configured) {
        conflicts = await safe(`/api/organizer/events/${eventId}/identifiers/migration`, (j) => {
          const s = (j as { summary?: { totalDuplicates?: number; totalConflicts?: number } }).summary
          return (s?.totalDuplicates ?? 0) + (s?.totalConflicts ?? 0)
        })
      }
      if (!cancelled) { setEnrich({ cert, identifier, sessions, conflicts }); setLoading(false) }
    }
    void run()
    return () => { cancelled = true }
  }, [token, eventId])

  const regs = useMemo<SerializedRegistration[]>(() => regData?.registrations ?? [], [regData])

  // ── Attention Center (real signals only) ──
  const attention = useMemo<AttentionItem[]>(() => {
    const items: AttentionItem[] = []
    const refundPending = regs.filter(r => r.paymentStatus === 'refund_pending').length
    if (refundPending > 0) items.push({ id: 'refund', severity: 'critical', title: `${refundPending} refund${refundPending > 1 ? 's' : ''} pending`, meta: 'Resolve in Participants', icon: RotateCcw, onClick: () => onOpenTab('registrations') })
    const pending = regData?.stats.pending ?? 0
    if (pending > 0) items.push({ id: 'approvals', severity: 'warning', title: `${pending} registration${pending > 1 ? 's' : ''} pending approval`, icon: Users2, onClick: () => onOpenTab('registrations') })
    if (enrich.conflicts !== 'unknown' && enrich.conflicts > 0) items.push({ id: 'conflicts', severity: 'critical', title: `${enrich.conflicts} identifier conflict${enrich.conflicts > 1 ? 's' : ''}`, meta: 'Review identifiers', icon: IdCard, onClick: () => onOpenTab('sports') })
    if (enrich.cert !== 'unknown' && enrich.cert.generated === 0 && enrich.cert.pending > 0) items.push({ id: 'certs', severity: 'warning', title: 'Certificates not configured', meta: `${enrich.cert.pending} eligible`, icon: Award, onClick: () => onOpenTab('certificates') })
    if (event.lifecycleStatus === 'draft') items.push({ id: 'website', severity: 'warning', title: 'Event is not published', meta: 'Public page is not live', icon: Globe, onClick: () => onOpenTab('settings') })
    if (enrich.sessions !== 'unknown' && enrich.sessions.full > 0) items.push({ id: 'sessfull', severity: 'warning', title: `${enrich.sessions.full} session${enrich.sessions.full > 1 ? 's' : ''} full`, icon: CalendarClock, onClick: () => onOpenTab('conference') })
    return items
  }, [regs, regData, enrich, event.lifecycleStatus, onOpenTab])

  // ── Timeline / Today's activity (registrations + check-ins; real) ──
  const activity = useMemo<ActivityItem[]>(() => {
    const items: ActivityItem[] = []
    for (const r of regs) {
      if (r.registeredAt) items.push({ id: `reg-${r.id}`, kind: 'registration', title: `${r.attendee?.name ?? 'Someone'} registered`, description: r.passName ?? undefined, timestamp: r.registeredAt })
      if (r.checkedIn && r.checkedInAt) items.push({ id: `chk-${r.id}`, kind: 'checkin', title: `${r.attendee?.name ?? 'Someone'} checked in`, timestamp: r.checkedInAt })
    }
    return items
  }, [regs])

  // ── Recent participants ──
  const recent = useMemo(() => {
    return [...regs]
      .sort((a, b) => (b.registeredAt ?? '').localeCompare(a.registeredAt ?? ''))
      .slice(0, 6)
  }, [regs])

  // ── Event Health (reuse Setup registry — derived counts, not a fake %) ──
  const setupCounts = useMemo(() => {
    const ctx = { event, enrich: { cert: enrich.cert, identifier: enrich.identifier, sessions: enrich.sessions === 'unknown' ? 'unknown' as const : { count: enrich.sessions.count } } }
    const c: Record<SetupState, number> = { ready: 0, needs_attention: 0, disabled: 0, unknown: 0, not_yet_available: 0 }
    for (const m of SETUP_MODULES) c[m.derive(ctx).state]++
    return c
  }, [event, enrich])

  // ── Quick actions (event-scoped; existing pages only) ──
  const actions = useMemo<QuickAct[]>(() => {
    const a: QuickAct[] = [
      { label: 'Register walk-in', icon: UserPlus, href: `/dashboard/events/${eventId}/checkin` },
      { label: 'Check-in',         icon: ScanLine, href: `/dashboard/events/${eventId}/checkin` },
    ]
    if (event.eventType === 'sports') a.push({ label: 'Assign identifier', icon: IdCard, tab: 'sports' })
    a.push(
      { label: 'Send broadcast',     icon: Megaphone,    tab: 'communications' },
      { label: 'Print certificates', icon: Award,        tab: 'certificates' },
      { label: 'Export participants', icon: Download,     href: `/api/organizer/events/${eventId}/registrations/export?token=${encodeURIComponent(token)}`, download: true },
      { label: 'Manage sessions',    icon: CalendarClock, tab: 'conference' },
      { label: 'View reports',       icon: FileBarChart, tab: 'reports' },
    )
    return a
  }, [eventId, event.eventType, token])

  const sessionState = enrich.sessions === 'unknown' ? (loading ? 'loading' : 'unknown')
    : enrich.sessions.count === 0 ? 'empty' : 'ready'

  return (
    <div className="space-y-4">
      {/* Attention */}
      <DashboardCard title="Needs attention">
        <AttentionPanel items={attention} />
      </DashboardCard>

      {/* Quick actions */}
      <DashboardCard title="Quick actions">
        <div className="grid grid-cols-2 gap-2 p-4 sm:grid-cols-3 lg:grid-cols-4">
          {actions.map(a => <ActionButton key={a.label} act={a} onOpenTab={onOpenTab} />)}
        </div>
      </DashboardCard>

      <div className="grid gap-4 lg:grid-cols-3">
        {/* Left column */}
        <div className="space-y-4 lg:col-span-2">
          <DashboardCard title="Today's activity" viewHref={`/dashboard/events/${eventId}/registrations`} viewLabel="View all">
            <ActivityTimeline items={activity} limit={12}
              emptyTitle="No activity yet" emptyDescription="Registrations and check-ins will appear here." />
          </DashboardCard>

          <Widget title="Recent participants"
            state={!regData ? (event.status === 'draft' ? 'empty' : 'loading') : recent.length === 0 ? 'empty' : 'ready'}
            emptyIcon={Users2} emptyTitle="No participants yet"
            emptyText={event.status === 'draft' ? 'Publish the event to start taking registrations.' : 'New registrations will appear here.'}>
            <ul className="divide-y divide-border">
              {recent.map(r => (
                <li key={r.id}>
                  <button type="button" onClick={() => onOpenTab('registrations')}
                    className="flex w-full items-center gap-3 px-5 py-3 text-left transition-colors hover:bg-muted/40">
                    <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[12px] font-bold text-primary">
                      {(r.attendee?.name ?? '?').charAt(0).toUpperCase()}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[14px] font-medium text-foreground">{r.attendee?.name ?? 'Unknown'}</p>
                      <p className="truncate text-[12px] text-muted-foreground">{r.attendee?.email ?? ''}</p>
                    </div>
                    {r.bibNumber && <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">{r.bibNumber}</span>}
                    <ArrowRight className="size-3.5 shrink-0 text-muted-foreground/50" aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          </Widget>
        </div>

        {/* Right column */}
        <div className="space-y-4">
          {/* Event health (reuse Setup Center) */}
          <DashboardCard title="Event health">
            <div className="space-y-3 p-4">
              <div className="flex flex-wrap gap-1.5 text-[12px]">
                {setupCounts.ready > 0 && <span className="rounded-full bg-emerald-50 px-2.5 py-1 font-semibold text-emerald-700 ring-1 ring-emerald-600/20">{setupCounts.ready} Ready</span>}
                {setupCounts.needs_attention > 0 && <span className="rounded-full bg-amber-50 px-2.5 py-1 font-semibold text-amber-700 ring-1 ring-amber-600/20">{setupCounts.needs_attention} Needs Attention</span>}
                {setupCounts.disabled > 0 && <span className="rounded-full bg-slate-100 px-2.5 py-1 font-semibold text-slate-600 ring-1 ring-slate-500/20">{setupCounts.disabled} Disabled</span>}
              </div>
              <button type="button" onClick={() => onOpenTab('setup')}
                className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-border bg-card px-3 py-2 text-[13px] font-medium text-foreground transition-colors hover:bg-muted">
                Open Setup Center <ArrowRight className="size-3.5" aria-hidden />
              </button>
            </div>
          </DashboardCard>

          {/* Financial snapshot (reuse finance numbers; no recalculation) */}
          <DashboardCard title="Financial snapshot" viewHref="/dashboard/finance">
            <div className="grid grid-cols-2 gap-2 p-3">
              <MetricCard label="Revenue" hint="this event" value={rupees(event.estimatedRevenue)} icon={Banknote} iconColor="text-emerald-700" iconBg="bg-emerald-50" />
              <MetricCard label="Donations" hint={event.linkedCampaignSlug ? 'this event' : 'not enabled'} value={rupees(event.donationTotalPaise)} icon={Heart} iconColor="text-rose-600" iconBg="bg-rose-50" />
              <div className="rounded-2xl border border-dashed border-border bg-muted/20 p-3">
                <div className="flex items-center gap-1.5 text-muted-foreground"><WalletIcon className="size-3.5" aria-hidden /><span className="text-[12px]">Wallet</span></div>
                <Link href="/dashboard/wallet" className="mt-1 block text-[12px] font-medium text-primary hover:underline">Workspace level →</Link>
              </div>
              <div className="rounded-2xl border border-dashed border-border bg-muted/20 p-3">
                <div className="flex items-center gap-1.5 text-muted-foreground"><Banknote className="size-3.5" aria-hidden /><span className="text-[12px]">Settlement</span></div>
                <Link href="/dashboard/finance" className="mt-1 block text-[12px] font-medium text-primary hover:underline">Workspace level →</Link>
              </div>
            </div>
          </DashboardCard>

          {/* Session snapshot */}
          <Widget title="Sessions" state={sessionState as 'loading' | 'unknown' | 'empty' | 'ready'}
            emptyIcon={CalendarClock} emptyTitle="No sessions configured" emptyText="Add sessions to build your agenda."
            unknownText="Session data is not available."
            action={<button type="button" onClick={() => onOpenTab('conference')} className="text-[13px] font-medium text-primary hover:underline">Manage</button>}>
            {enrich.sessions !== 'unknown' && (
              <div className="grid grid-cols-3 gap-px overflow-hidden rounded-b-2xl bg-border">
                {[
                  { label: 'Total', value: enrich.sessions.count },
                  { label: 'Upcoming', value: enrich.sessions.upcoming },
                  { label: 'Full', value: enrich.sessions.full },
                ].map(s => (
                  <div key={s.label} className="bg-card px-4 py-3 text-center">
                    <p className="text-[18px] font-bold tabular-nums text-foreground">{s.value}</p>
                    <p className="text-[11px] text-muted-foreground">{s.label}</p>
                  </div>
                ))}
              </div>
            )}
          </Widget>

          {/* Communications — no per-event signal available → honest Unknown */}
          <Widget title="Communications" state="unknown"
            unknownText="Per-event email & broadcast status is not available from this view."
            action={<button type="button" onClick={() => onOpenTab('communications')} className="text-[13px] font-medium text-primary hover:underline">Open</button>} />
        </div>
      </div>

      {/* Footer note — all-clear affordance */}
      {attention.length === 0 && !loading && (
        <div className="flex items-center justify-center gap-2 py-2 text-[12px] text-muted-foreground">
          <CheckCircle2 className="size-3.5 text-emerald-500" aria-hidden /> Everything looks healthy for this event.
        </div>
      )}
    </div>
  )
}
