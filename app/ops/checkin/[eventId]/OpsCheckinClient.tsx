'use client'

// RD-CHECKIN-STAFF-01 — the event-day gate console.
//
// ═══ WHAT THIS SURFACE DELIBERATELY DOES NOT HAVE ════════════════════════════
// No sidebar, no breadcrumbs, no command palette, no organizer links, no walk-in,
// no export, no attendee record beyond what is needed to admit someone at a gate.
// A gate operator is handed one job and the controls for it.
//
// ═══ THE UI IS NOT THE CONTROL ═══════════════════════════════════════════════
// `canUndo` / `canWalkIn` arrive from the server and decide only what is DRAWN.
// The BROAD undo (/api/checkin/undo) and walk-in routes independently require the
// `registrations` permission, which a gate-only role does not hold, so editing
// this state in a browser changes the pixels and nothing else.
//
// ═══ THE TWO CORRECTIONS (RD-CHECKIN-FIX-01) ═════════════════════════════════
// An operator can fix their own two mistakes without gaining that permission:
// re-typing an identifier they mistyped, and reversing a check-in they just made.
// Both go to /api/checkin/correct, which is gated on `checkin` + event assignment
// and — for the undo — on it being THEIR check-in, inside a short window. That is
// strictly narrower than the `registrations` route, which is untouched.
//
// Everything here goes through the SAME endpoints the dashboard check-in uses —
// this is a different door onto one implementation, not a second implementation.

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { CheckCircle2, XCircle, AlertCircle, Loader2, ScanLine, Keyboard, Search, RotateCcw } from 'lucide-react'
import { useAuth } from '@/components/auth/AuthProvider'
import { ticketCodeFromQr } from '@/lib/checkin/qr'
import { cn } from '@/lib/utils/cn'
import QrScanner from '@/app/(dashboard)/dashboard/events/[eventId]/checkin/QrScanner'
import IdentifierPrompt from '@/components/checkin/IdentifierPrompt'
import AttendeeConfirmation from '@/components/checkin/AttendeeConfirmation'
import type { OpsCheckinContext } from '@/app/api/checkin/ops/[eventId]/route'
import type { CheckInResult } from '@/app/api/checkin/scan/route'
import type { CheckInCorrectResult } from '@/app/api/checkin/correct/route'
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
  /** RD-CHECKIN-FIX-01 — true when this is correcting an existing value rather
   *  than assigning a first one. Decides which endpoint Confirm submits to. */
  correcting?:   boolean
}

/** Correction-endpoint codes in gate language. */
const CORRECT_ERROR_COPY: Record<string, string> = {
  NOT_YOUR_CHECKIN:        'You can only undo a check-in you performed.',
  UNDO_WINDOW_EXPIRED:     'Too long ago to undo here — ask an organizer.',
  NOT_CHECKED_IN:          'This attendee is not checked in.',
  EVENT_NOT_ASSIGNED:      'You are not assigned to this event.',
  NO_IDENTIFIER_TO_CORRECT:'Nothing to correct yet.',
  VALUE_CONFLICT:          'Already assigned to another participant.',
  UNAUTHORIZED:            'You cannot correct this ticket.',
  TICKET_NOT_FOUND:        'Ticket not found.',
}

