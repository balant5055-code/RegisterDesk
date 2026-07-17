'use client'

import { useState, useRef, useEffect } from 'react'
import dynamic                          from 'next/dynamic'
import { onSnapshot, doc }              from 'firebase/firestore'
import { db }                           from '@/lib/firebase/firestore/index'
import { cn }                           from '@/lib/utils/cn'
import {
  Search, QrCode, CheckCircle2, XCircle, AlertCircle,
  Loader2, UserCheck, RotateCcw, KeyRound, UsersRound,
  Wifi, WifiOff, Database, RefreshCw, CloudUpload, UserPlus,
} from 'lucide-react'
import type { CheckInResult } from '@/app/api/checkin/scan/route'
import { useOfflineCheckin }    from '@/lib/checkin/useOfflineCheckin'
import AttendeeSearch           from './AttendeeSearch'
import WalkInForm               from './WalkInForm'

// QrScanner is browser-only (camera API) — never SSR
const QrScanner = dynamic(() => import('./QrScanner'), { ssr: false })

// ─── Types ────────────────────────────────────────────────────────────────────

type Mode = 'qr' | 'manual' | 'search' | 'walkin'

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
      EVENT_NOT_ACCEPTING_CHECKINS:  'This event is not currently accepting check-ins.',
      UNAUTHORIZED:                  'You do not have permission to check in for this event.',
      MISSING_TICKET_CODE:           'Please enter a ticket code.',
      INVALID_BODY:                  'Invalid request.',
      INVALID_TOKEN:                 'Session expired. Please refresh and try again.',
      NETWORK_ERROR:                 'Network error. Check your connection and try again.',
    }
    return (
      <div className="flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 p-4">
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
      <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4">
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
    <div className="flex items-start gap-3 rounded-xl border border-emerald-200 bg-emerald-50 p-4">
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

  // Real-time attendance counter from Firestore
  useEffect(() => {
    if (!slug) return
    return onSnapshot(
      doc(db, 'registrationCounters', slug),
      snap => {
        if (!snap.exists()) return
        const d = snap.data()
        if (typeof d.checkedInCount === 'number') setLiveCheckedIn(d.checkedInCount)
        if (typeof d.totalCount     === 'number') setLiveTotal(d.totalCount)
      },
      err => console.error('[checkin] counter listener error:', err),
    )
  }, [slug])

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
        body:    JSON.stringify({ ticketCode, source: mode }),
      })
      const data = await res.json() as CheckInResult
      setResult(data)
      if (data.success && !data.alreadyCheckedIn) setLiveCheckedIn(n => n + 1)
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
              'h-full rounded-full transition-all duration-500',
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
              <Loader2 className="size-9 animate-spin text-primary" aria-hidden />
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
              className="flex items-center gap-2 rounded-xl bg-primary px-5 py-3 text-[14px] font-semibold text-white disabled:opacity-50 hover:bg-[#bf1868]"
            >
              {loading
                ? <Loader2 className="size-4 animate-spin" aria-hidden />
                : <CheckCircle2 className="size-4" aria-hidden />
              }
              Check In
            </button>
          </form>
          <p className="mt-3 text-center text-[13px] text-muted-foreground">
            Type the attendee's ticket code and press Check In.
          </p>
        </div>
      )}

      {/* ── Attendee lookup panel ── */}
      {mode === 'search' && (
        <div className="rounded-xl border border-border bg-card p-4">
          <AttendeeSearch
            eventId={eventId}
            token={token}
            onCheckedIn={() => setLiveCheckedIn(n => n + 1)}
            onUndid={() => setLiveCheckedIn(n => Math.max(0, n - 1))}
          />
        </div>
      )}

      {/* ── Walk-In registration panel ── */}
      {mode === 'walkin' && (
        <WalkInForm slug={slug} token={token} onRegistered={() => setLiveCheckedIn(n => n + 1)} />
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
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-3.5 text-[14px] font-semibold text-white hover:bg-[#bf1868]"
          >
            <RotateCcw className="size-4" aria-hidden />
            {mode === 'qr' ? 'Scan Next Ticket' : 'Enter Next Ticket'}
          </button>
        </div>
      )}
    </div>
  )
}
