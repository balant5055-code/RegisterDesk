'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { cn }                                        from '@/lib/utils/cn'
import {
  Search, X, Loader2, CheckCircle2, AlertCircle,
  XCircle, UserSearch, Clock,
} from 'lucide-react'
import type { AttendeeSearchResult, AttendeeSearchResponse } from '@/app/api/organizer/events/[eventId]/checkin/search/route'
import type { CheckInResult }                                from '@/app/api/checkin/scan/route'

// ─── Types ────────────────────────────────────────────────────────────────────

interface Props {
  eventId:     string
  token:       string
  onCheckedIn: () => void
}

interface CardAction {
  loading: boolean
  result:  CheckInResult | null
}

// ─── Status meta ──────────────────────────────────────────────────────────────

function statusMeta(s: string): { label: string; cls: string } {
  switch (s) {
    case 'confirmed':  return { label: 'Confirmed',  cls: 'bg-emerald-100 text-emerald-700' }
    case 'pending':    return { label: 'Pending',    cls: 'bg-amber-100 text-amber-700'     }
    case 'cancelled':  return { label: 'Cancelled',  cls: 'bg-red-100 text-red-600'         }
    case 'waitlisted': return { label: 'Waitlisted', cls: 'bg-sky-100 text-sky-700'         }
    default:           return { label: s,            cls: 'bg-muted text-muted-foreground'  }
  }
}

function fmtTime(iso: string | null): string {
  if (!iso) return ''
  return new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })
}

// ─── Inline check-in error message map ───────────────────────────────────────

const ERROR_MSG: Record<string, string> = {
  TICKET_NOT_FOUND:       'Ticket not found.',
  REGISTRATION_CANCELLED: 'Registration is cancelled.',
  EVENT_CANCELLED:        'Event is cancelled.',
  UNAUTHORIZED:           'Permission denied.',
  INVALID_TOKEN:          'Session expired. Refresh the page.',
  NETWORK_ERROR:          'Network error.',
}

// ─── Attendee Card ────────────────────────────────────────────────────────────