export default function OpsCheckinClient({ eventId }: { eventId: string }) {
  const { user, getToken } = useAuth()

  const [ctx,      setCtx]      = useState<OpsCheckinContext | null>(null)
  const [loadErr,  setLoadErr]  = useState<string | null>(null)
  const [mode,     setMode]     = useState<Mode>('scan')
  const [busy,     setBusy]     = useState(false)
  const [outcome,  setOutcome]  = useState<Outcome | null>(null)
  const [prompt,   setPrompt]   = useState<Prompt | null>(null)
  // RD-CHECKIN-CONFIRM-01 — the attendee awaiting the operator's confirmation.
  // QR, Manual and Lookup all land here first; nothing is checked in until Confirm.
  const [confirm,  setConfirm]  = useState<AttendeeSearchResult | null>(null)
  // RD-CHECKIN-FIX-01 — the ticket this operator most recently admitted, so the
  // success card can offer a same-session undo. Cleared once undone or superseded.
  const [lastCheckIn, setLastCheckIn] = useState<string | null>(null)

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

  // ── Step 1: resolve the attendee, WITHOUT checking anyone in ──────────────
  //
  // ONE resolver for QR, Manual and Lookup — they differ only in where the ticket
  // code came from. It reuses the event-scoped search endpoint's exact ticket-code
  // path, which the server already authorizes with the same `checkin` permission
  // and the same event assignment. No check-in happens here, so an operator who
  // scanned the wrong person can simply cancel.
  const resolveAttendee = useCallback(async (rawCode: string) => {
    const ticketCode = ticketCodeFromQr(rawCode)
    if (!ticketCode || !ctx) return

    setBusy(true)
    setOutcome(null)
    try {
      const token = await getToken()
      const res = await fetch(
        `/api/organizer/events/${encodeURIComponent(eventId)}/checkin/search?q=${encodeURIComponent(ticketCode)}`,
        { headers: { Authorization: `Bearer ${token}` } },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: string } | null
        setOutcome({ kind: 'error', title: body?.error ?? 'Could not look up this ticket.' })
        return
      }
      const data = await res.json() as { results?: AttendeeSearchResult[] }
      const found = data.results?.[0]
      // An empty result is the server's uniform answer for "not this event's ticket"
      // as well as "no such ticket" — it deliberately does not distinguish them.
      if (!found) {
        setOutcome({ kind: 'error', title: ERROR_COPY.TICKET_NOT_FOUND })
        return
      }
      setConfirm(found)
    } catch {
      setOutcome({ kind: 'error', title: 'Network error. Check your connection and retry.' })
    } finally {
      setBusy(false)
      setManualCode('')
    }
  }, [ctx, eventId, getToken])

  // ── Corrections (RD-CHECKIN-FIX-01) ───────────────────────────────────────
  //
  // One narrow endpoint for both. It re-authorizes independently — `checkin`,
  // event assignment, own-check-in and the undo window are all decided server-side
  // — so these handlers only carry the operator's intent.
  const correct = useCallback(async (
    ticketCode: string,
    action: 'identifier' | 'undo',
    identifierValue?: string,
  ): Promise<CheckInCorrectResult | null> => {
    setBusy(true)
    try {
      const token = await getToken()
      const res = await fetch('/api/checkin/correct', {
        method:  'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ ticketCode, action, ...(identifierValue ? { identifierValue } : {}) }),
      })
      return await res.json() as CheckInCorrectResult
    } catch {
      return null
    } finally {
      setBusy(false)
    }
  }, [getToken])

  /** Undo a check-in this operator just performed. */
  const undoLast = useCallback(async (ticketCode: string) => {
    const data = await correct(ticketCode, 'undo')
    if (!data) { setOutcome({ kind: 'error', title: 'Network error. Check your connection and retry.' }); return }
    if (!data.success) {
      setOutcome({ kind: 'error', title: CORRECT_ERROR_COPY[data.error ?? ''] ?? data.error ?? 'Could not undo.' })
      return
    }
    setLastCheckIn(null)
    setOutcome({ kind: 'already', title: data.attendee?.name ?? 'Attendee', detail: 'Check-in undone' })
    // The header count is optimistic in both directions; the next bootstrap
    // refresh reconciles it against the canonical counters.
    setCtx(c => (c ? { ...c, checkedIn: Math.max(0, c.checkedIn - 1) } : c))
  }, [correct])

  // ── Step 2: the existing check-in, unchanged ──────────────────────────────
  //
  // Reached only after the operator confirms. Still the same single call to
  // POST /api/checkin/scan — same transaction, same identifier engine, same
  // event-scope authorization. The identifier round-trip lives here rather than in
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

      // Past the identifier gate — the confirmation and prompt are both done with.
      setPrompt(null)
      setConfirm(null)

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
      // Remember it so this operator can reverse their own mistake immediately.
      setLastCheckIn(ticketCode)
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
        <QrScanner active={!busy && !confirm && !prompt} onCode={resolveAttendee} />
      )}

      {mode === 'manual' && (
        <form
          onSubmit={e => { e.preventDefault(); void resolveAttendee(manualCode) }}
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
                    onClick={() => void resolveAttendee(r.ticketCode)}
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

      {/* ── Attendee confirmation ────────────────────────────────────────────
          Step 2 of the flow: the operator sees WHO they resolved before anything
          is written. Confirm hands the same ticket code to the unchanged check-in
          call; the identifier prompt (below) only appears afterwards, and only if
          the server says one is needed. */}
      {confirm && !prompt && (
        <AttendeeConfirmation
          attendee={confirm}
          identifierLabel={confirm.detail?.identifierLabel ?? 'Identifier'}
          busy={busy}
          onConfirm={() => void submitCode(confirm.ticketCode)}
          onCancel={() => setConfirm(null)}
          onEditIdentifier={() => setPrompt({
            ticketCode:   confirm.ticketCode,
            label:        confirm.detail?.identifierLabel ?? 'Identifier',
            attendeeName: confirm.attendeeName,
            error:        '',
            correcting:   true,
          })}
        />
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
          onSubmit={value => {
            // Correcting an EXISTING value goes to the narrow correction endpoint
            // (engine swap); assigning a FIRST one stays part of the check-in.
            if (prompt.correcting) {
              void (async () => {
                const data = await correct(prompt.ticketCode, 'identifier', value)
                if (!data?.success) {
                  setPrompt(p => p && ({
                    ...p,
                    error: CORRECT_ERROR_COPY[data?.error ?? ''] ?? data?.error ?? 'Not accepted.',
                  }))
                  return
                }
                setPrompt(null)
                // Reflect the corrected value on the card the operator came from.
                setConfirm(c => (c && c.detail
                  ? { ...c, detail: { ...c.detail, identifierValue: data.identifierValue ?? null } }
                  : c))
              })()
              return
            }
            void submitCode(prompt.ticketCode, value)
          }}
          onCancel={() => {
            setPrompt(null)
            if (!prompt.correcting) {
              setOutcome({ kind: 'error', title: `${prompt.label} required — not checked in.` })
            }
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
          <div className="min-w-0 flex-1">
            <p className="text-fs-md font-semibold leading-snug">{outcome.title}</p>
            {outcome.detail && <p className="text-fs-sm text-muted-foreground">{outcome.detail}</p>}

            {/* RD-CHECKIN-FIX-01 — reverse a check-in this operator just made.
                Shown only after a successful admit, and the server independently
                re-checks that it was theirs and is still inside the window. */}
            {outcome.kind === 'success' && lastCheckIn && (
              <button
                type="button"
                onClick={() => void undoLast(lastCheckIn)}
                disabled={busy}
                className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-fs-2xs font-semibold text-foreground disabled:opacity-50"
              >
                <RotateCcw className="size-3" aria-hidden />
                Undo check-in
              </button>
            )}
          </div>
        </div>
      )}
    </main>
  )
}
