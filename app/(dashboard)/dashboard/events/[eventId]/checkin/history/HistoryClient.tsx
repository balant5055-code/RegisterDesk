'use client'

// RD-CHECKIN-04 — the check-in history, as an operations ledger.
//
// ═══ WHAT THIS SURFACE IS FOR ════════════════════════════════════════════════
// One question: "what happened at the gate?" Asked by an organizer, usually about
// one person, usually while that person is standing there. So the ledger reads
// chronologically, every row names the operator, and any row opens that
// participant's COMPLETE timeline in place — because the follow-up question is
// always "and what happened before that?"
//
// ═══ READ-ONLY, DELIBERATELY ═════════════════════════════════════════════════
// There is no control here that changes anything. The history is append-only
// server-side and this surface must never become the exception — no edit, no
// delete, no "correct this entry". A disputed admission is settled by reading, and
// corrections happen at the gate through the check-in routes that write their own
// history.
//
// ═══ THE ROW IS THE RECORD, NOT A CARD ═══════════════════════════════════════
// Dense rows under sticky day headers, not a stack of cards: an operator scanning
// for a name at 7am wants many rows on screen, and every card border is a row they
// cannot see. Action is carried by a word AND an icon AND a rail colour, never by
// colour alone.

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import {
  AlertCircle, ChevronLeft, ChevronRight, Clock, Loader2, LogIn, RotateCcw,
  ScanLine, Keyboard, Search, UserPlus, History as HistoryIcon, RefreshCw,
} from 'lucide-react'
import { useAuth } from '@/components/auth/AuthProvider'
import { cn } from '@/lib/utils/cn'
import type {
  CheckinHistoryResponse, CheckinHistoryRow,
} from '@/app/api/organizer/events/[eventId]/checkin/history/route'

/** How each admission was performed, in the organizer's language. */
const METHOD_LABEL: Record<string, string> = {
  qr:         'QR scan',
  manual:     'Ticket code',
  lookup:     'Lookup',
  walkin:     'Walk-in',
  operations: 'Operations',
  bulk:       'Bulk',
  unknown:    'Unrecorded',
}

const METHOD_ICON: Record<string, typeof ScanLine> = {
  qr:     ScanLine,
  manual: Keyboard,
  lookup: Search,
  walkin: UserPlus,
}

/** Day header key — the viewer's own locale day, so "today" means their today. */
function dayKey(iso: string | null): string {
  if (!iso) return 'unknown'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? 'unknown' : d.toDateString()
}

function dayLabel(key: string): string {
  if (key === 'unknown') return 'Undated'
  const d = new Date(key)
  const today = new Date().toDateString()
  const yday  = new Date(Date.now() - 86_400_000).toDateString()
  if (key === today) return 'Today'
  if (key === yday)  return 'Yesterday'
  return d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
}

function clock(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true })
}

// ─── One ledger row ───────────────────────────────────────────────────────────

