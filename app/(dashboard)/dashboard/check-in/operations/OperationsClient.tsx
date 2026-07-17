'use client'

// OE-4 Sprint 1 — Check-in Operations Center foundation. PURE ORCHESTRATION over
// EXISTING APIs — no new endpoints, collections, services, realtime, scanner, or
// attendance engine:
//   • events        → GET /api/organizer/events
//   • attendance     → GET /api/organizer/events/[eventId]/attendance   (stats/recent/pass)
//   • registrations  → GET /api/organizer/events/[eventId]/registrations?all=true
//                       (walk-in + active-operator derivation only)
// Reuses PageHeader / EmptyState / buttonVariants / useToast / cn.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { auth } from '@/lib/firebase/auth'
import { cn } from '@/lib/utils/cn'
import { useToast } from '@/components/ui/Toast'
import { PageHeader, buttonVariants, EmptyState } from '@/components/ui'
import {
  LayoutDashboard, Users, Activity, UserPlus, CalendarClock, FileBarChart,
  ScanLine, RefreshCw, Loader2, UserCheck, UserRound, Percent, Clock, TicketCheck,
  Search, type LucideIcon,
} from 'lucide-react'
import { Participant360Drawer } from './Participant360Drawer'
import { ActivityTimeline } from './ActivityTimeline'
import { BulkActionBar } from './BulkActionBar'
import { ReportsTab } from './ReportsTab'
import type { EventListItem } from '@/app/api/organizer/events/route'
import type { AttendanceDashboardResponse } from '@/app/api/organizer/events/[eventId]/attendance/route'
import type { RegistrationsApiResponse, SerializedRegistration } from '@/app/api/organizer/events/[eventId]/registrations/route'

type Tab = 'dashboard' | 'participants' | 'activity' | 'walkins' | 'sessions' | 'reports'

const TABS: { key: Tab; label: string; icon: React.ElementType }[] = [
  { key: 'dashboard',    label: 'Dashboard',    icon: LayoutDashboard },
  { key: 'participants', label: 'Participants', icon: Users },
  { key: 'activity',     label: 'Activity',     icon: Activity },
  { key: 'walkins',      label: 'Walk-ins',     icon: UserPlus },
  { key: 'sessions',     label: 'Sessions',     icon: CalendarClock },
  { key: 'reports',      label: 'Reports',      icon: FileBarChart },
]

const CHECKIN_LIFECYCLE = new Set(['published', 'registration_closed', 'completed'])
const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })

