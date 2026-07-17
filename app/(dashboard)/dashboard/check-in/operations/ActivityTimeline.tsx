'use client'

// OE-4 Sprint 3 — Live Operations Timeline (Activity tab). ORCHESTRATION only.
// Aggregates EXISTING data (registrations already loaded by the parent + emailLogs
// via /communications + certificate records + print jobs) into one feed. No new
// collection, logging, realtime, or polling — manual refresh only. Clicking a
// participant opens the EXISTING Participant360Drawer (via the parent).

import { useCallback, useEffect, useMemo, useState } from 'react'
import { auth } from '@/lib/firebase/auth'
import { cn } from '@/lib/utils/cn'
import { EmptyState, buttonVariants } from '@/components/ui'
import Link from 'next/link'
import {
  Activity, UserCheck, UserPlus, Mail, TicketCheck, IdCard, Award, CreditCard,
  Package, RefreshCw, Search, Loader2, ScanLine, Users,
} from 'lucide-react'
import {
  buildActivity, bucketOf, relTime, type ActivityCategory, type ActivityItem, type CertItem,
} from './activity'
import type { SerializedRegistration } from '@/app/api/organizer/events/[eventId]/registrations/route'
import type { CommRow } from '@/app/api/organizer/communications/route'
import type { PrintGenerationJobView } from '@/lib/printAssets/generationJob'
import type { PrintPackageJobView } from '@/lib/printAssets/packageJob'

const FILTERS: { key: ActivityCategory | 'all'; label: string }[] = [
  { key: 'all', label: 'All' }, { key: 'checkin', label: 'Check-in' }, { key: 'registration', label: 'Registrations' },
  { key: 'walkin', label: 'Walk-ins' }, { key: 'communication', label: 'Communications' }, { key: 'ticket', label: 'Tickets' },
  { key: 'badge', label: 'Badges' }, { key: 'certificate', label: 'Certificates' }, { key: 'payment', label: 'Payments' }, { key: 'job', label: 'Jobs' },
]

const CAT: Record<ActivityCategory, { icon: React.ElementType; tint: string }> = {
  checkin:      { icon: UserCheck,   tint: 'bg-emerald-100 text-emerald-700' },
  registration: { icon: UserPlus,    tint: 'bg-sky-100 text-sky-700' },
  walkin:       { icon: UserPlus,    tint: 'bg-amber-100 text-amber-700' },
  communication:{ icon: Mail,        tint: 'bg-slate-100 text-slate-600' },
  ticket:       { icon: TicketCheck, tint: 'bg-violet-100 text-violet-700' },
  badge:        { icon: IdCard,      tint: 'bg-indigo-100 text-indigo-700' },
  certificate:  { icon: Award,       tint: 'bg-amber-100 text-amber-700' },
  payment:      { icon: CreditCard,  tint: 'bg-emerald-100 text-emerald-700' },
  job:          { icon: Package,     tint: 'bg-slate-100 text-slate-600' },
}

