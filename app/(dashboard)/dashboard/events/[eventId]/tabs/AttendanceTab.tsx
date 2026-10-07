'use client'

// RD-EVENT-11 · Attendance — the operational surface.
//
// ═══ WHAT THIS REPLACED ══════════════════════════════════════════════════════
// A read-only analytics dashboard: five KPI cards, a progress bar, an hourly chart,
// a recent list and a pass table. It could tell you the attendance rate. It could not
// help you find Priya Nair and let her in.
//
// The five cards were also the third copy of figures the RD-EVENT-08 shell strip
// already states directly above (registered / checked in / revenue / capacity), and
// they disagreed with it: the strip said "213 registered" while the card said
// "Total Registrations 240", because one counts confirmed and the other counts every
// row. Two definitions of one word, forty pixels apart.
//
// ═══ WHAT ATTENDANCE OWNS NOW ════════════════════════════════════════════════
// Finding a person and admitting them. Everything else on the page exists to serve
// that: one compact progress line, a search, a filtered roll call, and the check-in
// action. The scanner is NOT reimplemented here — it lives at
// /dashboard/events/{id}/checkin and this page links to it.
//
// ═══ READS ═══════════════════════════════════════════════════════════════════
//   /attendance                 — summary + 20 recent rows + hourly count() aggregates
//   /registrations?checkin=…    — browsing: server-filtered, cursor-paginated
//   /checkin/search?q=…         — searching: the gate's own name/email/phone lookup
// All bounded, none on a timer beyond the live refresh. The event itself comes from
// the shell as a prop — never refetched.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import {
  AlertTriangle, ArrowRight, Check, Clock, Loader2, RotateCw, ScanLine,
  Search, Undo2, UserCheck, X,
} from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { accent } from '@/lib/dashboard/accents'
import { useToast } from '@/components/ui'
import { useEventContext } from '@/components/dashboard/EventContextProvider'
import type { EventDetailResponse } from '@/app/api/organizer/events/[eventId]/route'
import type {
  AttendanceDashboardResponse, PassAttendanceStat,
} from '@/app/api/organizer/events/[eventId]/attendance/route'
import type { RegistrationsApiResponse } from '@/app/api/organizer/events/[eventId]/registrations/route'
import type { AttendeeSearchResponse } from '@/app/api/organizer/events/[eventId]/checkin/search/route'
import {
  UNAVAILABLE, attendanceGate, attendanceMetrics, attendancePercent, checkInClock,
  filterEmptyMessage, filterParam, hourBarPercent, hourlyView, identifierColumnLabel,
  isLiveAttendance, participantNoun, rowAction, rowFromRegistration, rowFromSearchResult,
  shouldSearch, sinceLabel,
  type AttendanceFilter, type AttendanceRow,
} from '@/lib/attendance/attendanceView'

/**
 * How often the live figures refresh.
 *
 * Thirty seconds was the old interval and it never stopped — a tab left open on a
 * gate laptop refreshed all night, and each refresh read up to a thousand documents.
 * The reads are bounded now, and the timer pauses when the tab is hidden, so the
 * cost is proportional to someone actually watching it.
 */
const REFRESH_MS = 30_000
const PAGE_SIZE  = 25

type FetchState = 'idle' | 'loading' | 'ok' | 'error' | 'forbidden'

// ─── Small pieces ─────────────────────────────────────────────────────────────

function Section({ id, title, action, children }: {
  id: string
  title: string
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    // `min-w-0`: a grid item defaults to `min-width: auto` and refuses to shrink,
    // which is how one unbreakable Tamil name widens an entire page.
    <section aria-labelledby={id} className="min-w-0">
      <div className="mb-2 flex items-end justify-between gap-3">
        <h2 id={id} className="text-fs-sm font-semibold text-foreground">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  )
}

function Skeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-live="polite">
      <div className="h-24 animate-pulse rounded-surface bg-muted" />
      <div className="h-14 animate-pulse rounded-surface bg-muted" />
      <div className="h-72 animate-pulse rounded-surface bg-muted" />
      <span className="sr-only">Loading attendance…</span>
    </div>
  )
}

