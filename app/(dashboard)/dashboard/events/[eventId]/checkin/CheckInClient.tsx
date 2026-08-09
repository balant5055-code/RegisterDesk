'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import dynamic                          from 'next/dynamic'
import { cn }                           from '@/lib/utils/cn'
import {
  Search, QrCode, CheckCircle2, XCircle, AlertCircle,
  Loader2, UserCheck, RotateCcw, KeyRound, UsersRound,
  Wifi, WifiOff, Database, RefreshCw, CloudUpload, UserPlus,
} from 'lucide-react'
import type { CheckInResult } from '@/app/api/checkin/scan/route'
import type { AttendanceDashboardResponse } from '@/app/api/organizer/events/[eventId]/attendance/route'
import { useOfflineCheckin }    from '@/lib/checkin/useOfflineCheckin'
import AttendeeSearch           from './AttendeeSearch'
import WalkInForm               from './WalkInForm'

// QrScanner is browser-only (camera API) — never SSR
const QrScanner = dynamic(() => import('./QrScanner'), { ssr: false })

// ─── Types ────────────────────────────────────────────────────────────────────

type Mode = 'qr' | 'manual' | 'search' | 'walkin'

/**
 * RD-CHECKIN-COUNTER-FIX-01 · how often the attendance summary is re-read.
 *
 * 30s is deliberately modest. It exists so a SECOND operator's check-ins appear without a
 * manual refresh — the reason the old Firestore listener was realtime — not to make this
 * device's own scans feel live; those refresh immediately on success.
 */
const ATTENDANCE_POLL_MS = 30_000

interface Props {
  eventId:   string
  eventName: string
  token:     string
  totalRegistrations: number
  checkedInCount:     number
  slug:               string
}

// ─── Result Card ──────────────────────────────────────────────────────────────