export function OperationsClient() {
  const { showToast } = useToast()
  const tokenRef = useRef('')

  const [loading, setLoading]   = useState(true)
  const [events, setEvents]     = useState<EventListItem[]>([])
  const [eventId, setEventId]   = useState('')

  const [dataLoading, setDataLoading] = useState(false)
  const [att, setAtt]   = useState<AttendanceDashboardResponse | null>(null)
  const [regs, setRegs] = useState<SerializedRegistration[] | null>(null)
  const [tab, setTab]   = useState<Tab>('dashboard')

  // Participant directory search + selected participant (Participant 360 drawer).
  const [pQuery, setPQuery] = useState('')
  const [pPass, setPPass]   = useState('')
  const [selected, setSelected] = useState<{ id: string; token: string } | null>(null)
  // Bulk selection — IDs only (never duplicates participant objects); persists across filters.
  const [picked, setPicked] = useState<Set<string>>(new Set())

  const authed = useCallback(async (): Promise<Record<string, string>> => {
    const t = await auth.currentUser?.getIdToken() ?? tokenRef.current
    if (t) tokenRef.current = t
    return { Authorization: `Bearer ${t}` }
  }, [])

  // ── Events (check-in eligible only) ─────────────────────────────────────────
  const loadEvents = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/organizer/events', { headers: await authed() })
      const data = await res.json().catch(() => ({})) as { events?: EventListItem[] }
      const eligible = (data.events ?? []).filter(e => e.slug && (CHECKIN_LIFECYCLE.has(e.lifecycleStatus) || e.status === 'published'))
      setEvents(eligible)
      setEventId(prev => prev || (eligible[0]?.draftId ?? ''))
    } catch { showToast('Could not load events', 'error') }
    finally { setLoading(false) }
  }, [authed, showToast])

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void loadEvents() }, [loadEvents])

  // ── Selected event data — attendance (primary) + registrations (derived) ────
  const loadData = useCallback(async (id: string) => {
    if (!id) { setAtt(null); setRegs(null); return }
    setDataLoading(true)
    try {
      const headers = await authed()
      const [aRes, rRes] = await Promise.all([
        fetch(`/api/organizer/events/${id}/attendance`, { headers, cache: 'no-store' }),
        fetch(`/api/organizer/events/${id}/registrations?all=true`, { headers, cache: 'no-store' }),
      ])
      if (aRes.ok) setAtt(await aRes.json() as AttendanceDashboardResponse)
      else { setAtt(null); showToast('Could not load attendance', 'error') }
      // Registrations power ONLY the walk-in + active-operator cards. A limited
      // role without the registrations permission simply leaves those as “—”.
      setRegs(rRes.ok ? (await rRes.json() as RegistrationsApiResponse).registrations : null)
    } catch { showToast('Network error', 'error') }
    finally { setDataLoading(false) }
  }, [authed, showToast])

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void loadData(eventId) }, [eventId, loadData])

  // ── Derived metrics ─────────────────────────────────────────────────────────
  const metrics = useMemo(() => {
    const total     = att?.totalRegistrations ?? 0
    const confirmed = att?.confirmedRegistrations ?? 0
    const checkedIn = att?.checkedInCount ?? 0
    const walkIns = regs ? regs.filter(r => r.registrationSource === 'walkin').length : null
    const operators = regs
      ? new Set(regs.filter(r => r.checkedIn && r.checkedInBy).map(r => r.checkedInBy)).size
      : null
    return {
      total, checkedIn,
      remaining: Math.max(0, confirmed - checkedIn),
      attendancePct: att?.attendanceRate ?? 0,
      walkIns, operators,
    }
  }, [att, regs])

  const walkInRegs = useMemo(() => (regs ?? []).filter(r => r.registrationSource === 'walkin'), [regs])
  const selectedEvent = events.find(e => e.draftId === eventId)

  // Participant directory: rich client-side search over the already-loaded list —
  // name / registration id / ticket / email / phone / company / category / pass.
  const passNames = useMemo(() => [...new Set((regs ?? []).map(r => r.passName).filter(Boolean))], [regs])
  const participants = useMemo(() => {
    const q = pQuery.trim().toLowerCase()
    return (regs ?? []).filter(r => {
      if (pPass && r.passName !== pPass) return false
      if (!q) return true
      const hay = [r.attendee.name, r.id, r.ticketCode, r.attendee.email, r.attendee.phone, r.companyName, r.bibCategory, r.passType, r.passName]
        .filter(Boolean).join(' ').toLowerCase()
      return hay.includes(q)
    }).slice(0, 200)
  }, [regs, pQuery, pPass])

  const openParticipant = useCallback(async (id: string) => {
    const t = await auth.currentUser?.getIdToken() ?? tokenRef.current
    setSelected({ id, token: t })
  }, [])
  const selReg = selected ? (regs ?? []).find(r => r.id === selected.id) ?? null : null

  if (loading) return <div className="flex h-[60vh] items-center justify-center"><Loader2 className="size-6 animate-spin text-muted-foreground" /></div>

  return (
    <div className="space-y-5 p-4 sm:p-6">
      <PageHeader
        title="Check-in Operations Center"
        subtitle="Live attendance, participants, walk-ins and reports for on-site operations."
        breadcrumb={[{ label: 'Operations' }, { label: 'Check-in', href: '/dashboard/check-in' }, { label: 'Operations Center' }]}
        action={
          <div className="flex flex-wrap items-center gap-2">
            {events.length > 0 && (
              <select value={eventId} onChange={e => setEventId(e.target.value)}
                className="min-w-[200px] rounded-lg border border-border bg-background px-3 py-1.5 text-[13px]">
                {events.map(e => <option key={e.draftId} value={e.draftId}>{e.name}</option>)}
              </select>
            )}
            <button onClick={() => void loadData(eventId)} disabled={dataLoading || !eventId} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
              {dataLoading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />} Refresh
            </button>
            {selectedEvent && (
              <Link href={`/dashboard/events/${eventId}/checkin`} className={buttonVariants({ variant: 'primary', size: 'sm' })}>
                <ScanLine className="size-4" /> Open Scanner
              </Link>
            )}
          </div>
        }
      />

      {events.length === 0 ? (
        <div className="rounded-2xl border border-border bg-card py-6">
          <EmptyState icon={ScanLine} title="No events accepting check-ins"
            description="Publish an event to open its check-in operations. Only published, registration-closed or completed events appear here." />
        </div>
      ) : (
        <>
          {/* Tabs */}
          <div className="flex flex-wrap gap-1 border-b border-border">
            {TABS.map(({ key, label, icon: Icon }) => (
              <button key={key} onClick={() => setTab(key)}
                className={cn('-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-[13px] font-medium transition-colors',
                  tab === key ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground')}>
                <Icon className="size-4" /> {label}
              </button>
            ))}
          </div>

          {/* ── DASHBOARD ── */}
          {tab === 'dashboard' && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
                <Metric label="Total Registrations" value={metrics.total} icon={Users} />
                <Metric label="Checked In" value={metrics.checkedIn} icon={UserCheck} tone="text-emerald-600" />
                <Metric label="Remaining" value={metrics.remaining} icon={UserRound} />
                <Metric label="Attendance %" value={`${metrics.attendancePct}%`} icon={Percent} tone="text-sky-600" />
                <Metric label="Walk-ins" value={metrics.walkIns ?? '—'} icon={UserPlus} />
                <Metric label="Active Operators" value={metrics.operators ?? '—'} icon={ScanLine} />
              </div>

              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                {/* Recent check-ins (from attendance API) */}
                <div className="rounded-2xl border border-border bg-card p-4">
                  <p className="mb-3 flex items-center gap-1.5 text-[13px] font-bold text-foreground"><Clock className="size-4 text-muted-foreground" /> Recent check-ins</p>
                  {dataLoading && !att ? <Skeleton /> : !att || att.recentCheckIns.length === 0 ? (
                    <EmptyState icon={TicketCheck} title="No check-ins yet" description="Scans will appear here as attendees arrive." />
                  ) : (
                    <ul className="divide-y divide-border">
                      {att.recentCheckIns.map(c => (
                        <li key={c.registrationId} className="flex items-center justify-between py-2 text-[13px]">
                          <span className="min-w-0"><span className="font-medium text-foreground">{c.attendeeName || '—'}</span><span className="ml-2 text-[12px] text-muted-foreground">{c.passName}</span></span>
                          <span className="shrink-0 text-[12px] text-muted-foreground">{fmtTime(c.checkedInAt)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                {/* Per-pass capacity (from attendance API) */}
                <div className="rounded-2xl border border-border bg-card p-4">
                  <p className="mb-3 text-[13px] font-bold text-foreground">Attendance by pass</p>
                  {dataLoading && !att ? <Skeleton /> : !att || att.passStats.length === 0 ? (
                    <EmptyState icon={Percent} title="No passes" description="Per-pass attendance appears once registrations exist." />
                  ) : (
                    <ul className="space-y-2.5">
                      {att.passStats.map(pstat => (
                        <li key={pstat.passId}>
                          <div className="mb-1 flex items-center justify-between text-[12.5px]">
                            <span className="font-medium text-foreground">{pstat.passName}</span>
                            <span className="text-muted-foreground">{pstat.checkedIn}/{pstat.registered} · {pstat.attendancePct}%</span>
                          </div>
                          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary" style={{ width: `${Math.min(100, pstat.attendancePct)}%` }} /></div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
              {att && <p className="text-[11px] text-muted-foreground">Updated {new Date(att.lastUpdated).toLocaleTimeString('en-IN')}. Live counts update on the scanner screen; refresh here to recompute.</p>}
            </div>
          )}

          {/* ── WALK-INS (reuses already-fetched registrations) ── */}
          {tab === 'walkins' && (
            <div className="rounded-2xl border border-border bg-card p-4">
              {regs === null ? (
                <EmptyState icon={UserPlus} title="Walk-in list unavailable" description="Your role can view aggregate counts; the full walk-in list needs the Registrations permission." />
              ) : walkInRegs.length === 0 ? (
                <EmptyState icon={UserPlus} title="No walk-ins yet" description="On-site staff registrations will appear here. Add one from the scanner’s Walk-in tab." />
              ) : (
                <ul className="divide-y divide-border">
                  {walkInRegs.map(r => (
                    <li key={r.id} className="flex items-center justify-between py-2 text-[13px]">
                      <span className="min-w-0"><span className="font-medium text-foreground">{r.attendee.name}</span><span className="ml-2 text-[12px] text-muted-foreground">{r.passName} · {r.ticketCode}</span></span>
                      <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold', r.checkedIn ? 'bg-emerald-100 text-emerald-700' : 'bg-muted text-muted-foreground')}>{r.checkedIn ? 'Checked in' : r.status}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {/* ── PARTICIPANTS — searchable directory → Participant 360 drawer ── */}
          {tab === 'participants' && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-border bg-card p-3">
                <div className="relative min-w-[220px] flex-1">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
                  <input value={pQuery} onChange={e => setPQuery(e.target.value)} placeholder="Search name, registration, ticket, email, phone, company, category…"
                    className="w-full rounded-lg border border-border bg-background py-1.5 pl-8 pr-3 text-[13px]" />
                </div>
                <select value={pPass} onChange={e => setPPass(e.target.value)} className="rounded-lg border border-border bg-background px-2.5 py-1.5 text-[13px]">
                  <option value="">All passes</option>
                  {passNames.map(p => <option key={p} value={p}>{p}</option>)}
                </select>
              </div>
              {regs === null ? (
                <div className="rounded-2xl border border-border bg-card py-6"><EmptyState icon={Users} title="Participant directory unavailable" description="Your role can view aggregate counts; the participant directory needs the Registrations permission." /></div>
              ) : participants.length === 0 ? (
                <div className="rounded-2xl border border-border bg-card py-6"><EmptyState icon={Users} title="No participants match" description="Adjust the search or pass filter." /></div>
              ) : (
                <div className="overflow-x-auto rounded-2xl border border-border bg-card">
                  <table className="w-full min-w-[680px] text-left text-[13px]">
                    <thead className="bg-muted/40 text-[12px] uppercase tracking-wide text-muted-foreground">
                      <tr>
                        <th className="px-3 py-2.5">
                          <input type="checkbox" aria-label="Select all"
                            checked={participants.length > 0 && participants.every(r => picked.has(r.id))}
                            onChange={e => setPicked(prev => { const nx = new Set(prev); if (e.target.checked) participants.forEach(r => nx.add(r.id)); else participants.forEach(r => nx.delete(r.id)); return nx })} />
                        </th>
                        {['Name', 'Ticket', 'Pass', 'Status', 'Checked in'].map(h => <th key={h} className="px-4 py-2.5 font-semibold">{h}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {participants.map(r => (
                        <tr key={r.id} className={cn('border-t border-border hover:bg-muted/20', picked.has(r.id) && 'bg-primary/5')}>
                          <td className="px-3 py-2.5" onClick={e => e.stopPropagation()}>
                            <input type="checkbox" checked={picked.has(r.id)}
                              onChange={e => setPicked(prev => { const nx = new Set(prev); if (e.target.checked) nx.add(r.id); else nx.delete(r.id); return nx })} />
                          </td>
                          <td className="cursor-pointer px-4 py-2.5" onClick={() => void openParticipant(r.id)}><p className="font-medium text-foreground">{r.attendee.name || '—'}</p><p className="text-[11px] text-muted-foreground">{r.attendee.email}</p></td>
                          <td className="cursor-pointer px-4 py-2.5 font-mono text-[11.5px] text-muted-foreground" onClick={() => void openParticipant(r.id)}>{r.ticketCode || '—'}</td>
                          <td className="cursor-pointer px-4 py-2.5 text-muted-foreground" onClick={() => void openParticipant(r.id)}>{r.passName}</td>
                          <td className="cursor-pointer px-4 py-2.5 capitalize text-muted-foreground" onClick={() => void openParticipant(r.id)}>{r.status}</td>
                          <td className="cursor-pointer px-4 py-2.5" onClick={() => void openParticipant(r.id)}>{r.checkedIn ? <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">Yes</span> : <span className="text-muted-foreground">—</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="text-[11px] text-muted-foreground">{picked.size > 0 ? `${picked.size} selected across filters. ` : ''}Showing up to 200 matches. Click a participant to open the 360 view.</p>
              <BulkActionBar eventId={eventId} selectedIds={[...picked]} regs={regs ?? []} onClear={() => setPicked(new Set())} onRefresh={() => void loadData(eventId)} />
            </div>
          )}
          {tab === 'activity' && (
            <ActivityTimeline regs={regs} eventId={eventId} eventSlug={selectedEvent?.slug ?? ''} onOpenParticipant={id => void openParticipant(id)} />
          )}
          {tab === 'sessions' && (
            <Placeholder icon={CalendarClock} title="Session attendance" description="Per-session conference check-in and occupancy arrives in Sprint 2."
              cta={selectedEvent ? { href: `/dashboard/events/${eventId}?tab=conference`, label: 'Open sessions' } : undefined} />
          )}
          {tab === 'reports' && (
            <ReportsTab regs={regs} att={att} eventId={eventId} eventSlug={selectedEvent?.slug ?? ''} />
          )}
        </>
      )}

      {/* Participant 360 drawer (composition over existing APIs) */}
      {selected && selReg && (
        <Participant360Drawer
          reg={selReg} eventId={eventId} token={selected.token}
          onClose={() => setSelected(null)}
          onChanged={() => void loadData(eventId)}
        />
      )}
    </div>
  )
}

// ─── Small local UI helpers ─────────────────────────────────────────────────────
function Metric({ label, value, icon: Icon, tone }: { label: string; value: number | string; icon: React.ElementType; tone?: string }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-4">
      <div className="flex items-center gap-2 text-muted-foreground"><Icon className="size-4" /><span className="text-[12px] font-medium">{label}</span></div>
      <p className={cn('mt-1 text-2xl font-bold tabular-nums', tone ?? 'text-foreground')}>{typeof value === 'number' ? value.toLocaleString('en-IN') : value}</p>
    </div>
  )
}
function Skeleton() {
  return <div className="space-y-2">{[0, 1, 2].map(i => <div key={i} className="h-4 w-full animate-pulse rounded bg-muted" />)}</div>
}
function Placeholder({ icon, title, description, cta }: { icon: LucideIcon; title: string; description: string; cta?: { href: string; label: string } }) {
  return (
    <div className="rounded-2xl border border-dashed border-border bg-card py-8">
      <EmptyState icon={icon} title={title} description={description} />
      {cta && <div className="mt-3 text-center"><Link href={cta.href} className={buttonVariants({ variant: 'outline', size: 'sm' })}>{cta.label}</Link></div>}
    </div>
  )
}