function Row({
  row, identifierLabel, expanded, onToggle, busy,
}: {
  row: CheckinHistoryRow
  identifierLabel: string
  expanded: boolean
  onToggle: () => void
  busy: boolean
}) {
  const undone = row.action === 'CHECK_IN_UNDO'
  const Icon   = undone ? RotateCcw : LogIn
  const MethodIcon = METHOD_ICON[row.method]

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      className={cn(
        'flex w-full items-start gap-3 px-4 py-3 text-left transition-colors',
        'hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none',
        'focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary',
      )}
    >
      {/* Rail + icon — the action is readable before any text is. */}
      <span
        className={cn(
          'mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg',
          undone ? 'bg-warning/10 text-warning' : 'bg-success/10 text-success',
        )}
        aria-hidden
      >
        <Icon className="size-3.5" />
      </span>

      <span className="min-w-0 flex-1">
        {/* The WORD, always — never colour alone. */}
        <span className={cn(
          'text-fs-2xs font-bold uppercase tracking-wider',
          undone ? 'text-warning' : 'text-success',
        )}>
          {undone ? 'Check-in undone' : 'Checked in'}
        </span>

        <span className="mt-0.5 block truncate text-fs-sm font-semibold text-foreground">
          {row.attendeeName ?? 'Registration removed'}
        </span>

        <span className="mt-0.5 block truncate text-fs-2xs text-muted-foreground">
          {row.ticketCode && <span className="font-mono">{row.ticketCode}</span>}
          {row.identifierValue && (
            <> · <span className="font-semibold text-foreground">{identifierLabel} {row.identifierValue}</span></>
          )}
          {row.passName && <> · {row.passName}</>}
        </span>
      </span>

      {/* Operator + method + time. Right-aligned so the eye can run down it. */}
      <span className="flex shrink-0 flex-col items-end gap-0.5 text-right">
        <span className="text-fs-2xs font-semibold tabular-nums text-foreground">
          {clock(row.occurredAt)}
        </span>
        <span className="max-w-[10rem] truncate text-fs-2xs text-muted-foreground">
          {row.operatorName ?? 'Unknown operator'}
        </span>
        <span className="inline-flex items-center gap-1 text-fs-2xs text-muted-foreground">
          {MethodIcon && <MethodIcon className="size-3" aria-hidden />}
          {METHOD_LABEL[row.method] ?? row.method}
        </span>
      </span>

      <ChevronRight
        className={cn(
          'mt-1 size-4 shrink-0 text-muted-foreground transition-transform',
          expanded && 'rotate-90',
          busy && 'animate-pulse',
        )}
        aria-hidden
      />
    </button>
  )
}

// ─── Participant timeline (inline, on demand) ────────────────────────────────

