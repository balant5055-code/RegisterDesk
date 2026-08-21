'use client'

// RD-CHECKIN-STAFF-01 — the event-day gate console.
//
// ═══ WHAT THIS SURFACE DELIBERATELY DOES NOT HAVE ════════════════════════════
// No sidebar, no breadcrumbs, no command palette, no organizer links, no undo, no
// walk-in, no export, no attendee record beyond the name and pass needed to admit
// someone at a gate. A gate operator is handed one job and the controls for it.
//
// ═══ THE UI IS NOT THE CONTROL ═══════════════════════════════════════════════
// `canUndo` / `canWalkIn` arrive from the server and decide only what is DRAWN.
// The undo and walk-in routes independently require the `registrations`
// permission, which a gate-only role does not hold, so editing this state in a
// browser changes the pixels and nothing else.
//
// Everything here goes through the SAME endpoints the dashboard check-in uses —
// this is a different door onto one implementation, not a second implementation.

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { CheckCircle2, XCircle, AlertCircle, Loader2, ScanLine, Keyboard, Search } from 'lucide-react'
import { useAuth } from '@/components/auth/AuthProvider'
import { ticketCodeFromQr } from '@/lib/checkin/qr'
import { cn } from '@/lib/utils/cn'
import QrScanner from '@/app/(dashboard)/dashboard/events/[eventId]/checkin/QrScanner'
import IdentifierPrompt from '@/components/checkin/IdentifierPrompt'
import type { OpsCheckinContext } from '@/app/api/checkin/ops/[eventId]/route'
import type { CheckInResult } from '@/app/api/checkin/scan/route'
import type { AttendeeSearchResult } from '@/app/api/organizer/events/[eventId]/checkin/search/route'

type Mode = 'scan' | 'manual' | 'lookup'

// ─── Connectivity ─────────────────────────────────────────────────────────────
// useSyncExternalStore rather than useState+useEffect: the browser's online flag is
// an external store, and subscribing to it directly avoids both the cascading
// render an effect-write would cause and the hydration mismatch that reading
// `navigator` during SSR would cause (the server snapshot is simply "online").

const subscribeOnline = (cb: () => void) => {
  window.addEventListener('online', cb)
  window.addEventListener('offline', cb)
  return () => {
    window.removeEventListener('online', cb)
    window.removeEventListener('offline', cb)
  }
}

function useOnlineStatus(): boolean {
  return useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine,
    () => true,          // server snapshot — no navigator during SSR
  )
}

interface Outcome {
  kind:    'success' | 'already' | 'error'
  title:   string
  detail?: string
}

/** Gate-facing wording for the server's error codes. Anything unmapped falls back
 *  to the server's own message rather than inventing one. */
const ERROR_COPY: Record<string, string> = {
  TICKET_NOT_FOUND:              'Ticket not found.',
  WRONG_EVENT:                   'This ticket is for a different event.',
  EVENT_NOT_ASSIGNED:            'You are not assigned to this event.',
  REGISTRATION_CANCELLED:        'This registration was cancelled.',
  REGISTRATION_PENDING:          'This registration is not confirmed yet.',
  REGISTRATION_REJECTED:         'This registration was rejected.',
  REGISTRATION_REFUNDED:         'This registration was refunded.',
  EVENT_NOT_ACCEPTING_CHECKINS:  'This event is not accepting check-ins.',
  UNAUTHORIZED:                  'You cannot check in this ticket.',
}

/** Identifier-engine rejection codes in gate language. Unmapped codes fall through
 *  to the server's own string rather than being hidden behind a generic message. */
const IDENTIFIER_ERROR_COPY: Record<string, string> = {
  VALUE_CONFLICT:           'Already assigned to another participant.',
  MANUAL_OVERRIDE_DISABLED: 'Manual entry is disabled for this event.',
  OUT_OF_RANGE:             'Outside the allowed range for this event.',
  POOL_EXHAUSTED:           'No numbers remain in this pool.',
  POOL_NOT_FOUND:           'The configured pool no longer exists.',
  REGISTRATION_TERMINAL:    'This registration is cancelled or rejected.',
  REGISTRATION_NOT_FOUND:   'Registration not found.',
  CONFIG_DISABLED:          'Identifiers are disabled for this event.',
  IDENTIFIER_ASSIGN_FAILED: 'Could not assign. Please try again.',
}