export function ActivityTimeline({ regs, eventId, eventSlug, onOpenParticipant }: {
  regs: SerializedRegistration[] | null
  eventId: string
  eventSlug: string
  onOpenParticipant: (id: string) => void
}) {
  const [comms, setComms]     = useState<CommRow[]>([])
  const [certs, setCerts]     = useState<CertItem[]>([])
  const [genJobs, setGenJobs] = useState<PrintGenerationJobView[]>([])
  const [pkgJobs, setPkgJobs] = useState<PrintPackageJobView[]>([])
  const [loading, setLoading] = useState(false)
  const [nowTs, setNowTs]     = useState(0)

  const [filter, setFilter] = useState<ActivityCategory | 'all'>('all')
  const [query, setQuery]   = useState('')

  const loadExtra = useCallback(async () => {
    setLoading(true)
    setNowTs(Date.now())
    try {
      const headers = { Authorization: `Bearer ${await auth.currentUser?.getIdToken() ?? ''}` }
      const j = async (url: string) => { try { const r = await fetch(url, { headers, cache: 'no-store' }); return r.ok ? await r.json() : {} } catch { return {} } }
      const [c, cert, gen, pkg] = await Promise.all([
        eventSlug ? j(`/api/organizer/communications?event=${encodeURIComponent(eventSlug)}&limit=500`) : Promise.resolve({}),
        j(`/api/organizer/events/${eventId}/certificates/records`),
        j('/api/organizer/print-ops/generation-jobs'),
        j('/api/organizer/print-ops/package-jobs'),
      ])
      setComms(((c as { rows?: CommRow[] }).rows) ?? [])
      setCerts(((cert as { certificates?: CertItem[] }).certificates) ?? [])
      setGenJobs((((gen as { jobs?: PrintGenerationJobView[] }).jobs) ?? []).filter(x => x.eventId === eventId))
      setPkgJobs(((pkg as { jobs?: PrintPackageJobView[] }).jobs) ?? [])
    } finally { setLoading(false) }
  }, [eventId, eventSlug])

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void loadExtra() }, [loadExtra])

  const items = useMemo(() => buildActivity({ regs: regs ?? [], comms, certs, genJobs, pkgJobs }), [regs, comms, certs, genJobs, pkgJobs])

  const q = query.trim().toLowerCase()
  const filtered = useMemo(() => items.filter(i => {
    if (filter !== 'all' && i.category !== filter) return false
    if (!q) return true
    const p = i.participant
    const hay = [i.title, p?.name, p?.regNumber, p?.regId, p?.email, p?.phone].filter(Boolean).join(' ').toLowerCase()
    return hay.includes(q)
  }).slice(0, 300), [items, filter, q])

  const groups = useMemo(() => {
    const g: Record<'Today' | 'Yesterday' | 'Earlier', ActivityItem[]> = { Today: [], Yesterday: [], Earlier: [] }
    for (const it of filtered) g[bucketOf(it.ts, nowTs || Date.parse(it.ts) + 1)].push(it)
    return g
  }, [filtered, nowTs])

  return (
    <div className="space-y-3">
      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-border bg-card p-3">
        <div className="flex flex-wrap gap-1">
          {FILTERS.map(f => (
            <button key={f.key} onClick={() => setFilter(f.key)}
              className={cn('rounded-full px-2.5 py-1 text-[12px] font-medium transition-colors', filter === f.key ? 'bg-primary text-white' : 'bg-muted text-muted-foreground hover:text-foreground')}>
              {f.label}
            </button>
          ))}
        </div>
        <div className="relative ml-auto min-w-[180px] flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search participant, ticket, email…"
            className="w-full rounded-lg border border-border bg-background py-1.5 pl-8 pr-3 text-[13px]" />
        </div>
        <button onClick={() => void loadExtra()} disabled={loading} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
          {loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />} Refresh
        </button>
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-2xl border border-border bg-card py-8">
          <EmptyState icon={Activity} title="No activity yet" description="On-site scans, walk-ins, communications and jobs will appear here as they happen." />
          <div className="mt-3 flex justify-center gap-2">
            <Link href={`/dashboard/events/${eventId}/checkin`} className={buttonVariants({ variant: 'primary', size: 'sm' })}><ScanLine className="size-4" /> Open Scanner</Link>
            <Link href={`/dashboard/events/${eventId}?tab=registrations`} className={buttonVariants({ variant: 'outline', size: 'sm' })}><Users className="size-4" /> View Registrations</Link>
          </div>
        </div>
      ) : (
        (['Today', 'Yesterday', 'Earlier'] as const).map(day => groups[day].length === 0 ? null : (
          <div key={day} className="space-y-1.5">
            <p className="px-1 text-[11px] font-bold uppercase tracking-wide text-muted-foreground">{day}</p>
            <div className="overflow-hidden rounded-2xl border border-border bg-card">
              {groups[day].map((it, i) => {
                const c = CAT[it.category]
                const clickable = !!it.participant?.regId
                return (
                  <div key={it.id + i} onClick={() => clickable && onOpenParticipant(it.participant!.regId)}
                    className={cn('flex items-start gap-3 border-b border-border px-4 py-2.5 last:border-0', clickable && 'cursor-pointer hover:bg-muted/20')}>
                    <div className={cn('mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full', c.tint)}><c.icon className="size-3.5" /></div>
                    <div className="min-w-0 flex-1">
                      <p className="text-[13px] font-medium text-foreground">{it.title}</p>
                      <p className="truncate text-[11.5px] text-muted-foreground">
                        {it.participant ? <span className="text-foreground/80">{it.participant.name}{it.participant.regNumber ? ` · ${it.participant.regNumber}` : ''}</span> : <span>{it.source}</span>}
                        {it.operator ? ` · by ${it.operator}` : ''}
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="text-[11px] text-muted-foreground" title={new Date(it.ts).toLocaleString('en-IN')}>{relTime(it.ts, nowTs || Date.now())}</p>
                      {it.status && <span className="mt-0.5 inline-flex rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-semibold capitalize text-muted-foreground">{it.status}</span>}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        ))
      )}
      <p className="text-[11px] text-muted-foreground">Aggregated from existing records (registrations, communications, certificates, print jobs). Manual refresh — no live polling.</p>
    </div>
  )
}