function ResultCard({ result }: { result: CheckInResult }) {
  if (!result.success) {
    const msg: Record<string, string> = {
      TICKET_NOT_FOUND:              'Ticket not found. Check the code and try again.',
      REGISTRATION_CANCELLED:        'This registration has been cancelled.',
      REGISTRATION_REFUNDED:         'This registration has been refunded and cannot be checked in.',
      REGISTRATION_PENDING:          'This registration is pending approval and cannot be checked in.',
      REGISTRATION_REJECTED:         'This registration was rejected and cannot be checked in.',
      EVENT_NOT_ACCEPTING_CHECKINS:  'This event is not currently accepting check-ins.',
      WRONG_EVENT:                   'This ticket belongs to a different event.',
      UNAUTHORIZED:                  'You do not have permission to check in for this event.',
      MISSING_TICKET_CODE:           'Please enter a ticket code.',
      INVALID_BODY:                  'Invalid request.',
      INVALID_TOKEN:                 'Session expired. Please refresh and try again.',
      NETWORK_ERROR:                 'Network error. Check your connection and try again.',
    }
    return (
      // RD-ORGANIZER-02 P1: announce the outcome to screen-reader operators (assertive for
      // failures incl. rejected/cancelled/pending/refunded — their message is in `msg`).
      <div role="alert" aria-live="assertive" className="flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 p-4">
        <XCircle className="mt-0.5 size-5 shrink-0 text-red-500" aria-hidden />
        <div>
          <p className="text-[13.5px] font-semibold text-red-700">Check-in Failed</p>
          <p className="mt-0.5 text-[13px] text-red-600">
            {msg[result.error ?? ''] ?? result.error ?? 'Something went wrong.'}
          </p>
        </div>
      </div>
    )
  }

  const checkedInTime = result.checkedInAt
    ? new Date(result.checkedInAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })
    : null

  if (result.alreadyCheckedIn) {
    return (
      <div role="status" aria-live="polite" className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4">
        <AlertCircle className="mt-0.5 size-5 shrink-0 text-amber-500" aria-hidden />
        <div>
          <p className="text-[13.5px] font-semibold text-amber-800">Already Checked In</p>
          <p className="mt-0.5 text-[13px] font-medium text-amber-900">{result.attendee?.name}</p>
          <p className="text-[13px] text-amber-700">{result.attendee?.passName}</p>
          {checkedInTime && (
            <p className="mt-1 text-[13px] text-amber-600">Checked in at {checkedInTime}</p>
          )}
        </div>
      </div>
    )
  }

  return (
    <div role="status" aria-live="polite" className="flex items-start gap-3 rounded-xl border border-emerald-200 bg-emerald-50 p-4">
      <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-emerald-500" aria-hidden />
      <div>
        <p className="text-[13.5px] font-semibold text-emerald-800">Check-in Successful!</p>
        <p className="mt-0.5 text-[14px] font-bold text-emerald-900">{result.attendee?.name}</p>
        <p className="text-[13px] text-emerald-700">{result.attendee?.passName}</p>
        {checkedInTime && (
          <p className="mt-1 text-[13px] text-emerald-600">Checked in at {checkedInTime}</p>
        )}
      </div>
    </div>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function CheckInClient({
  eventId,
  token,
  totalRegistrations,
  checkedInCount: initialCheckedIn,
  slug,
}: Props) {
  const [code,          setCode]          = useState('')
  const [loading,       setLoading]       = useState(false)
  const [result,        setResult]        = useState<CheckInResult | null>(null)
  const [liveCheckedIn, setLiveCheckedIn] = useState(initialCheckedIn)
  const [liveTotal,     setLiveTotal]     = useState(totalRegistrations)
  const [mode,          setMode]          = useState<Mode>('qr')
  const [scannerActive, setScannerActive] = useState(true)
  const [offlineQueued, setOfflineQueued] = useState(false)
  // RD-CHECKIN-COUNTER-FIX-01 · true once an attendance refresh has failed, so the numbers
  // on screen are labelled as possibly out of date rather than presented as current.
  const [countsStale,   setCountsStale]   = useState(false)

  const inputRef = useRef<HTMLInputElement>(null)

  // Offline check-in orchestration (cache, queue, sync).
  const offline = useOfflineCheckin({ eventSlug: slug, token })

  // Register the check-in service worker for offline shell + asset caching.
  useEffect(() => {
    if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => { /* SW optional */ })
    }
  }, [])

  // Focus manual input when switching to manual mode
  useEffect(() => {
    if (mode === 'manual') setTimeout(() => inputRef.current?.focus(), 80)
  }, [mode])

  // ═══ RD-CHECKIN-COUNTER-FIX-01 · authoritative attendance ═══════════════════
  //
  // This used to be `onSnapshot(doc(db, 'registrationCounters', slug))`. That was wrong
  // twice over:
  //
  //   1. `registrationCounters` is denied to the client SDK (firestore.rules), and the
  //      listener's only error path was a console.error — so it failed invisibly.
  //   2. Even permitted, it read the BASE document. Since GA-5 S3 every gate check-in
  //      increments a distributed shard (`registrationCounters/{slug}/attendanceShards/{k}`)
  //      and never the base, so `base.checkedInCount` does not move for any event published
  //      since. The counter would have been permitted and still frozen.
  //
  // The attendance endpoint folds those shards server-side (getEventStats →
  // getRegistrationCounter → foldAttendanceShards), is tenant-isolated and gated on the
  // existing `checkin` permission. It is the authoritative source, so the client reads it
  // instead of Firestore. The client now has NO direct Firestore access to counters.
  //
  // `confirmedRegistrations`, not `totalRegistrations`: the base counter's `totalCount`
  // (what this component displayed before, and what the server props still supply) counts
  // CONFIRMED registrations, and the endpoint's own `attendanceRate` uses the same base.
  // Picking the other field would make the number jump on the first refresh.
  const refreshAttendance = useCallback(async () => {
    // Offline: the API is unreachable by definition, and the optimistic local count plus
    // the offline queue are what the operator should see. Not an error state.
    if (!offline.online) return
    try {
      const res = await fetch(`/api/organizer/events/${eventId}/attendance`, {
        headers: { Authorization: `Bearer ${token}` },
        cache:   'no-store',
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json() as AttendanceDashboardResponse
      setLiveCheckedIn(data.checkedInCount)
      setLiveTotal(data.confirmedRegistrations)
      setCountsStale(false)
    } catch {
      // Never zero the numbers on failure — the last known values (server-rendered at
      // mount, then optimistic) stay on screen and are labelled as possibly out of date.
      setCountsStale(true)
    }
  }, [eventId, token, offline.online])

  // Other operators and other devices check people in at the same gate, which is what the
  // realtime listener existed for. A modest poll preserves that without a socket. No fetch
  // on mount: `totalRegistrations` / `checkedInCount` arrive as props from
  // GET /api/organizer/events/[eventId], which folds the same shards — already correct.
  useEffect(() => {
    if (!offline.online) return
    const id = window.setInterval(() => { void refreshAttendance() }, ATTENDANCE_POLL_MS)
    return () => window.clearInterval(id)
  }, [refreshAttendance, offline.online])

  const attendanceRate = liveTotal > 0
    ? Math.round((liveCheckedIn / liveTotal) * 100)
    : 0

  // ── Core submission (shared by both modes) ───────────────────────────────

  async function runOffline(ticketCode: string) {
    const data = await offline.scanOffline(ticketCode)
    setResult(data)
    setOfflineQueued(data.success && !data.alreadyCheckedIn)
    if (data.success && !data.alreadyCheckedIn) setLiveCheckedIn(n => n + 1)
  }

  async function submitCode(ticketCode: string) {
    setLoading(true)
    setResult(null)
    setOfflineQueued(false)

    // Offline: validate against the IndexedDB cache and queue for later sync.
    if (!offline.online) {
      try { await runOffline(ticketCode) }
      catch { setResult({ success: false, error: 'NETWORK_ERROR' }) }
      finally { setLoading(false) }
      return
    }

    // Online: live API. If the network drops mid-request, fall back to the queue.
    try {
      const res  = await fetch('/api/checkin/scan', {
        method:  'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ ticketCode, source: mode, eventSlug: slug }),
      })
      const data = await res.json() as CheckInResult
      setResult(data)
      if (data.success && !data.alreadyCheckedIn) {
        // Existing optimistic bump kept — it makes the gate feel instant. The refresh
        // immediately after replaces it with the server's shard-folded truth, so the
        // optimistic value is never what the operator ends up trusting.
        setLiveCheckedIn(n => n + 1)
        void refreshAttendance()
      }
    } catch {
      try { await runOffline(ticketCode) }
      catch { setResult({ success: false, error: 'NETWORK_ERROR' }) }
    } finally {
      setLoading(false)
    }
  }

  // ── Manual form submit ────────────────────────────────────────────────────

  function handleManualSubmit(e?: React.FormEvent) {
    e?.preventDefault()
    const trimmed = code.trim().toUpperCase()
    if (!trimmed) return
    submitCode(trimmed)
  }

  // ── QR code received from scanner ─────────────────────────────────────────
  // Pause scanner immediately to prevent duplicate scans while API is in flight

  function handleQrCode(raw: string) {
    setScannerActive(false)
    // Ticket QR format: RD:{eventSlug}:{registrationId}:{ticketCode}
    // Extract just the ticketCode; bare manual codes (RD-XXXXXXXX) pass through unchanged.
    const parts = raw.split(':')
    const ticketCode = parts.length === 4 && parts[0] === 'RD' ? parts[3] : raw
    submitCode(ticketCode.trim().toUpperCase())
  }

  // ── Reset for next attendee ────────────────────────────────────────────────

  function handleReset() {
    setCode('')
    setResult(null)
    if (mode === 'qr') {
      setScannerActive(true)
    } else {
      setTimeout(() => inputRef.current?.focus(), 80)
    }
  }

  // ── Switch mode ───────────────────────────────────────────────────────────

  function switchMode(next: Mode) {
    setMode(next)
    setResult(null)
    setCode('')
    // Scanner only active in QR mode and when no result is showing
    setScannerActive(next === 'qr')
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="space-y-5">

      {/* Offline status strip */}
      <div className={cn(
        'flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border p-3 text-[12.5px]',
        offline.online ? 'border-border bg-card' : 'border-amber-200 bg-amber-50',
      )}>
        <span className={cn('inline-flex items-center gap-1.5 font-semibold',
          offline.online ? 'text-emerald-600' : 'text-amber-700')}>
          {offline.online ? <Wifi className="size-4" aria-hidden /> : <WifiOff className="size-4" aria-hidden />}
          {offline.online ? 'Online' : 'Offline — scanning from cache'}
        </span>

        <span className="inline-flex items-center gap-1.5 text-muted-foreground">
          <Database className="size-3.5" aria-hidden /> {offline.cachedCount} cached
        </span>

        {offline.pendingCount > 0 && (
          <span className="inline-flex items-center gap-1.5 font-medium text-amber-700">
            <CloudUpload className="size-3.5" aria-hidden /> {offline.pendingCount} pending sync
          </span>
        )}

        {offline.conflictCount > 0 && (
          <span className="inline-flex items-center gap-1.5 font-medium text-red-600" role="alert">
            <AlertCircle className="size-3.5" aria-hidden /> {offline.conflictCount} conflict{offline.conflictCount > 1 ? 's' : ''}
          </span>
        )}

        <div className="ml-auto flex items-center gap-2">
          {offline.online && offline.pendingCount > 0 && (
            <button onClick={() => offline.syncNow()} disabled={offline.syncing}
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1 font-medium text-foreground hover:bg-muted disabled:opacity-60">
              {offline.syncing ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <CloudUpload className="size-3.5" aria-hidden />} Sync now
            </button>
          )}
          {offline.online && (
            <button onClick={() => offline.refreshCache()}
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1 font-medium text-muted-foreground hover:bg-muted"
              title="Refresh the offline attendee list">
              <RefreshCw className="size-3.5" aria-hidden /> Refresh list
            </button>
          )}
        </div>

        {offline.truncated && (
          <p className="w-full text-[11.5px] text-amber-700">
            Only the first 5,000 attendees are cached for offline use.
          </p>
        )}
        {offline.cacheError && (
          <p className="w-full text-[11.5px] text-red-600">{offline.cacheError}</p>
        )}
      </div>

      {/* Attendance metrics */}
      <div className="rounded-xl border border-border bg-card p-4">
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <UserCheck className="size-4 text-muted-foreground" aria-hidden />
            <span className="text-[13px] font-semibold text-foreground">Attendance</span>
          </div>
          <span className="text-[13px] font-bold text-foreground">
            {liveCheckedIn} / {liveTotal}
            <span className="ml-1.5 text-[12px] font-normal text-muted-foreground">
              ({attendanceRate}%)
            </span>
          </span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-muted">
          <div
            className={cn(
              'h-full rounded-full transition-all duration-500 motion-reduce:transition-none',
              attendanceRate >= 80
                ? 'bg-emerald-500'
                : attendanceRate >= 50 ? 'bg-primary' : 'bg-amber-500',
            )}
            style={{ width: `${attendanceRate}%` }}
          />
        </div>
        <div className="mt-2 flex gap-4 text-[13px] text-muted-foreground">
          <span>{liveTotal} registered</span>
          <span>{liveCheckedIn} checked in</span>
          <span>{liveTotal - liveCheckedIn} remaining</span>
        </div>

        {/* RD-CHECKIN-COUNTER-FIX-01 · honest degraded state.
            The numbers above are never zeroed on failure — they are the last known good
            values — so the failure mode is STALENESS, and that is what this says. The
            previous listener failed to console.error and told the operator nothing. */}
        {countsStale && offline.online && (
          <p role="status" className="mt-2 flex items-center gap-1.5 text-[11.5px] text-amber-700">
            <AlertCircle className="size-3.5 shrink-0" aria-hidden />
            Attendance count unavailable — showing the last known figures. Other operators&rsquo;
            check-ins may be missing.
          </p>
        )}
      </div>

      {/* Mode toggle */}
      <div className="grid grid-cols-4 gap-1 rounded-xl border border-border bg-muted/30 p-1">
        {(
          [
            { key: 'qr',     icon: QrCode,       label: 'Scan QR'  },
            { key: 'manual', icon: KeyRound,      label: 'Manual'   },
            { key: 'search', icon: UsersRound,    label: 'Lookup'   },
            { key: 'walkin', icon: UserPlus,      label: 'Walk-In'  },
          ] as const
        ).map(({ key, icon: Icon, label }) => (
          <button
            key={key}
            type="button"
            onClick={() => switchMode(key)}
            className={cn(
              'flex items-center justify-center gap-1.5 rounded-lg py-3 text-[14px] font-semibold transition-colors',
              mode === key
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
            aria-pressed={mode === key}
          >
            <Icon className="size-3.5 shrink-0" aria-hidden />
            <span className="hidden sm:inline">{label}</span>
            <span className="sm:hidden">{label.split(' ')[0]}</span>
          </button>
        ))}
      </div>

      {/* ── QR Scanner panel ── */}
      {mode === 'qr' && !result && (
        <div className="overflow-hidden rounded-xl border border-border bg-card p-4">
          {loading ? (
            <div className="flex flex-col items-center justify-center gap-3 py-20">
              <Loader2 className="size-9 animate-spin text-primary motion-reduce:animate-none" aria-hidden />
              <p className="text-[13px] font-medium text-muted-foreground">Processing scan…</p>
            </div>
          ) : (
            <QrScanner active={scannerActive} onCode={handleQrCode} />
          )}
        </div>
      )}

      {/* ── Manual entry panel ── */}
      {mode === 'manual' && !result && (
        <div className="rounded-xl border border-border bg-card p-4">
          <form onSubmit={handleManualSubmit} className="flex gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <input
                ref={inputRef}
                type="text"
                value={code}
                onChange={e => setCode(e.target.value.toUpperCase())}
                placeholder="RD-XXXXXXXX"
                className="w-full rounded-xl border border-border bg-background py-3 pl-10 pr-4 font-mono text-[15px] uppercase tracking-widest text-foreground placeholder:normal-case placeholder:tracking-normal placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
                autoComplete="off"
                spellCheck={false}
                disabled={loading}
                aria-label="Ticket code"
              />
            </div>
            <button
              type="submit"
              disabled={loading || !code.trim()}
              className="flex items-center gap-2 rounded-xl bg-primary px-5 py-3 text-[14px] font-semibold text-white disabled:opacity-50 hover:bg-[var(--primary-hover)]"
            >
              {loading
                ? <Loader2 className="size-4 animate-spin" aria-hidden />
                : <CheckCircle2 className="size-4" aria-hidden />
              }
              Check In
            </button>
          </form>
          <p className="mt-3 text-center text-[13px] text-muted-foreground">
            Type the attendee&apos;s ticket code and press Check In.
          </p>
        </div>
      )}

      {/* ── Attendee lookup panel ── */}
      {mode === 'search' && (
        <div className="rounded-xl border border-border bg-card p-4">
          <AttendeeSearch
            eventId={eventId}
            token={token}
            onCheckedIn={() => { setLiveCheckedIn(n => n + 1); void refreshAttendance() }}
            onUndid={() => { setLiveCheckedIn(n => Math.max(0, n - 1)); void refreshAttendance() }}
          />
        </div>
      )}

      {/* ── Walk-In registration panel ── */}
      {mode === 'walkin' && (
        <WalkInForm
          slug={slug}
          token={token}
          onRegistered={() => { setLiveCheckedIn(n => n + 1); void refreshAttendance() }}
        />
      )}

      {/* ── Result card + reset ── */}
      {result && (
        <div className="space-y-3">
          <ResultCard result={result} />
          {offlineQueued && (
            <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12.5px] text-amber-700" role="status">
              <CloudUpload className="size-4 shrink-0" aria-hidden />
              Queued offline — this check-in will sync automatically when you&apos;re back online.
            </div>
          )}
          <button
            type="button"
            onClick={handleReset}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-3.5 text-[14px] font-semibold text-white hover:bg-[var(--primary-hover)]"
          >
            <RotateCcw className="size-4" aria-hidden />
            {mode === 'qr' ? 'Scan Next Ticket' : 'Enter Next Ticket'}
          </button>
        </div>
      )}
    </div>
  )
}
