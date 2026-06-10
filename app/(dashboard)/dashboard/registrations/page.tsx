'use client'

import { useState, useEffect, useMemo } from 'react'
import { useSearchParams, useRouter }   from 'next/navigation'
import { onAuthStateChanged }           from 'firebase/auth'
import { auth }                         from '@/lib/firebase/auth'
import Link                             from 'next/link'
import {
  Search, X, Users, CheckCircle2, XCircle,
  Clock, Loader2, AlertCircle, Ticket,
} from 'lucide-react'
import { cn }                           from '@/lib/utils/cn'
import type { AllRegistrationsResponse } from '@/app/api/organizer/registrations/route'
import type { SerializedRegistration }   from '@/app/api/organizer/events/[eventId]/registrations/route'

// ─── Types ────────────────────────────────────────────────────────────────────

type StatusFilter = 'all' | 'confirmed' | 'cancelled' | 'pending'

const TABS: { key: StatusFilter; label: string; icon: React.ElementType }[] = [
  { key: 'all',       label: 'All',       icon: Users       },
  { key: 'confirmed', label: 'Confirmed', icon: CheckCircle2 },
  { key: 'cancelled', label: 'Cancelled', icon: XCircle     },
  { key: 'pending',   label: 'Pending',   icon: Clock       },
]

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
  })
}

function StatusBadge({ status }: { status: string }) {
  const cls: Record<string, string> = {
    confirmed:  'bg-emerald-100 text-emerald-700',
    cancelled:  'bg-red-100 text-red-600',
    pending:    'bg-amber-100 text-amber-700',
    waitlisted: 'bg-sky-100 text-sky-700',
  }
  return (
    <span className={cn(
      'inline-flex rounded-full px-2.5 py-0.5 text-[11px] font-semibold capitalize',
      cls[status] ?? 'bg-muted text-muted-foreground',
    )}>
      {status}
    </span>
  )
}

function StatCard({
  label, value, icon: Icon, color,
}: {
  label: string; value: number; icon: React.ElementType; color: string
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border bg-card p-4">
      <div className={cn('flex size-9 shrink-0 items-center justify-center rounded-lg', color)}>
        <Icon className="size-4 text-foreground/70" aria-hidden />
      </div>
      <div>
        <p className="text-[20px] font-bold leading-none text-foreground">{value}</p>
        <p className="mt-0.5 text-[12px] text-muted-foreground">{label}</p>
      </div>
    </div>
  )
}

// ─── Row ──────────────────────────────────────────────────────────────────────