/** A status word, never a colour alone. */
function StatusPill({ checkedIn, status }: { checkedIn: boolean; status: string }) {
  if (checkedIn) {
    return (
      <span className={cn('inline-flex shrink-0 items-center gap-1 rounded-pill px-2 py-0.5 text-fs-2xs font-semibold', accent('verify').tile)}>
        <Check className="size-3" aria-hidden /> Checked in
      </span>
    )
  }
  const tone = status === 'confirmed' ? 'neutral' : status === 'pending' ? 'pending' : 'critical'
  const label = status === 'confirmed' ? 'Not arrived'
    : status.charAt(0).toUpperCase() + status.slice(1)
  return (
    <span className={cn('inline-flex shrink-0 items-center rounded-pill px-2 py-0.5 text-fs-2xs font-semibold', accent(tone).tile)}>
      {label}
    </span>
  )
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function AttendanceTab({ eventId, token, event }: {
  eventId: string
  token:   string
  /** From the shell — never refetched here. */
  event:   EventDetailResponse
}) {
  const { now } = useEventContext()
  const { showToast } = useToast()

  const [data,  setData]  = useState<AttendanceDashboardResponse | null>(null)
  const [state, setState] = useState<FetchState>('loading')
  const [attempt, setAttempt] = useState(0)

  // The roll call is its own concern: its own state, its own errors, its own paging.
  const [filter, setFilter]   = useState<AttendanceFilter>('out')
  const [passId, setPassId]   = useState<string>('')
  const [query,  setQuery]    = useState('')
  const [debounced, setDebounced] = useState('')
  const [rows,   setRows]     = useState<AttendanceRow[]>([])
  const [rowsState, setRowsState] = useState<FetchState>('idle')
  const [cursor, setCursor]   = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [pageBusy, setPageBusy] = useState(false)
  const [listComplete, setListComplete] = useState(true)
  const [searchTruncated, setSearchTruncated] = useState(false)
  const [rowsAttempt, setRowsAttempt] = useState(0)

  // Which rows are mid-mutation, so a second click cannot fire a second write.
  const [busyRows, setBusyRows] = useState<Record<string, boolean>>({})

  const gate = useMemo(
    () => attendanceGate(data?.lifecycleStatus ?? event.lifecycleStatus, event.eventType),
    [data?.lifecycleStatus, event.lifecycleStatus, event.eventType],
  )
  const noun = useMemo(() => participantNoun(event.eventType), [event.eventType])
  const idLabel = useMemo(
    () => identifierColumnLabel(data?.identifierEnabled ?? false, data?.identifierLabel ?? null),
    [data?.identifierEnabled, data?.identifierLabel],
  )
  const timeZone = data?.timeZone ?? event.timezone ?? 'Asia/Kolkata'

  // ── Summary ───────────────────────────────────────────────────────────────
  const summaryKey = useRef('')
  useEffect(() => {
    if (!token) return
    const key = `${eventId}|${attempt}`
    if (summaryKey.current === key) return
    summaryKey.current = key

    setState(s => (s === 'ok' ? s : 'loading'))
    void (async () => {
      try {
        const res = await fetch(`/api/organizer/events/${encodeURIComponent(eventId)}/attendance`, {
          headers: { Authorization: `Bearer ${token}` }, cache: 'no-store',
        })
        if (summaryKey.current !== key) return
        if (res.status === 403) { setState('forbidden'); return }
        if (!res.ok) { setState('error'); return }
        const j = await res.json() as AttendanceDashboardResponse
        if (summaryKey.current !== key) return
        setData(j)
        setState('ok')
      } catch {
        if (summaryKey.current === key) setState('error')
      }
    })()
  }, [token, eventId, attempt])

  // Live refresh — paused while the tab is hidden, and never while the event is
  // over. A completed event's attendance is history; polling it changes nothing.
  const live = isLiveAttendance(data?.lifecycleStatus ?? event.lifecycleStatus)
  useEffect(() => {
    if (!token || !live) return
    const tick = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      setAttempt(a => a + 1)
    }
    const id = setInterval(tick, REFRESH_MS)
    return () => clearInterval(id)
  }, [token, live])

  // ── Search debounce ───────────────────────────────────────────────────────
  //
  // The cursor is reset by whatever CHANGED the query — the filter button, the pass
  // select, the debounce timer — rather than by an effect watching them. An effect
  // would fire a render purely to undo state another render had just set, and the
  // list would briefly page against a cursor from the previous filter.
  useEffect(() => {
    const id = setTimeout(() => { setDebounced(query.trim()); setCursor(null) }, 350)
    return () => clearTimeout(id)
  }, [query])

  const changeFilter = useCallback((f: AttendanceFilter) => { setFilter(f); setCursor(null) }, [])
  const changePass   = useCallback((p: string) => { setPassId(p); setCursor(null) }, [])

  // ── The roll call ─────────────────────────────────────────────────────────
  const rowsKey = useRef('')
  useEffect(() => {
    if (!token) return
    const key = `${eventId}|${filter}|${passId}|${debounced}|${cursor ?? ''}|${rowsAttempt}`
    if (rowsKey.current === key) return
    rowsKey.current = key

    const first = cursor === null

    void (async () => {
      // A first page replaces the list, so it shows the skeleton. A further page
      // appends, so it only busies its own button — the rows already on screen must
      // not vanish while someone is reading a name off them.
      if (first) setRowsState('loading'); else setPageBusy(true)
      try {
        const searching = shouldSearch(debounced)

        // ── SEARCHING ── the gate's own lookup: name, email, phone and ticket code,
        // matched SERVER-side. `/registrations?q=` cannot do this — it is an exact
        // ticket/email lookup, and a plain name either misses or returns everyone.
        if (searching) {
          const res = await fetch(
            `/api/organizer/events/${encodeURIComponent(eventId)}/checkin/search?q=${encodeURIComponent(debounced)}`,
            { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' },
          )
          if (rowsKey.current !== key) return
          if (res.status === 403) { setRowsState('forbidden'); setRows([]); return }
          if (!res.ok) { setRowsState('error'); return }
          const j = await res.json() as AttendeeSearchResponse
          if (rowsKey.current !== key) return

          setRows(j.results.map(rowFromSearchResult))
          setHasMore(false)
          setSearchTruncated(j.truncated)
          setListComplete(true)
          setRowsState('ok')
          return
        }

        // ── BROWSING ── filtered and cursor-paginated over the WHOLE matching set.
        const p = new URLSearchParams({ limit: String(PAGE_SIZE) })
        const cf = filterParam(filter)
        if (cf)     p.set('checkin', cf)
        if (passId) p.set('passId', passId)
        if (cursor) p.set('cursor', cursor)

        const res = await fetch(
          `/api/organizer/events/${encodeURIComponent(eventId)}/registrations?${p.toString()}`,
          { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' },
        )
        if (rowsKey.current !== key) return
        if (res.status === 403) { setRowsState('forbidden'); setRows([]); return }
        if (!res.ok) { setRowsState('error'); return }
        const j = await res.json() as RegistrationsApiResponse
        if (rowsKey.current !== key) return

        const mapped = j.registrations.map(rowFromRegistration)
        setRows(prev => (first ? mapped : [...prev, ...mapped]))
        setHasMore(j.hasMore)
        setSearchTruncated(false)
        setListComplete(j.checkinFilterComplete !== false)
        setRowsState('ok')
      } catch {
        if (rowsKey.current === key) setRowsState('error')
      } finally {
        if (rowsKey.current === key) setPageBusy(false)
      }
    })()
  }, [token, eventId, filter, passId, debounced, cursor, rowsAttempt])

  const reloadAll = useCallback(() => {
    setAttempt(a => a + 1)
    setCursor(null)
    setRowsAttempt(a => a + 1)
  }, [])

  // ── Check in / undo ───────────────────────────────────────────────────────
  //
  // Both reuse the EXISTING canonical routes. `/api/checkin/scan` is the one path
  // every entry point uses — it owns eligibility, the counter delta, the audit entry
  // and identifier assignment — so a check-in from this table is indistinguishable
  // from one made at the scanner. Nothing about admission is re-decided here.
  const mutate = useCallback(async (reg: AttendanceRow, action: 'in' | 'out') => {
    if (busyRows[reg.id]) return
    setBusyRows(b => ({ ...b, [reg.id]: true }))
    try {
      const res = action === 'in'
        ? await fetch('/api/checkin/scan', {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            // `eventSlug` is sent deliberately: ticket codes are globally unique, and
            // without it a code belonging to another of this organizer's events would
            // open this gate. The server re-checks it — this is not the guard, it is
            // the caller declaring which gate it is running.
            body: JSON.stringify({
              ticketCode: reg.ticketCode,
              eventSlug:  event.slug ?? undefined,
              source:     'attendance_tab',
            }),
          })
        : await fetch(`/api/organizer/registrations/${encodeURIComponent(reg.id)}/undo-checkin`, {
            method: 'POST', headers: { Authorization: `Bearer ${token}` },
          })

      const body = await res.json().catch(() => ({})) as {
        success?: boolean; error?: string; requiresIdentifier?: boolean; identifierLabel?: string
      }

      if (action === 'in' && body.requiresIdentifier) {
        // The event issues identifiers and this person has none. Assigning one is the
        // scanner's job — it owns the pool, the format and the uniqueness rules — so
        // this sends the operator there rather than growing a second assignment UI.
        showToast(`${body.identifierLabel ?? 'An identifier'} is required — use the check-in screen to assign one.`, 'info')
        return
      }
      if (!res.ok || body.success === false) {
        showToast(action === 'in' ? "Check-in couldn't be completed." : "Undo couldn't be completed.", 'error')
        return
      }

      // Optimistic on the row that changed; the counters refresh on the next tick.
      setRows(prev => prev.map(r => r.id === reg.id
        ? { ...r, checkedIn: action === 'in', checkedInAt: action === 'in' ? new Date().toISOString() : null }
        : r))
      showToast(action === 'in' ? `${reg.name || 'Attendee'} checked in.` : 'Check-in undone.', 'success')
      setAttempt(a => a + 1)
    } catch {
      showToast('That could not be completed. Check your connection and try again.', 'error')
    } finally {
      setBusyRows(b => { const next = { ...b }; delete next[reg.id]; return next })
    }
  }, [busyRows, token, event.slug, showToast])

  // ── Lifecycle gate ────────────────────────────────────────────────────────
  if (!gate.accepts && state !== 'loading') {
    return (
      <div className="space-y-6">
        <section aria-labelledby="att-gate" className="min-w-0">
          <div className="rounded-surface border border-border bg-card px-4 py-8 text-center">
            <span className="mx-auto flex size-10 items-center justify-center rounded-pill bg-muted" aria-hidden>
              <UserCheck className="size-5 text-muted-foreground" />
            </span>
            <h2 id="att-gate" className="mt-3 text-fs-md font-semibold text-foreground">{gate.title}</h2>
            <p className="mx-auto mt-1.5 max-w-md text-fs-sm text-muted-foreground">{gate.body}</p>
            <Link
              href={`/dashboard/events/${encodeURIComponent(eventId)}?tab=setup`}
              className="mt-4 inline-flex h-11 items-center gap-1.5 rounded-control border border-border px-3.5 text-fs-sm font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            >
              Open setup <ArrowRight className="size-3.5" aria-hidden />
            </Link>
          </div>
        </section>
        {/* An event that has finished still shows what happened; a draft has nothing. */}
        {data && data.checkedInCount > 0 && <RecentPanel data={data} timeZone={timeZone} now={now} />}
      </div>
    )
  }

  if (state === 'loading' && !data) return <Skeleton />

  if (state === 'error' && !data) {
    return (
      <div role="alert" className="flex flex-col items-center gap-4 rounded-surface border border-border bg-card px-4 py-14 text-center">
        <span className="flex size-10 items-center justify-center rounded-pill bg-destructive/10" aria-hidden>
          <AlertTriangle className="size-5 text-destructive" />
        </span>
        <div>
          <p className="text-fs-md font-semibold text-foreground">Attendance couldn&apos;t be loaded</p>
          <p className="mt-1 text-fs-sm text-muted-foreground">
            Nothing has changed — this is a problem reading the figures, not a problem with the event.
          </p>
        </div>
        <button
          type="button"
          onClick={reloadAll}
          className="inline-flex h-11 items-center gap-1.5 rounded-control border border-border px-3.5 text-fs-sm font-semibold text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
        >
          <RotateCw className="size-3.5" aria-hidden /> Try again
        </button>
      </div>
    )
  }

  if (state === 'forbidden') {
    return (
      <div className="rounded-surface border border-border bg-card px-4 py-14 text-center">
        <p className="text-fs-md font-semibold text-foreground">You don&apos;t have access to attendance</p>
        <p className="mx-auto mt-1 max-w-md text-fs-sm text-muted-foreground">
          Ask a workspace owner for the check-in permission.
        </p>
      </div>
    )
  }

  const counts = data && !data.statsUnavailable
    ? { confirmed: data.confirmedRegistrations, checkedIn: data.checkedInCount,
        cancelled: data.cancelledRegistrations, pending: 0, total: data.totalRegistrations }
    : null
  const metrics = attendanceMetrics(counts, data?.statsUnavailable ?? true)
  const pct     = attendancePercent(counts, data?.statsUnavailable ?? true)

  return (
    <div className="space-y-6">
      {/* ── PROGRESS — one line and a bar, not five cards ─────────────────── */}
      <section aria-labelledby="att-progress" className="min-w-0">
        <h2 id="att-progress" className="sr-only">Attendance progress</h2>
        <div className="rounded-surface border border-border bg-card p-4">
          <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
            <dl className="flex min-w-0 flex-wrap items-baseline gap-x-6 gap-y-2">
              {([
                { k: 'in',   label: 'Checked in', m: metrics.checkedIn, strong: true },
                { k: 'rem',  label: 'Yet to arrive', m: metrics.remaining, strong: false },
                { k: 'rate', label: 'Check-in rate', m: metrics.rate, strong: false },
              ]).map(({ k, label, m, strong }) => (
                <div key={k} className="min-w-0">
                  <dd className={cn(
                    'text-fs-lg font-semibold tabular-nums leading-none',
                    m.unavailable ? 'text-muted-foreground' : strong ? 'text-[color:var(--primary-text)]' : 'text-foreground',
                  )}>
                    {m.unavailable
                      ? <><span aria-hidden>{m.text}</span><span className="sr-only">Unavailable</span></>
                      : m.text}
                  </dd>
                  <dt className="mt-1 truncate text-fs-xs text-muted-foreground">
                    {label}{m.sub ? ` · ${m.sub}` : ''}
                  </dt>
                </div>
              ))}
            </dl>

            <Link
              href={`/dashboard/events/${encodeURIComponent(eventId)}/checkin`}
              className={cn(
                'inline-flex h-11 shrink-0 items-center gap-1.5 rounded-control px-3.5 text-fs-sm font-semibold',
                'bg-primary/[0.08] text-[color:var(--primary-text)] transition-colors hover:bg-primary/[0.14]',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 sm:h-9',
              )}
            >
              <ScanLine className="size-4" aria-hidden /> Open scanner
            </Link>
          </div>

          {/* The bar is drawn only when there is an authoritative figure behind it. */}
          {pct !== null ? (
            <div
              role="progressbar"
              aria-valuenow={pct}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={`${pct}% of confirmed ${noun.many} have checked in`}
              className="mt-4 h-2 w-full overflow-hidden rounded-pill bg-muted"
            >
              <div className={cn('h-full rounded-pill transition-[width] duration-500', accent('verify').bar)}
                   style={{ width: `${pct}%` }} />
            </div>
          ) : (
            <p className="mt-4 border-t border-border pt-3 text-fs-xs text-muted-foreground">
              {data?.statsUnavailable
                ? "These figures couldn't be loaded, so they are unavailable — not zero."
                : `No confirmed ${noun.many} yet, so there is no rate to show.`}
            </p>
          )}
        </div>
      </section>

      {/* ── ROLL CALL — the dominant area ────────────────────────────────── */}
      <Section
        id="att-roll"
        title="Find and check in"
        action={
          <span className="text-fs-xs text-muted-foreground" aria-live="polite">
            {rowsState === 'ok' && rows.length > 0 && `${rows.length}${hasMore ? '+' : ''} shown`}
          </span>
        }
      >
        <div className="overflow-hidden rounded-surface border border-border bg-card">
          {/* Controls */}
          <div className="flex flex-col gap-3 border-b border-border p-3 sm:flex-row sm:items-center">
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <label htmlFor="att-search" className="sr-only">
                Search {noun.many} by name, email or ticket code
              </label>
              <input
                id="att-search"
                type="search"
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder={`Search name, email${idLabel ? ', ticket code' : ' or ticket code'}…`}
                className={cn(
                  'h-11 w-full rounded-control border border-border bg-background pl-9 pr-9 text-fs-sm text-foreground',
                  'placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
                )}
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  aria-label="Clear search"
                  className="absolute right-1 top-1/2 flex size-9 -translate-y-1/2 items-center justify-center rounded-control text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                >
                  <X className="size-4" aria-hidden />
                </button>
              )}
            </div>

            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <div role="group" aria-label="Attendance filter" className="flex rounded-control border border-border p-0.5">
                {([
                  { v: 'out' as const, label: 'Not arrived' },
                  { v: 'in'  as const, label: 'Checked in' },
                  { v: 'all' as const, label: 'All' },
                ]).map(o => (
                  <button
                    key={o.v}
                    type="button"
                    aria-pressed={filter === o.v}
                    onClick={() => changeFilter(o.v)}
                    className={cn(
                      'inline-flex min-h-11 items-center whitespace-nowrap rounded-control px-2.5 text-fs-xs font-medium transition-colors sm:min-h-9',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40',
                      filter === o.v
                        ? 'bg-primary/[0.08] text-[color:var(--primary-text)]'
                        : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                    )}
                  >
                    {o.label}
                  </button>
                ))}
              </div>

              {event.passes.length > 1 && (
                <>
                  <label htmlFor="att-pass" className="sr-only">Filter by pass</label>
                  <select
                    id="att-pass"
                    value={passId}
                    onChange={e => changePass(e.target.value)}
                    className="h-11 min-w-0 max-w-[12rem] rounded-control border border-border bg-background px-2.5 text-fs-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 sm:h-9"
                  >
                    <option value="">All passes</option>
                    {event.passes.map(p => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                </>
              )}
            </div>
          </div>

          {/* Searching matches across the whole event, so the filter chips do not
              apply to it. Saying so is cheaper than a reader wondering why a checked-in
              person appeared under "Not arrived". */}
          {shouldSearch(debounced) && rowsState === 'ok' && rows.length > 0 && (
            <p className="border-b border-border px-4 py-2 text-fs-2xs text-muted-foreground">
              Showing everyone matching “{debounced}”, regardless of the filter.
              {searchTruncated && ' Too many matches to show them all — narrow the search, or use a ticket code.'}
            </p>
          )}

          {/* An incomplete roll call is stated, never quietly served. */}
          {!listComplete && filter === 'out' && !shouldSearch(debounced) && (
            <p role="alert" className="flex items-start gap-2 border-b border-border bg-warning/[0.06] px-4 py-2.5 text-fs-xs text-muted-foreground">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />
              Some older registrations don&apos;t record an arrival state and are missing from this
              list. Use “All” to see everyone.
            </p>
          )}

          {/* Rows */}
          {rowsState === 'loading' ? (
            <div className="space-y-2 p-3" aria-busy="true" aria-live="polite">
              {[0, 1, 2, 3, 4].map(i => <div key={i} className="h-14 animate-pulse rounded-control bg-muted" />)}
              <span className="sr-only">Loading {noun.many}…</span>
            </div>
          ) : rowsState === 'error' ? (
            <div role="alert" className="flex flex-wrap items-center justify-center gap-3 px-4 py-10 text-center">
              <p className="text-fs-sm text-muted-foreground">
                {debounced ? "Search couldn't be completed." : `${noun.many.charAt(0).toUpperCase() + noun.many.slice(1)} couldn't be loaded.`}
              </p>
              <button
                type="button"
                onClick={() => setRowsAttempt(a => a + 1)}
                className="inline-flex h-11 items-center gap-1.5 rounded-control border border-border px-3 text-fs-xs font-semibold text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
              >
                <RotateCw className="size-3.5" aria-hidden /> Try again
              </button>
            </div>
          ) : rows.length === 0 ? (
            <p className="px-4 py-12 text-center text-fs-sm text-muted-foreground">
              {rowsState === 'forbidden'
                ? 'Registration data is not available for this event yet.'
                : filterEmptyMessage(filter, Boolean(debounced), noun)}
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {rows.map(r => {
                const act  = rowAction(r, gate.accepts)
                const busy = Boolean(busyRows[r.id])
                const at   = checkInClock(r.checkedInAt, timeZone)
                const idv  = r.identifier
                return (
                  <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-3 sm:flex-nowrap">
                    <span
                      className="flex size-9 shrink-0 items-center justify-center rounded-pill bg-muted text-fs-xs font-semibold text-muted-foreground"
                      aria-hidden
                    >
                      {(r.name || '?').charAt(0).toUpperCase()}
                    </span>

                    <span className="min-w-0 flex-1 basis-[12rem]">
                      <span className="block truncate text-fs-sm font-medium text-foreground">
                        {r.name || 'Unnamed'}
                      </span>
                      <span className="block truncate text-fs-2xs text-muted-foreground">
                        {[
                          idLabel && idv ? `${idLabel} ${idv}` : null,
                          r.passName,
                          at ? `In at ${at}` : null,
                        ].filter(Boolean).join(' · ') || r.ticketCode}
                      </span>
                    </span>

                    <StatusPill checkedIn={r.checkedIn} status={r.status} />

                    {act.kind === 'check-in' && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void mutate(r, 'in')}
                        aria-label={`Check in ${r.name || r.ticketCode}`}
                        className={cn(
                          'inline-flex h-11 shrink-0 items-center gap-1.5 rounded-control px-3 text-fs-xs font-semibold sm:h-9',
                          'bg-primary/[0.08] text-[color:var(--primary-text)] transition-colors hover:bg-primary/[0.14]',
                          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
                          'disabled:cursor-not-allowed disabled:opacity-60',
                        )}
                      >
                        {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Check className="size-3.5" aria-hidden />}
                        Check in
                      </button>
                    )}
                    {act.kind === 'undo' && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void mutate(r, 'out')}
                        aria-label={`Undo check-in for ${r.name || r.ticketCode}`}
                        className={cn(
                          'inline-flex h-11 shrink-0 items-center gap-1.5 rounded-control border border-border px-3 text-fs-xs font-medium sm:h-9',
                          'text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
                          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
                          'disabled:cursor-not-allowed disabled:opacity-60',
                        )}
                      >
                        {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Undo2 className="size-3.5" aria-hidden />}
                        Undo
                      </button>
                    )}
                    {act.kind === 'blocked' && (
                      <span className="shrink-0 text-fs-2xs text-muted-foreground">{act.reason}</span>
                    )}
                  </li>
                )
              })}
            </ul>
          )}

          {hasMore && rowsState === 'ok' && (
            <div className="border-t border-border p-3">
              <button
                type="button"
                disabled={pageBusy}
                onClick={() => setCursor(rows[rows.length - 1]?.id ?? null)}
                className="inline-flex h-11 w-full items-center justify-center gap-1.5 rounded-control border border-border text-fs-sm font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-60"
              >
                {pageBusy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
                {pageBusy ? 'Loading…' : `Load ${PAGE_SIZE} more`}
              </button>
            </div>
          )}
        </div>
      </Section>

      {/* ── ARRIVALS + RECENT ────────────────────────────────────────────── */}
      <div className="grid gap-6 lg:grid-cols-2">
        {data && <HourlyPanel data={data} noun={noun} />}
        {data && <RecentPanel data={data} timeZone={timeZone} now={now} />}
      </div>

      {/* ── PER-PASS ─────────────────────────────────────────────────────── */}
      {data && data.passStats.length > 0 && (
        <PassPanel stats={data.passStats} unavailable={data.statsUnavailable} />
      )}
    </div>
  )
}