function Timeline({
  rows, identifierLabel, loading,
}: {
  rows: CheckinHistoryRow[] | null
  identifierLabel: string
  loading: boolean
}) {
  if (loading) {
    return (
      <p className="flex items-center gap-2 border-t border-border bg-muted/20 px-4 py-3 text-fs-2xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" aria-hidden /> Loading this participant’s full timeline…
      </p>
    )
  }
  if (!rows) return null
  if (rows.length === 0) {
    return (
      <p className="border-t border-border bg-muted/20 px-4 py-3 text-fs-2xs text-muted-foreground">
        No further history for this participant.
      </p>
    )
  }

  return (
    <div className="border-t border-border bg-muted/20 px-4 py-3">
      <p className="mb-2 text-fs-2xs font-semibold uppercase tracking-wider text-muted-foreground">
        Complete timeline — {rows.length} {rows.length === 1 ? 'entry' : 'entries'}, oldest first
      </p>
      <ol className="flex flex-col gap-1.5">
        {rows.map(r => {
          const undone = r.action === 'CHECK_IN_UNDO'
          return (
            <li key={r.id} className="flex items-baseline gap-2.5 text-fs-2xs">
              <span className={cn(
                'w-28 shrink-0 font-semibold uppercase tracking-wider',
                undone ? 'text-warning' : 'text-success',
              )}>
                {undone ? 'Undone' : 'Checked in'}
              </span>
              <span className="w-24 shrink-0 tabular-nums text-foreground">{clock(r.occurredAt)}</span>
              <span className="min-w-0 flex-1 truncate text-muted-foreground">
                {r.operatorName ?? 'Unknown operator'} · {METHOD_LABEL[r.method] ?? r.method}
                {r.identifierValue && <> · {identifierLabel} {r.identifierValue}</>}
                {r.reason && <> · {r.reason}</>}
              </span>
            </li>
          )
        })}
      </ol>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function HistoryClient({ eventId }: { eventId: string }) {
  const { user, getToken } = useAuth()

  const [rows,    setRows]    = useState<CheckinHistoryRow[]>([])
  const [meta,    setMeta]    = useState<Pick<CheckinHistoryResponse, 'identifierLabel' | 'eventName'> | null>(null)
  const [before,  setBefore]  = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [more,    setMore]    = useState(false)
  const [error,   setError]   = useState<string | null>(null)

  const [openId,   setOpenId]   = useState<string | null>(null)
  const [timeline, setTimeline] = useState<CheckinHistoryRow[] | null>(null)
  const [tlLoading, setTlLoading] = useState(false)

  const base = `/api/organizer/events/${encodeURIComponent(eventId)}/checkin/history`
  /**
   * Retry counter, NOT a ref — and NO in-flight ref guard beside it.
   *
   * Two bugs were found here in one sitting, and the second was caused by the fix
   * for the first:
   *
   *   1. The original latched "already loaded" in a ref that Try again reset. A ref
   *      mutation is not a dependency, so the effect never re-ran: the button set
   *      `loading` to true and the page sat on the spinner forever.
   *
   *   2. Replacing it with a counter AND keeping a ref guard deadlocked under React
   *      StrictMode, which double-invokes effects in development. Pass 1 set the
   *      guard and started a fetch; cleanup marked it cancelled; pass 2 saw the
   *      guard and returned immediately. Pass 1's result was then discarded as
   *      stale, so `setLoading(false)` ran on neither path — the page loaded
   *      nothing, forever. Browser QA caught it; nothing else would have.
   *
   * The dependency array is the only thing that decides when this runs, and the
   * cancellation flag is the only thing that decides whose result is kept. That is
   * sufficient, and adding a guard on top of it is what broke it.
   */
  const [attempt, setAttempt] = useState(0)

  const load = useCallback(async (cursor: string | null) => {
    const token = await getToken()
    if (!token) { setError('Your session has expired. Sign in again.'); return }
    const url = cursor ? `${base}?before=${encodeURIComponent(cursor)}` : base
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' })
    if (!res.ok) {
      const body = await res.json().catch(() => null) as { error?: string } | null
      // The server's own words — including "the index has not been created", which
      // must never be shown as "no history".
      throw new Error(body?.error ?? 'Could not load check-in history.')
    }
    return await res.json() as CheckinHistoryResponse
  }, [base, getToken])

  useEffect(() => {
    if (!user) return
    let active = true
    void (async () => {
      try {
        const data = await load(null)
        if (!active || !data) return
        setRows(data.rows)
        setMeta({ identifierLabel: data.identifierLabel, eventName: data.eventName })
        setBefore(data.nextBefore)
        setError(null)
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : 'Could not load check-in history.')
      } finally {
        if (active) setLoading(false)
      }
    })()
    return () => { active = false }
  }, [user, load, attempt])

  const loadOlder = useCallback(async () => {
    if (!before || more) return
    setMore(true)
    try {
      const data = await load(before)
      if (data) {
        setRows(r => [...r, ...data.rows])
        setBefore(data.nextBefore)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load older entries.')
    } finally {
      setMore(false)
    }
  }, [before, more, load])

  const openTimeline = useCallback(async (row: CheckinHistoryRow) => {
    if (openId === row.id) { setOpenId(null); setTimeline(null); return }
    setOpenId(row.id)
    setTimeline(null)
    setTlLoading(true)
    try {
      const token = await getToken()
      const res = await fetch(
        `${base}?registrationId=${encodeURIComponent(row.registrationId)}`,
        { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' },
      )
      setTimeline(res.ok ? (await res.json() as CheckinHistoryResponse).rows : [])
    } catch {
      setTimeline([])
    } finally {
      setTlLoading(false)
    }
  }, [openId, base, getToken])

  /** Grouped by the viewer's own day, preserving the server's newest-first order. */
  const groups = useMemo(() => {
    const out: { key: string; rows: CheckinHistoryRow[] }[] = []
    for (const r of rows) {
      const k = dayKey(r.occurredAt)
      const last = out[out.length - 1]
      if (last && last.key === k) last.rows.push(r)
      else out.push({ key: k, rows: [r] })
    }
    return out
  }, [rows])

  const identifierLabel = meta?.identifierLabel ?? 'Identifier'

  return (
    <div className="min-h-screen bg-background">
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="sticky top-0 z-20 border-b border-border bg-background/95 backdrop-blur">
        <div className="mx-auto flex max-w-4xl items-center gap-3 px-4 py-3 sm:px-6">
          <Link
            href={`/dashboard/events/${eventId}/checkin`}
            className="inline-flex items-center gap-1 text-fs-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <ChevronLeft className="size-4" aria-hidden /> Check-in
          </Link>
        </div>
      </div>

      <main className="mx-auto max-w-4xl px-4 py-6 sm:px-6">
        <header className="mb-5 flex flex-wrap items-start justify-between gap-3 border-b border-border pb-4">
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 text-fs-2xs font-semibold uppercase tracking-wider text-muted-foreground">
              <HistoryIcon className="size-3.5" aria-hidden /> Check-in history
            </p>
            <h1 className="mt-0.5 truncate text-fs-xl font-bold leading-tight text-foreground">
              {meta?.eventName ?? 'Loading…'}
            </h1>
            <p className="mt-1 text-fs-2xs text-muted-foreground">
              Every admission and every reversal, newest first. This record is append-only —
              nothing here can be edited or removed.
            </p>
          </div>
          {rows.length > 0 && (
            <p className="shrink-0 text-fs-2xs tabular-nums text-muted-foreground">
              {rows.length.toLocaleString('en-IN')} loaded
            </p>
          )}
        </header>

        {/* ── Loading ──────────────────────────────────────────────────── */}
        {loading && (
          <p className="flex items-center gap-2 py-10 text-fs-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden /> Loading check-in history…
          </p>
        )}

        {/* ── Error — the server's own sentence ────────────────────────── */}
        {!loading && error && (
          <div className="flex flex-col gap-3 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-4">
            <p className="flex items-start gap-2 text-fs-sm text-foreground">
              <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
              {error}
            </p>
            <button
              type="button"
              onClick={() => { setError(null); setLoading(true); setAttempt(a => a + 1) }}
              className="inline-flex w-fit items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-fs-sm font-semibold"
            >
              <RefreshCw className="size-3.5" aria-hidden /> Try again
            </button>
          </div>
        )}

        {/* ── Empty ────────────────────────────────────────────────────── */}
        {!loading && !error && rows.length === 0 && (
          <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border px-6 py-14 text-center">
            <Clock className="size-6 text-muted-foreground" aria-hidden />
            <p className="text-fs-sm font-semibold text-foreground">No check-ins recorded yet</p>
            <p className="max-w-sm text-fs-sm text-muted-foreground">
              Admissions appear here the moment they happen at the gate, with the operator who
              performed each one.
            </p>
          </div>
        )}

        {/* ── The ledger ───────────────────────────────────────────────── */}
        {!loading && !error && groups.length > 0 && (
          <div className="overflow-hidden rounded-xl border border-border bg-card">
            {groups.map(g => (
              <section key={g.key} aria-label={dayLabel(g.key)}>
                {/* NOT sticky — a decision browser QA forced, twice over.

                    As `sticky top-[3.25rem]` this label caused two real defects.
                    It intercepted pointer events, so a row sitting beneath it had
                    its top ~28px go dead and clicking the attendee name there did
                    nothing at all. And the offset assumes the page header is
                    exactly 52px tall, which does not hold on a phone — so the
                    label was pushed down onto the first row and covered it.

                    A day label is worth very little; two layout defects cost more
                    than it does. In normal flow it is correct on every viewport,
                    and the ledger is chronological anyway, so a reader scrolling
                    it never loses their place. */}
                <h2 className="border-b border-border bg-muted px-4 py-1.5 text-fs-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                  {dayLabel(g.key)}
                </h2>
                <ul className="divide-y divide-border">
                  {g.rows.map(r => (
                    <li key={r.id}>
                      <Row
                        row={r}
                        identifierLabel={identifierLabel}
                        expanded={openId === r.id}
                        onToggle={() => void openTimeline(r)}
                        busy={tlLoading && openId === r.id}
                      />
                      {openId === r.id && (
                        <Timeline rows={timeline} identifierLabel={identifierLabel} loading={tlLoading} />
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}

        {/* ── Older ────────────────────────────────────────────────────── */}
        {!loading && !error && before && (
          <button
            type="button"
            onClick={() => void loadOlder()}
            disabled={more}
            className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-xl border border-border bg-card px-4 py-3 text-fs-sm font-semibold text-foreground disabled:opacity-50"
          >
            {more ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Clock className="size-4" aria-hidden />}
            {more ? 'Loading…' : 'Load older entries'}
          </button>
        )}

        {!loading && !error && !before && rows.length > 0 && (
          <p className="mt-4 text-center text-fs-2xs text-muted-foreground">
            That is the complete history for this event.
          </p>
        )}
      </main>
    </div>
  )
}
