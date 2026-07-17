'use client'

import { useState, useEffect }   from 'react'
import { onAuthStateChanged }    from 'firebase/auth'
import { auth }                  from '@/lib/firebase/auth'
import Link                      from 'next/link'
import {
  ScanLine, CalendarDays, Users, AlertCircle,
  Loader2, ArrowRight, CheckCircle2, Clock,
} from 'lucide-react'
import { cn }                    from '@/lib/utils/cn'
import type { EventsListResponse, EventListItem } from '@/app/api/organizer/events/route'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtDate(dateStr: string | null): string {
  if (!dateStr) return '—'
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric',
  })
}

function lifecycleLabel(s: string): { label: string; cls: string } {
  switch (s) {
    case 'published':           return { label: 'Live',         cls: 'bg-emerald-100 text-emerald-700' }
    case 'registration_closed': return { label: 'Reg. Closed',  cls: 'bg-amber-100 text-amber-700'    }
    case 'completed':           return { label: 'Completed',    cls: 'bg-sky-100 text-sky-700'         }
    // Recognition only (Phase L2) — explicit label so it isn't shown as a raw slug.
    case 'unpublished':         return { label: 'Unpublished',  cls: 'bg-slate-100 text-slate-600'    }
    default:                    return { label: s,              cls: 'bg-muted text-muted-foreground'  }
  }
}

// ─── Event check-in card ──────────────────────────────────────────────────────

function EventCheckinCard({ event }: { event: EventListItem }) {
  const { label, cls } = lifecycleLabel(event.lifecycleStatus)
  const capacity = event.totalCapacity ?? null
  const pct = capacity ? Math.round((event.totalRegistrations / capacity) * 100) : null

  return (
    <div className="flex flex-col gap-4 rounded-xl border border-border bg-card p-4 sm:flex-row sm:items-center">

      {/* Icon */}
      <div
        className="flex size-12 shrink-0 items-center justify-center rounded-xl"
        style={{ backgroundImage: 'var(--primary-gradient)' }}
        aria-hidden
      >
        <CalendarDays className="size-5 text-white" />
      </div>

      {/* Info */}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-[15px] font-semibold text-foreground">{event.name}</p>
          <span className={cn('rounded-full px-2 py-0.5 text-[12px] font-semibold', cls)}>
            {label}
          </span>
        </div>

        <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-muted-foreground">
          {event.startDate && (
            <span className="flex items-center gap-1">
              <Clock className="size-3" aria-hidden />
              {fmtDate(event.startDate)}
            </span>
          )}
          <span className="flex items-center gap-1">
            <Users className="size-3" aria-hidden />
            {event.totalRegistrations} registered
            {capacity ? ` / ${capacity} capacity` : ''}
          </span>
        </div>

        {pct !== null && (
          <div className="mt-2 flex items-center gap-2">
            <div
              className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted"
              role="progressbar"
              aria-valuenow={pct}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div
                className="h-full rounded-full"
                style={{ width: `${pct}%`, backgroundImage: 'var(--primary-gradient)' }}
              />
            </div>
            <span className="shrink-0 text-[12px] tabular-nums text-muted-foreground">{pct}%</span>
          </div>
        )}
      </div>

      {/* Action */}
      <Link
        href={`/dashboard/events/${event.draftId}/checkin`}
        className="flex shrink-0 items-center gap-1.5 rounded-xl bg-primary px-4 py-2.5 text-[14px] font-semibold text-white transition-opacity hover:opacity-90"
      >
        <ScanLine className="size-4" aria-hidden />
        Open Check-In
        <ArrowRight className="size-3.5" aria-hidden />
      </Link>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function CheckInHubPage() {
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

  // Only show check-in eligible events (published, reg_closed, or completed)
  const eligible = events.filter(e =>
    ['published', 'registration_closed', 'completed'].includes(e.lifecycleStatus),
  )

  return (
    <div className="space-y-6">

      {/* ── Header ── */}
      <div className="flex items-start gap-3">
        <div
          className="flex size-10 shrink-0 items-center justify-center rounded-xl"
          style={{ backgroundImage: 'var(--primary-gradient)' }}
          aria-hidden
        >
          <ScanLine className="size-5 text-white" />
        </div>
        <div>
          <h1 className="text-[32px] font-bold text-foreground">Check-In</h1>
          <p className="mt-0.5 text-[14px] text-muted-foreground">
            Select an event to launch the live check-in scanner.
          </p>
        </div>
      </div>

      {/* ── How it works ── */}
      <div className="grid gap-3 sm:grid-cols-3">
        {[
          { icon: CalendarDays, title: 'Select event',   desc: 'Choose a published event from the list below.' },
          { icon: ScanLine,     title: 'Open scanner',   desc: 'Click "Open Check-In" to launch the QR scanner.' },
          { icon: CheckCircle2, title: 'Scan & confirm', desc: 'Scan attendee QR codes to mark them as checked in.' },
        ].map(({ icon: Icon, title, desc }) => (
          <div key={title} className="flex items-start gap-3 rounded-xl border border-border bg-card p-4">
            <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/[0.09]">
              <Icon className="size-4 text-primary" aria-hidden />
            </div>
            <div>
              <p className="text-[13px] font-semibold text-foreground">{title}</p>
              <p className="mt-0.5 text-[12px] text-muted-foreground">{desc}</p>
            </div>
          </div>
        ))}
      </div>

      {/* ── Events list ── */}
      <div>
        <h2 className="mb-3 text-[14px] font-semibold text-foreground">
          {eligible.length > 0 ? 'Events Ready for Check-In' : 'Your Events'}
        </h2>

        {loading && (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        )}

        {!loading && error && (
          <div className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-700">
            <AlertCircle className="size-4 shrink-0" /> {error}
          </div>
        )}

        {!loading && !error && eligible.length === 0 && (
          <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-border py-20 text-center">
            <ScanLine className="size-10 text-muted-foreground/30" aria-hidden />
            <p className="text-[15px] font-semibold text-foreground">No events ready for check-in</p>
            <p className="max-w-xs text-[13px] text-muted-foreground">
              Publish an event first, then come back here to launch check-in.
            </p>
            <Link
              href="/dashboard/events"
              className="mt-1 rounded-xl bg-primary px-5 py-2.5 text-[13px] font-semibold text-white hover:opacity-90"
            >
              View Events
            </Link>
          </div>
        )}

        {!loading && !error && eligible.length > 0 && (
          <div className="space-y-3">
            {eligible.map(event => (
              <EventCheckinCard key={event.draftId} event={event} />
            ))}
          </div>
        )}

        {/* Draft events notice */}
        {!loading && events.length > eligible.length && (
          <p className="mt-3 text-[12px] text-muted-foreground">
            {events.length - eligible.length} draft{events.length - eligible.length !== 1 ? 's' : ''} hidden — publish to enable check-in.{' '}
            <Link href="/dashboard/events" className="text-primary hover:underline">View all events</Link>
          </p>
        )}
      </div>
    </div>
  )
}