// ─── Hourly arrivals ──────────────────────────────────────────────────────────

function HourlyPanel({ data, noun }: {
  data: AttendanceDashboardResponse
  noun: { many: string }
}) {
  const view = useMemo(() => hourlyView(data.hourlyBuckets), [data.hourlyBuckets])

  return (
    <Section id="att-hourly" title="Arrivals today">
      <div className="rounded-surface border border-border bg-card p-4">
        {data.hourlyUnavailable || data.hourlyBuckets.length === 0 ? (
          <p className="py-10 text-center text-fs-sm text-muted-foreground">
            {data.hourlyUnavailable
              ? "Arrivals couldn't be loaded."
              : `No arrivals recorded today.`}
          </p>
        ) : view.allZero ? (
          <p className="py-10 text-center text-fs-sm text-muted-foreground">
            No {noun.many} have arrived today yet.
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-fs-xs text-muted-foreground">{data.hourlyDate} · {data.timeZone}</p>
              <p className="text-fs-xs text-muted-foreground">
                {view.total !== null
                  ? <><span className="font-semibold text-foreground">{view.total.toLocaleString('en-IN')}</span> today</>
                  : 'Today’s total unavailable'}
              </p>
            </div>

            {/* `h-full` is load-bearing: a percentage height resolves against a flex
                child whose own height is `auto` as ZERO — which is exactly why the
                old chart rendered its labels above nothing at all. */}
            <div className="mt-3 flex h-24 items-end gap-1" aria-hidden>
              {data.hourlyBuckets.map(b => {
                const p = hourBarPercent(b.count, view.peak)
                return (
                  <div key={b.hour} className="flex h-full min-w-0 flex-1 flex-col items-center justify-end">
                    {p === null ? (
                      <div className="w-full rounded-t-control border border-dashed border-border" style={{ height: '100%' }} />
                    ) : (
                      <div className="w-full rounded-t-control bg-primary/70"
                           style={{ height: `${Math.max(p, b.count && b.count > 0 ? 4 : 0)}%` }} />
                    )}
                  </div>
                )
              })}
            </div>
            <div className="mt-1 flex gap-1" aria-hidden>
              {data.hourlyBuckets.map((b, i) => (
                <span key={b.hour} className={cn(
                  'min-w-0 flex-1 truncate text-center text-fs-2xs text-muted-foreground',
                  i % 3 !== 0 && 'invisible sm:visible',
                )}>
                  {b.label.replace(' ', '')}
                </span>
              ))}
            </div>

            <details className="mt-3">
              <summary className="inline-flex h-11 cursor-pointer items-center rounded-control px-2 text-fs-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40">
                Show exact hourly figures
              </summary>
              <div className="mt-2 max-h-56 overflow-auto">
                <table className="w-full min-w-[14rem] text-left">
                  <caption className="sr-only">
                    Check-ins per hour on {data.hourlyDate}, in {data.timeZone}
                  </caption>
                  <thead>
                    <tr className="border-b border-border">
                      <th scope="col" className="py-1.5 pr-3 text-fs-2xs font-medium text-muted-foreground">Hour</th>
                      <th scope="col" className="py-1.5 text-fs-2xs font-medium text-muted-foreground">Arrivals</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.hourlyBuckets.map(b => (
                      <tr key={b.hour} className="border-b border-border/60 last:border-0">
                        <th scope="row" className="py-1.5 pr-3 text-fs-xs font-normal text-muted-foreground">{b.label}</th>
                        <td className="py-1.5 text-fs-xs tabular-nums text-foreground">
                          {b.count === null
                            ? <><span aria-hidden>{UNAVAILABLE}</span><span className="sr-only">Unavailable</span></>
                            : b.count.toLocaleString('en-IN')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>

            {view.partial && (
              <p className="mt-2 flex items-start gap-1.5 text-fs-2xs text-muted-foreground">
                <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden />
                Some hours couldn&apos;t be counted and are shown as gaps — they are not zero.
              </p>
            )}
          </>
        )}
      </div>
    </Section>
  )
}

// ─── Recent check-ins ─────────────────────────────────────────────────────────

function RecentPanel({ data, timeZone, now }: {
  data: AttendanceDashboardResponse
  timeZone: string
  now: number
}) {
  return (
    <Section id="att-recent" title="Recent check-ins">
      <div className="overflow-hidden rounded-surface border border-border bg-card">
        {data.recentCheckIns.length === 0 ? (
          <p className="px-4 py-12 text-center text-fs-sm text-muted-foreground">
            Nobody has checked in yet.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {data.recentCheckIns.map(c => (
              <li key={c.registrationId} className="flex items-center gap-3 px-4 py-2.5">
                <span className={cn('flex size-7 shrink-0 items-center justify-center rounded-pill text-fs-2xs font-semibold', accent('verify').tile)} aria-hidden>
                  <Check className="size-3.5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-fs-sm font-medium text-foreground">{c.attendeeName || 'Unnamed'}</span>
                  <span className="block truncate text-fs-2xs text-muted-foreground">{c.passName || c.ticketCode}</span>
                </span>
                <span className="shrink-0 text-right">
                  <span className="block text-fs-xs tabular-nums text-foreground">
                    {checkInClock(c.checkedInAt, timeZone) ?? UNAVAILABLE}
                  </span>
                  <span className="block text-fs-2xs text-muted-foreground">{sinceLabel(c.checkedInAt, now) ?? ''}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
        {data.recentCheckIns.length > 0 && (
          <p className="border-t border-border px-4 py-2 text-fs-2xs text-muted-foreground">
            The {data.recentCheckIns.length} most recent. Use the list above for everyone.
          </p>
        )}
      </div>
    </Section>
  )
}

// ─── Per-pass ─────────────────────────────────────────────────────────────────

function PassPanel({ stats, unavailable }: { stats: PassAttendanceStat[]; unavailable: boolean }) {
  return (
    <Section id="att-pass" title="Arrivals by pass">
      <div className="overflow-x-auto rounded-surface border border-border bg-card">
        <table className="w-full min-w-[30rem] text-left">
          <caption className="sr-only">Check-ins per pass</caption>
          <thead>
            <tr className="border-b border-border">
              {['Pass', 'Registered', 'Checked in', 'Rate'].map((h, i) => (
                <th key={h} scope="col"
                    className={cn('px-4 py-2 text-fs-2xs font-medium text-muted-foreground', i > 0 && 'text-right')}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {stats.map(p => (
              <tr key={p.passId}>
                <th scope="row" className="max-w-[16rem] truncate px-4 py-2.5 text-fs-sm font-medium text-foreground">
                  {p.passName}
                </th>
                <td className="px-4 py-2.5 text-right text-fs-sm tabular-nums text-muted-foreground">
                  {unavailable
                    ? <><span aria-hidden>{UNAVAILABLE}</span><span className="sr-only">Unavailable</span></>
                    : p.registered.toLocaleString('en-IN')}
                </td>
                <td className="px-4 py-2.5 text-right text-fs-sm font-semibold tabular-nums text-foreground">
                  {unavailable
                    ? <><span aria-hidden>{UNAVAILABLE}</span><span className="sr-only">Unavailable</span></>
                    : p.checkedIn.toLocaleString('en-IN')}
                </td>
                <td className="px-4 py-2.5 text-right">
                  <span className="inline-flex items-center justify-end gap-2">
                    <span className="hidden h-1.5 w-16 overflow-hidden rounded-pill bg-muted sm:block" aria-hidden>
                      <span className={cn('block h-full rounded-pill', accent('verify').bar)}
                            style={{ width: `${p.registered > 0 ? p.attendancePct : 0}%` }} />
                    </span>
                    <span className="text-fs-sm tabular-nums text-foreground">
                      {p.registered > 0 ? `${p.attendancePct}%` : UNAVAILABLE}
                    </span>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 flex items-center gap-1.5 px-1 text-fs-2xs text-muted-foreground">
        <Clock className="size-3" aria-hidden /> Updates automatically while this tab is open.
      </p>
    </Section>
  )
}