function AttendeeCard({
  reg,
  action,
  onCheckIn,
}: {
  reg:       AttendeeSearchResult
  action:    CardAction | undefined
  onCheckIn: (reg: AttendeeSearchResult) => void
}) {
  const sm = statusMeta(reg.status)

  // After a successful check-in from this card, treat the item as checked-in
  const isCheckedIn =
    reg.checkedIn ||
    (action?.result?.success && !action.result.alreadyCheckedIn)

  const checkedInTime =
    isCheckedIn && !reg.checkedIn && action?.result?.checkedInAt
      ? fmtTime(action.result.checkedInAt)
      : reg.checkedIn && reg.checkedInAt
        ? fmtTime(reg.checkedInAt)
        : null

  const canCheckIn = !isCheckedIn && reg.status !== 'cancelled'

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      {/* Row 1: name + check-in status */}
      <div className="flex items-start justify-between gap-3">
        <p className="text-[15px] font-bold text-foreground leading-tight">
          {reg.attendeeName}
        </p>

        {/* Already checked in indicator */}
        {isCheckedIn && (
          <div className="flex shrink-0 flex-col items-end gap-0.5">
            <span className="flex items-center gap-1 rounded-full bg-emerald-100 px-2.5 py-1 text-[11.5px] font-semibold text-emerald-700">
              <CheckCircle2 className="size-3" aria-hidden />
              Checked In
            </span>
            {checkedInTime && (
              <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                <Clock className="size-2.5" aria-hidden />
                {checkedInTime}
              </span>
            )}
          </div>
        )}

        {/* Check In button */}
        {canCheckIn && !action?.loading && !action?.result && (
          <button
            type="button"
            onClick={() => onCheckIn(reg)}
            className="shrink-0 rounded-xl bg-primary px-4 py-2 text-[13px] font-semibold text-white hover:bg-[#bf1868] active:scale-95 transition-transform"
          >
            Check In
          </button>
        )}

        {/* Loading state */}
        {action?.loading && (
          <Loader2 className="mt-1 size-5 shrink-0 animate-spin text-primary" aria-hidden />
        )}

        {/* Already checked in via this action */}
        {!isCheckedIn && action?.result?.alreadyCheckedIn && (
          <span className="flex shrink-0 items-center gap-1 rounded-full bg-amber-100 px-2.5 py-1 text-[11.5px] font-semibold text-amber-700">
            <AlertCircle className="size-3" aria-hidden />
            Already In
          </span>
        )}

        {/* Error state */}
        {action?.result && !action.result.success && (
          <span className="flex shrink-0 items-center gap-1 rounded-full bg-red-100 px-2.5 py-1 text-[11.5px] font-semibold text-red-600">
            <XCircle className="size-3" aria-hidden />
            Failed
          </span>
        )}
      </div>

      {/* Row 2: email · phone */}
      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[12.5px] text-muted-foreground">
        <span className="truncate">{reg.attendeeEmail}</span>
        {reg.attendeePhone && <span>{reg.attendeePhone}</span>}
      </div>

      {/* Row 3: ticket code · pass · status */}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <span className="font-mono text-[11.5px] font-medium text-foreground tracking-wide">
          {reg.ticketCode}
        </span>
        <span className="text-muted-foreground/40">·</span>
        <span className="text-[12px] text-muted-foreground">{reg.passName}</span>
        <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-semibold', sm.cls)}>
          {sm.label}
        </span>
      </div>

      {/* Inline error message */}
      {action?.result && !action.result.success && (
        <p className="mt-2 text-[12px] text-red-600">
          {ERROR_MSG[action.result.error ?? ''] ?? action.result.error ?? 'Something went wrong.'}
        </p>
      )}
    </div>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function AttendeeSearch({ eventId, token, onCheckedIn }: Props) {
  const [query,   setQuery]   = useState('')
  const [results, setResults] = useState<AttendeeSearchResult[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState<string | null>(null)
  const [truncated, setTruncated] = useState(false)
  // Per-registration action state (check-in in-flight / result)
  const [actions, setActions] = useState<Record<string, CardAction>>({})

  const inputRef   = useRef<HTMLInputElement>(null)
  const abortRef   = useRef<AbortController | null>(null)

  // Auto-focus on mount
  useEffect(() => { inputRef.current?.focus() }, [])

  // ── Search with debounce ─────────────────────────────────────────────────

  const doSearch = useCallback(async (q: string, signal: AbortSignal) => {
    setLoading(true)
    setError(null)
    try {
      const res  = await fetch(
        `/api/organizer/events/${eventId}/checkin/search?q=${encodeURIComponent(q)}`,
        { headers: { Authorization: `Bearer ${token}` }, signal },
      )
      if (signal.aborted) return
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string }
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      const data = await res.json() as AttendeeSearchResponse
      setResults(data.results)
      setTruncated(data.truncated)
    } catch (e) {
      if ((e as Error).name === 'AbortError') return
      setError('Search failed. Try again.')
      setResults(null)
    } finally {
      setLoading(false)
    }
  }, [eventId, token])

  useEffect(() => {
    const trimmed = query.trim()

    // Clear results for very short queries without hitting server
    if (trimmed.length < 2) {
      setResults(null)
      setError(null)
      setTruncated(false)
      abortRef.current?.abort()
      return
    }

    // Debounce 300 ms
    const timer = setTimeout(() => {
      abortRef.current?.abort()
      const ctrl = new AbortController()
      abortRef.current = ctrl
      doSearch(trimmed, ctrl.signal)
    }, 300)

    return () => clearTimeout(timer)
  }, [query, doSearch])

  // ── Check-in action ────────────────────────────────────────────────────────

  async function handleCheckIn(reg: AttendeeSearchResult) {
    setActions(prev => ({ ...prev, [reg.id]: { loading: true, result: null } }))
    try {
      const res  = await fetch('/api/checkin/scan', {
        method:  'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ ticketCode: reg.ticketCode }),
      })
      const data = await res.json() as CheckInResult
      setActions(prev => ({ ...prev, [reg.id]: { loading: false, result: data } }))
      if (data.success && !data.alreadyCheckedIn) {
        onCheckedIn()
      }
    } catch {
      setActions(prev => ({
        ...prev,
        [reg.id]: { loading: false, result: { success: false, error: 'NETWORK_ERROR' } },
      }))
    }
  }

  function clearQuery() {
    setQuery('')
    setResults(null)
    setError(null)
    setActions({})
    inputRef.current?.focus()
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  const hasQuery   = query.trim().length >= 2
  const showEmpty  = hasQuery && !loading && results !== null && results.length === 0

  return (
    <div className="space-y-4">

      {/* Search input */}
      <div className="relative">
        <Search
          className="pointer-events-none absolute left-3.5 top-1/2 size-4.5 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <input
          ref={inputRef}
          type="search"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search by name, email, ticket or phone…"
          className="w-full rounded-xl border border-border bg-background py-3.5 pl-10 pr-10 text-[14px] text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-primary/30"
          autoComplete="off"
          spellCheck={false}
          aria-label="Search attendees"
        />
        {loading && (
          <Loader2
            className="absolute right-3.5 top-1/2 size-4 -translate-y-1/2 animate-spin text-muted-foreground"
            aria-hidden
          />
        )}
        {!loading && query && (
          <button
            type="button"
            onClick={clearQuery}
            className="absolute right-3.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            aria-label="Clear search"
          >
            <X className="size-4" aria-hidden />
          </button>
        )}
      </div>

      {/* Error */}
      {error && (
        <p className="text-center text-[13px] text-red-600">{error}</p>
      )}

      {/* Prompt — shown before typing */}
      {!hasQuery && !loading && (
        <div className="flex flex-col items-center gap-3 py-10 text-center">
          <UserSearch className="size-10 text-muted-foreground/20" aria-hidden />
          <p className="text-[13.5px] font-medium text-muted-foreground">
            Type at least 2 characters to search attendees
          </p>
          <p className="text-[12px] text-muted-foreground/70">
            Search by name, email, ticket code, or phone number
          </p>
        </div>
      )}

      {/* No results */}
      {showEmpty && (
        <div className="flex flex-col items-center gap-2 py-10 text-center">
          <p className="text-[13.5px] font-medium text-foreground">No attendees found</p>
          <p className="text-[12.5px] text-muted-foreground">
            Try a different name, email, ticket code, or phone number.
          </p>
        </div>
      )}

      {/* Results */}
      {results && results.length > 0 && (
        <div className="space-y-3">
          <p className="text-[12px] text-muted-foreground">
            {results.length} result{results.length !== 1 ? 's' : ''}
            {truncated && ` (showing first 50 — refine your search)`}
          </p>
          {results.map(reg => (
            <AttendeeCard
              key={reg.id}
              reg={reg}
              action={actions[reg.id]}
              onCheckIn={handleCheckIn}
            />
          ))}
        </div>
      )}
    </div>
  )
}
