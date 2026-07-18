'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { cn }                                        from '@/lib/utils/cn'
import {
  Search, X, Loader2, CheckCircle2, AlertCircle,
  XCircle, UserSearch, Clock, RotateCcw,
} from 'lucide-react'
import type { AttendeeSearchResult, AttendeeSearchResponse } from '@/app/api/organizer/events/[eventId]/checkin/search/route'
import type { CheckInResult }                                from '@/app/api/checkin/scan/route'
import type { CheckInUndoResult }                            from '@/app/api/checkin/undo/route'

// ─── Types ────────────────────────────────────────────────────────────────────

interface Props {
  eventId:     string
  token:       string
  onCheckedIn: () => void
  onUndid:     () => void
}

interface CheckInAction {
  loading: boolean
  result:  CheckInResult | null
}

interface UndoAction {
  loading: boolean
  result:  CheckInUndoResult | null
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

// ─── Error message maps ───────────────────────────────────────────────────────

const CHECKIN_ERROR: Record<string, string> = {
  TICKET_NOT_FOUND:             'Ticket not found.',
  REGISTRATION_CANCELLED:       'Registration is cancelled.',
  EVENT_NOT_ACCEPTING_CHECKINS: 'Event is not accepting check-ins.',
  UNAUTHORIZED:                 'Permission denied.',
  INVALID_TOKEN:                'Session expired. Refresh the page.',
  NETWORK_ERROR:                'Network error.',
}

const UNDO_ERROR: Record<string, string> = {
  TICKET_NOT_FOUND: 'Ticket not found.',
  NOT_CHECKED_IN:   'This attendee is not checked in.',
  UNAUTHORIZED:     'Permission denied.',
  INVALID_TOKEN:    'Session expired. Refresh the page.',
  NETWORK_ERROR:    'Network error.',
}

// ─── Attendee Card ────────────────────────────────────────────────────────────

function AttendeeCard({
  reg,
  checkInAction,
  undoAction,
  onCheckIn,
  onUndoCheckIn,
}: {
  reg:           AttendeeSearchResult
  checkInAction: CheckInAction | undefined
  undoAction:    UndoAction    | undefined
  onCheckIn:     (reg: AttendeeSearchResult) => void
  onUndoCheckIn: (reg: AttendeeSearchResult) => void
}) {
  const sm = statusMeta(reg.status)

  // Derive effective checked-in state from Firestore snapshot + local actions
  const checkedInByAction  = checkInAction?.result?.success && !checkInAction.result.alreadyCheckedIn
  const undoneByAction     = undoAction?.result?.success
  const isCheckedIn        = (reg.checkedIn || checkedInByAction) && !undoneByAction

  const checkedInTime =
    isCheckedIn && checkedInByAction && checkInAction?.result?.checkedInAt
      ? fmtTime(checkInAction.result.checkedInAt)
      : isCheckedIn && reg.checkedIn && reg.checkedInAt
        ? fmtTime(reg.checkedInAt)
        : null

  const canCheckIn = !isCheckedIn && reg.status !== 'cancelled'
  const canUndo    = isCheckedIn

  const isCheckingIn = !!checkInAction?.loading
  const isUndoing    = !!undoAction?.loading

  return (
    <div className="rounded-xl border border-border bg-card p-4">

      {/* Row 1: name + status badge */}
      <div className="flex items-start justify-between gap-3">
        <p className="text-[15px] font-bold leading-tight text-foreground">
          {reg.attendeeName}
        </p>

        <div className="flex shrink-0 flex-col items-end gap-1.5">
          {/* Checked-in badge */}
          {isCheckedIn && (
            <span className="flex items-center gap-1 rounded-full bg-emerald-100 px-2.5 py-1 text-[12px] font-semibold text-emerald-700">
              <CheckCircle2 className="size-3" aria-hidden />
              Checked In
            </span>
          )}
          {isCheckedIn && checkedInTime && (
            <span className="flex items-center gap-1 text-[13px] text-muted-foreground">
              <Clock className="size-2.5" aria-hidden />
              {checkedInTime}
            </span>
          )}

          {/* Already checked in via THIS action (edge case: QR scan raced with search) */}
          {!isCheckedIn && checkInAction?.result?.alreadyCheckedIn && (
            <span className="flex items-center gap-1 rounded-full bg-amber-100 px-2.5 py-1 text-[12px] font-semibold text-amber-700">
              <AlertCircle className="size-3" aria-hidden />
              Already In
            </span>
          )}

          {/* Check-in error badge */}
          {checkInAction?.result && !checkInAction.result.success && (
            <span className="flex items-center gap-1 rounded-full bg-red-100 px-2.5 py-1 text-[12px] font-semibold text-red-600">
              <XCircle className="size-3" aria-hidden />
              Failed
            </span>
          )}

          {/* Undo error badge */}
          {undoAction?.result && !undoAction.result.success && (
            <span className="flex items-center gap-1 rounded-full bg-red-100 px-2.5 py-1 text-[12px] font-semibold text-red-600">
              <XCircle className="size-3" aria-hidden />
              Undo Failed
            </span>
          )}
        </div>
      </div>

      {/* Row 2: email · phone */}
      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[13px] text-muted-foreground">
        <span className="truncate">{reg.attendeeEmail}</span>
        {reg.attendeePhone && <span>{reg.attendeePhone}</span>}
      </div>

      {/* Row 3: ticket code · pass · registration status */}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <span className="font-mono text-[12px] font-medium tracking-wide text-foreground">
          {reg.ticketCode}
        </span>
        <span className="text-muted-foreground/40">·</span>
        <span className="text-[13px] text-muted-foreground">{reg.passName}</span>
        <span className={cn('rounded-full px-2 py-0.5 text-[12px] font-semibold', sm.cls)}>
          {sm.label}
        </span>
      </div>

      {/* Row 4: action buttons */}
      <div className="mt-3 flex flex-wrap gap-2">
        {/* Check In */}
        {canCheckIn && !isCheckingIn && !checkInAction?.result && (
          <button
            type="button"
            onClick={() => onCheckIn(reg)}
            className="flex items-center gap-1.5 rounded-xl bg-primary px-4 py-2 text-[14px] font-semibold text-white transition-transform active:scale-95 hover:bg-[var(--primary-hover)]"
          >
            <CheckCircle2 className="size-3.5" aria-hidden />
            Check In
          </button>
        )}
        {canCheckIn && isCheckingIn && (
          <span className="flex items-center gap-1.5 rounded-xl bg-primary/10 px-4 py-2 text-[14px] font-semibold text-primary">
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
            Checking in…
          </span>
        )}

        {/* Undo Check-In */}
        {canUndo && !isUndoing && !undoAction?.result && (
          <button
            type="button"
            onClick={() => onUndoCheckIn(reg)}
            className="flex items-center gap-1.5 rounded-xl border border-border bg-background px-4 py-2 text-[14px] font-semibold text-muted-foreground transition-colors hover:border-red-300 hover:text-red-600"
          >
            <RotateCcw className="size-3.5" aria-hidden />
            Undo Check-In
          </button>
        )}
        {canUndo && isUndoing && (
          <span className="flex items-center gap-1.5 rounded-xl border border-border bg-background px-4 py-2 text-[14px] text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
            Undoing…
          </span>
        )}
      </div>

      {/* Inline error text */}
      {checkInAction?.result && !checkInAction.result.success && (
        <p className="mt-2 text-[13px] text-red-600">
          {CHECKIN_ERROR[checkInAction.result.error ?? ''] ?? checkInAction.result.error ?? 'Something went wrong.'}
        </p>
      )}
      {undoAction?.result && !undoAction.result.success && (
        <p className="mt-2 text-[13px] text-red-600">
          {UNDO_ERROR[undoAction.result.error ?? ''] ?? undoAction.result.error ?? 'Something went wrong.'}
        </p>
      )}
    </div>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function AttendeeSearch({ eventId, token, onCheckedIn, onUndid }: Props) {
  const [query,     setQuery]     = useState('')
  const [results,   setResults]   = useState<AttendeeSearchResult[] | null>(null)
  const [loading,   setLoading]   = useState(false)
  const [error,     setError]     = useState<string | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [scanMode,  setScanMode]  = useState<'exact' | 'scan'>('scan')

  const [checkInActions, setCheckInActions] = useState<Record<string, CheckInAction>>({})
  const [undoActions,    setUndoActions]    = useState<Record<string, UndoAction>>({})

  const inputRef = useRef<HTMLInputElement>(null)
  const abortRef = useRef<AbortController | null>(null)

  // Auto-focus on mount
  useEffect(() => { inputRef.current?.focus() }, [])

  // ── Debounced server search ───────────────────────────────────────────────

  const doSearch = useCallback(async (q: string, signal: AbortSignal) => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(
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
      setScanMode(data.searchMode)
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
    if (trimmed.length < 2) {
      setResults(null)
      setError(null)
      setTruncated(false)
      abortRef.current?.abort()
      return
    }

    const timer = setTimeout(() => {
      abortRef.current?.abort()
      const ctrl = new AbortController()
      abortRef.current = ctrl
      doSearch(trimmed, ctrl.signal)
    }, 300)

    return () => clearTimeout(timer)
  }, [query, doSearch])

  // ── Check-in ──────────────────────────────────────────────────────────────

  async function handleCheckIn(reg: AttendeeSearchResult) {
    setCheckInActions(prev => ({ ...prev, [reg.id]: { loading: true, result: null } }))
    try {
      const res  = await fetch('/api/checkin/scan', {
        method:  'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ ticketCode: reg.ticketCode }),
      })
      const data = await res.json() as CheckInResult
      setCheckInActions(prev => ({ ...prev, [reg.id]: { loading: false, result: data } }))
      if (data.success && !data.alreadyCheckedIn) onCheckedIn()
    } catch {
      setCheckInActions(prev => ({
        ...prev,
        [reg.id]: { loading: false, result: { success: false, error: 'NETWORK_ERROR' } },
      }))
    }
  }

  // ── Undo check-in ─────────────────────────────────────────────────────────

  async function handleUndoCheckIn(reg: AttendeeSearchResult) {
    setUndoActions(prev => ({ ...prev, [reg.id]: { loading: true, result: null } }))
    try {
      const res  = await fetch('/api/checkin/undo', {
        method:  'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ ticketCode: reg.ticketCode }),
      })
      const data = await res.json() as CheckInUndoResult
      setUndoActions(prev => ({ ...prev, [reg.id]: { loading: false, result: data } }))
      if (data.success) {
        // Also clear any prior check-in action for this card so "Check In" reappears
        setCheckInActions(prev => {
          const next = { ...prev }
          delete next[reg.id]
          return next
        })
        onUndid()
      }
    } catch {
      setUndoActions(prev => ({
        ...prev,
        [reg.id]: { loading: false, result: { success: false, error: 'NETWORK_ERROR' } },
      }))
    }
  }

  function clearQuery() {
    setQuery('')
    setResults(null)
    setError(null)
    setCheckInActions({})
    setUndoActions({})
    inputRef.current?.focus()
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  const hasQuery  = query.trim().length >= 2
  const showEmpty = hasQuery && !loading && results !== null && results.length === 0

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
          placeholder="Search by name, email, ticket code, or phone…"
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
          <p className="text-[13px] text-muted-foreground/70">
            Tip: start with <span className="font-mono font-semibold">RD-</span> for an instant ticket-code lookup
          </p>
        </div>
      )}

      {/* No results */}
      {showEmpty && (
        <div className="flex flex-col items-center gap-2 py-10 text-center">
          <p className="text-[13.5px] font-medium text-foreground">No attendees found</p>
          <p className="text-[13px] text-muted-foreground">
            Try a different name, email, ticket code, or phone number.
          </p>
        </div>
      )}

      {/* Results */}
      {results && results.length > 0 && (
        <div className="space-y-3">
          <p className="text-[13px] text-muted-foreground">
            {results.length} result{results.length !== 1 ? 's' : ''}
            {truncated && scanMode === 'scan' && (
              <> · <span className="text-amber-600">showing first 50 — use ticket code or email for exact results</span></>
            )}
          </p>
          {results.map(reg => (
            <AttendeeCard
              key={reg.id}
              reg={reg}
              checkInAction={checkInActions[reg.id]}
              undoAction={undoActions[reg.id]}
              onCheckIn={handleCheckIn}
              onUndoCheckIn={handleUndoCheckIn}
            />
          ))}
        </div>
      )}
    </div>
  )
}