// The search endpoint's own result type — imported rather than restated so a change
// to what lookup returns cannot silently drift away from what the gate renders.
type SearchRow = AttendeeSearchResult

/** The in-flight identifier request: which ticket it belongs to, and what to show. */
interface Prompt {
  ticketCode:    string
  label:         string
  attendeeName?: string
  error:         string
}

export default function OpsCheckinClient({ eventId }: { eventId: string }) {
  const { user, getToken } = useAuth()

  const [ctx,      setCtx]      = useState<OpsCheckinContext | null>(null)
  const [loadErr,  setLoadErr]  = useState<string | null>(null)
  const [mode,     setMode]     = useState<Mode>('scan')
  const [busy,     setBusy]     = useState(false)
  const [outcome,  setOutcome]  = useState<Outcome | null>(null)
  const [prompt,   setPrompt]   = useState<Prompt | null>(null)

  // Signed-out is DERIVED, not stored. Mirroring auth into state would mean writing
  // it from an effect, which cascades a second render on every auth transition —
  // and on a gate console the first paint is the one that matters.
  const bootErr = user === null ? 'Please sign in to continue.' : loadErr

  const online = useOnlineStatus()

  const [manualCode, setManualCode] = useState('')
  const [query,      setQuery]      = useState('')
  const [results,    setResults]    = useState<SearchRow[]>([])

  const manualRef = useRef<HTMLInputElement>(null)

  // ── Bootstrap: this call IS the page's gate ───────────────────────────────
  //
  // The request lives INSIDE the effect, with a cancellation flag. Two reasons:
  // no state is written synchronously during the effect (which would cascade a
  // second render), and a response that arrives after the operator has navigated
  // to another event can no longer overwrite the newer context.
  useEffect(() => {
    // `undefined` = auth still resolving, `null` = signed out — the latter is
    // handled by the derived bootErr above, so neither should fire a request.
    if (!user) return

    let active = true
    void (async () => {
      const token = await getToken()
      if (!active) return
      if (!token) { setLoadErr('Please sign in to continue.'); return }

      try {
        const res = await fetch(`/api/checkin/ops/${encodeURIComponent(eventId)}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (!active) return

        if (!res.ok) {
          const body = await res.json().catch(() => null) as { error?: string } | null
          if (active) setLoadErr(body?.error ?? 'You do not have access to this event.')
          return
        }

        const data = await res.json() as OpsCheckinContext
        if (!active) return
        setCtx(data)
        setLoadErr(null)
      } catch {
        if (active) setLoadErr('Could not reach the server. Check your connection.')
      }
    })()

    return () => { active = false }
  }, [user, eventId, getToken])

  // ── Check in one ticket code ──────────────────────────────────────────────
  //
  // ONE function for QR, Manual and Lookup — they differ only in where the ticket
  // code came from. The identifier round-trip is part of this function rather than
  // each caller, which is what keeps the three flows identical.
  const submitCode = useCallback(async (rawCode: string, identifierValue?: string) => {
    const ticketCode = ticketCodeFromQr(rawCode)
    if (!ticketCode || !ctx) return

    setBusy(true)
    if (!identifierValue) setOutcome(null)
    try {
      const token = await getToken()
      const res = await fetch('/api/checkin/scan', {
        method:  'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        // eventSlug pins the scan to THIS gate. The server also derives the
        // operator's own event assignment independently, so this is a convenience
        // check rather than the control.
        body:    JSON.stringify({
          ticketCode, source: mode, eventSlug: ctx.eventSlug,
          ...(identifierValue ? { identifierValue } : {}),
        }),
      })
      const data = await res.json() as CheckInResult

      // ── The attendee has no identifier yet ────────────────────────────────
      // Nothing has been written: the server stops before the check-in
      // transaction. Hold the ticket code so Confirm retries the SAME attendee.
      if (data.requiresIdentifier) {
        setPrompt({
          ticketCode,
          label:        data.identifierLabel ?? 'Identifier',
          attendeeName: data.attendee?.name,
          // On the first ask there is no error; on a rejected value the server's
          // own code is shown so the operator knows which rule they hit.
          error:        identifierValue ? (IDENTIFIER_ERROR_COPY[data.error ?? ''] ?? data.error ?? 'Not accepted.') : '',
        })
        return
      }

      setPrompt(null)

      if (!res.ok || !data.success) {
        const code = data.error ?? ''
        setOutcome({ kind: 'error', title: ERROR_COPY[code] ?? code ?? 'Check-in failed.' })
        return
      }

      if (data.alreadyCheckedIn) {
        setOutcome({
          kind:   'already',
          title:  data.attendee?.name ?? 'Attendee',
          detail: 'Already checked in',
        })
        return
      }

      setOutcome({
        kind:   'success',
        title:  data.attendee?.name ?? 'Attendee',
        // When a value was just assigned, show it — the operator needs to see the
        // number that actually stuck, not the one they think they typed.
        detail: data.identifierValue
          ? `${data.identifierValue} · ${data.attendee?.passName ?? ''}`.trim().replace(/ ·\s*$/, '')
          : data.attendee?.passName,
      })
      // Optimistic header bump; the next bootstrap refresh reconciles with counters.
      setCtx(c => (c ? { ...c, checkedIn: c.checkedIn + 1 } : c))
    } catch {
      setOutcome({ kind: 'error', title: 'Network error. Check your connection and retry.' })
    } finally {
      setBusy(false)
      setManualCode('')
      manualRef.current?.focus()
    }
  }, [ctx, getToken, mode])

  // ── Lookup ────────────────────────────────────────────────────────────────
  const runSearch = useCallback(async () => {
    if (!query.trim() || !ctx) return
    setBusy(true)
    try {
      const token = await getToken()
      const res = await fetch(
        `/api/organizer/events/${encodeURIComponent(eventId)}/checkin/search?q=${encodeURIComponent(query.trim())}`,
        { headers: { Authorization: `Bearer ${token}` } },
      )
      if (!res.ok) { setResults([]); return }
      const data = await res.json() as { results?: SearchRow[] }
      setResults(data.results ?? [])
    } catch {
      setResults([])
    } finally {
      setBusy(false)
    }
  }, [ctx, eventId, getToken, query])

  // ── Render ────────────────────────────────────────────────────────────────

  if (bootErr) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-3 px-6 text-center">
        <AlertCircle className="h-10 w-10 text-destructive" aria-hidden />
        <h1 className="text-fs-lg font-semibold">Check-in unavailable</h1>
        <p className="text-fs-sm text-muted-foreground">{bootErr}</p>
      </main>
    )
  }

  if (!ctx) {
    return (
      <main className="flex min-h-dvh items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-hidden />
        <span className="sr-only">Loading check-in</span>
      </main>
    )
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col px-4 pb-8 pt-6">
      {/* ── Header: identity, event, connectivity, attendance ───────────── */}
      <header className="mb-5">
        <p className="text-fs-2xs font-semibold uppercase tracking-wider text-muted-foreground">
          RegisterDesk
        </p>
        <h1 className="mt-0.5 text-fs-xl font-bold leading-snug">{ctx.eventName}</h1>

        <div className="mt-3 flex items-center justify-between rounded-2xl border border-border bg-card px-4 py-3">
          <div>
            <p className="text-fs-2xs uppercase tracking-wider text-muted-foreground">Attendance</p>
            <p className="text-fs-lg font-bold tabular-nums">
              {ctx.checkedIn} <span className="text-muted-foreground">/ {ctx.totalExpected}</span>
            </p>
          </div>
          <span
            className={cn(
              'rounded-full px-2.5 py-1 text-fs-2xs font-semibold',
              online ? 'bg-success/10 text-success' : 'bg-warning/10 text-warning',
            )}
          >
            {online ? 'Online' : 'Offline'}
          </span>
        </div>
      </header>

      {/* ── Mode switch ──────────────────────────────────────────────────── */}
      <div role="tablist" aria-label="Check-in method" className="mb-4 grid grid-cols-3 gap-2">
        {([
          { id: 'scan',   label: 'Scan QR', Icon: ScanLine },
          { id: 'manual', label: 'Manual',  Icon: Keyboard },
          { id: 'lookup', label: 'Lookup',  Icon: Search },
        ] as const).map(({ id, label, Icon }) => (
          <button
            key={id}
            role="tab"
            aria-selected={mode === id}
            onClick={() => { setMode(id); setOutcome(null) }}
            className={cn(
              'flex flex-col items-center gap-1 rounded-xl border px-2 py-3 text-fs-2xs font-semibold transition-colors',
              mode === id
                ? 'border-primary bg-primary/10 text-primary'
                : 'border-border bg-card text-muted-foreground hover:text-foreground',
            )}
          >
            <Icon className="h-5 w-5" aria-hidden />
            {label}
          </button>
        ))}
      </div>

      {/* ── Active mode ──────────────────────────────────────────────────── */}
      {mode === 'scan' && (
        <QrScanner active={!busy} onCode={submitCode} />
      )}

      {mode === 'manual' && (
        <form
          onSubmit={e => { e.preventDefault(); void submitCode(manualCode) }}
          className="flex flex-col gap-3"
        >
          <label htmlFor="ops-ticket" className="text-fs-sm font-medium">Ticket code</label>
          <input
            id="ops-ticket"
            ref={manualRef}
            value={manualCode}
            onChange={e => setManualCode(e.target.value)}
            autoFocus
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
            placeholder="RD-XXXXXXXX"
            className="rounded-xl border border-border bg-card px-4 py-3 text-fs-md font-mono uppercase tracking-wider outline-none focus:border-primary"
          />
          <button
            type="submit"
            disabled={busy || !manualCode.trim()}
            className="rounded-xl bg-primary px-4 py-3 text-fs-md font-semibold text-primary-foreground disabled:opacity-50"
          >
            {busy ? 'Checking in…' : 'Check In'}
          </button>
        </form>
      )}

      {mode === 'lookup' && (
        <div className="flex flex-col gap-3">
          <form onSubmit={e => { e.preventDefault(); void runSearch() }} className="flex gap-2">
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Name, email or phone"
              aria-label="Search attendees"
              className="flex-1 rounded-xl border border-border bg-card px-4 py-3 text-fs-sm outline-none focus:border-primary"
            />
            <button
              type="submit"
              disabled={busy || !query.trim()}
              className="rounded-xl bg-primary px-4 py-3 text-fs-sm font-semibold text-primary-foreground disabled:opacity-50"
            >
              Find
            </button>
          </form>

          <ul className="flex flex-col gap-2">
            {results.map(r => (
              <li
                key={r.id}
                className="flex items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-fs-sm font-semibold">{r.attendeeName}</p>
                  <p className="truncate text-fs-2xs text-muted-foreground">{r.passName}</p>
                </div>
                {/* Check In only. Undo is intentionally absent for gate-only roles —
                    and the undo route requires `registrations` regardless. */}
                {r.checkedIn ? (
                  <span className="shrink-0 text-fs-2xs font-semibold text-success">Checked in</span>
                ) : (
                  <button
                    onClick={() => void submitCode(r.ticketCode)}
                    disabled={busy}
                    className="shrink-0 rounded-lg bg-primary px-3 py-2 text-fs-2xs font-semibold text-primary-foreground disabled:opacity-50"
                  >
                    Check In
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ── Identifier prompt ────────────────────────────────────────────────
          Blocking: until it is satisfied or cancelled, the attendee is not
          checked in. Confirm retries the SAME ticket code with the value. */}
      {prompt && (
        <IdentifierPrompt
          label={prompt.label}
          attendeeName={prompt.attendeeName}
          error={prompt.error}
          busy={busy}
          onSubmit={value => void submitCode(prompt.ticketCode, value)}
          onCancel={() => {
            setPrompt(null)
            setOutcome({ kind: 'error', title: `${prompt.label} required — not checked in.` })
          }}
        />
      )}

      {/* ── Result ───────────────────────────────────────────────────────── */}
      {outcome && (
        <div
          role="status"
          aria-live="polite"
          className={cn(
            'mt-5 flex items-start gap-3 rounded-2xl border px-4 py-4',
            outcome.kind === 'success' && 'border-success/30 bg-success/10',
            outcome.kind === 'already' && 'border-warning/30 bg-warning/10',
            outcome.kind === 'error'   && 'border-destructive/30 bg-destructive/10',
          )}
        >
          {outcome.kind === 'success' && <CheckCircle2 className="h-6 w-6 shrink-0 text-success" aria-hidden />}
          {outcome.kind === 'already' && <AlertCircle  className="h-6 w-6 shrink-0 text-warning" aria-hidden />}
          {outcome.kind === 'error'   && <XCircle      className="h-6 w-6 shrink-0 text-destructive" aria-hidden />}
          <div className="min-w-0">
            <p className="text-fs-md font-semibold leading-snug">{outcome.title}</p>
            {outcome.detail && <p className="text-fs-sm text-muted-foreground">{outcome.detail}</p>}
          </div>
        </div>
      )}
    </main>
  )
}