function RegistrationRow({ reg }: { reg: SerializedRegistration }) {
  return (
    <tr className="hover:bg-muted/20">
      <td className="px-4 py-3">
        <p className="text-[14px] font-medium text-foreground">{reg.attendee.name}</p>
        <p className="text-[12px] text-muted-foreground">{reg.attendee.email}</p>
      </td>
      <td className="hidden px-4 py-3 sm:table-cell">
        <p className="text-[14px] text-foreground">{reg.eventName}</p>
        <p className="text-[12px] text-muted-foreground">{reg.passName}</p>
      </td>
      <td className="px-4 py-3">
        <StatusBadge status={reg.status} />
      </td>
      <td className="hidden px-4 py-3 text-[12px] text-muted-foreground md:table-cell">
        {fmtDate(reg.registeredAt)}
      </td>
      <td className="px-4 py-3 text-right">
        <Link
          href={`/tickets/${reg.id}`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 rounded-lg border border-border bg-card px-2.5 py-1 text-[11.5px] font-medium text-foreground transition-colors hover:bg-muted/60"
        >
          <Ticket className="size-3" />
          Ticket
        </Link>
      </td>
    </tr>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function RegistrationsHubPage() {
  const router       = useRouter()
  const searchParams = useSearchParams()
  const statusParam  = searchParams.get('status') as StatusFilter | null
  const activeTab    = (statusParam && TABS.some(t => t.key === statusParam))
    ? statusParam : 'all'

  const [data,    setData]    = useState<AllRegistrationsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)
  const [search,  setSearch]  = useState('')

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async user => {
      if (!user) { setLoading(false); return }
      try {
        const token = await user.getIdToken()
        const res   = await fetch('/api/organizer/registrations', {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (!res.ok) throw new Error('Failed to load registrations')
        setData(await res.json() as AllRegistrationsResponse)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Error')
      } finally {
        setLoading(false)
      }
    })
    return unsub
  }, [])

  const filtered = useMemo((): SerializedRegistration[] => {
    let regs = data?.registrations ?? []
    if (activeTab !== 'all') regs = regs.filter(r => r.status === activeTab)
    const q = search.trim().toLowerCase()
    if (q) {
      regs = regs.filter(r =>
        r.attendee.name.toLowerCase().includes(q)  ||
        r.attendee.email.toLowerCase().includes(q) ||
        r.eventName.toLowerCase().includes(q)      ||
        r.ticketCode.toLowerCase().includes(q),
      )
    }
    return regs
  }, [data, activeTab, search])

  function goTab(key: StatusFilter) {
    const url = key === 'all'
      ? '/dashboard/registrations'
      : `/dashboard/registrations?status=${key}`
    router.push(url)
    setSearch('')
  }

  const stats = data?.stats

  return (
    <div className="space-y-5">

      {/* ── Header ── */}
      <div>
        <h1 className="text-[22px] font-bold text-foreground">Registrations</h1>
        <p className="mt-0.5 text-[13px] text-muted-foreground">
          All registrations across your events.
        </p>
      </div>

      {/* ── Stat cards ── */}
      {stats && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard label="Total"     value={stats.total}     icon={Users}        color="bg-primary/[0.08]" />
          <StatCard label="Confirmed" value={stats.confirmed} icon={CheckCircle2} color="bg-emerald-100"   />
          <StatCard label="Pending"   value={stats.pending}   icon={Clock}        color="bg-amber-100"     />
          <StatCard label="Cancelled" value={stats.cancelled} icon={XCircle}      color="bg-red-100"       />
        </div>
      )}

      {/* ── Tabs ── */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <nav className="-mb-px flex overflow-x-auto border-b border-border" role="tablist">
          {TABS.map(t => (
            <button
              key={t.key}
              role="tab"
              aria-selected={activeTab === t.key}
              onClick={() => goTab(t.key)}
              className={cn(
                'flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-4 py-2.5 text-[13px] font-medium transition-colors',
                activeTab === t.key
                  ? 'border-primary text-primary'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              <t.icon className="size-3.5" aria-hidden />
              {t.label}
              {stats && (
                <span className="ml-0.5 rounded-full bg-muted px-1.5 py-0 text-[10px] text-muted-foreground">
                  {t.key === 'all'
                    ? stats.total
                    : (stats as Record<string, number>)[t.key] ?? 0}
                </span>
              )}
            </button>
          ))}
        </nav>

        {/* Search */}
        <div className="relative shrink-0">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search name, email, event…"
            className="h-9 w-full rounded-lg border border-border bg-card pl-8 pr-8 text-[13px] text-foreground placeholder:text-muted-foreground focus:border-primary/40 focus:outline-none focus:ring-2 focus:ring-primary/25 sm:w-56"
          />
          {search && (
            <button
              onClick={() => setSearch('')}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              aria-label="Clear search"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* ── Loading ── */}
      {loading && (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      )}

      {/* ── Error ── */}
      {!loading && error && (
        <div className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-700">
          <AlertCircle className="size-4 shrink-0" /> {error}
        </div>
      )}

      {/* ── Table ── */}
      {!loading && !error && (
        filtered.length > 0 ? (
          <div className="overflow-hidden rounded-xl border border-border">
            <table className="w-full text-[12.5px]">
              <thead>
                <tr className="border-b border-border bg-muted/40">
                  <th className="px-4 py-2.5 text-left font-semibold text-muted-foreground">Attendee</th>
                  <th className="hidden px-4 py-2.5 text-left font-semibold text-muted-foreground sm:table-cell">Event / Pass</th>
                  <th className="px-4 py-2.5 text-left font-semibold text-muted-foreground">Status</th>
                  <th className="hidden px-4 py-2.5 text-left font-semibold text-muted-foreground md:table-cell">Registered</th>
                  <th className="px-4 py-2.5 text-right font-semibold text-muted-foreground">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filtered.map(reg => (
                  <RegistrationRow key={reg.id ?? `${reg.attendee.email}-${reg.registeredAt}`} reg={reg} />
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-border py-20 text-center">
            <Users className="size-10 text-muted-foreground/30" aria-hidden />
            <p className="text-[15px] font-semibold text-foreground">
              {search ? 'No results found' : 'No registrations yet'}
            </p>
            <p className="max-w-xs text-[13px] text-muted-foreground">
              {search
                ? 'Try a different search term.'
                : 'Registrations will appear here once attendees sign up for your events.'}
            </p>
            {search && (
              <button
                onClick={() => setSearch('')}
                className="mt-1 rounded-xl border border-border bg-card px-4 py-2 text-[12.5px] font-medium text-foreground hover:bg-muted/60"
              >
                Clear search
              </button>
            )}
          </div>
        )
      )}
    </div>
  )
}
