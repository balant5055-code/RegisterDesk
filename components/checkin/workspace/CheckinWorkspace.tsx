'use client'

// RD-CHECKIN-2.0 — the check-in workspace. ONE implementation, two doors.
//
// Rendered by /ops/checkin/[eventId] (the gate console) and by
// /dashboard/events/[eventId]/checkin (the organizer's own view). They differ in
// the chrome around them and in nothing else, which is the point: the previous
// arrangement had two clients, two lookup handlers and two identifier round-trips,
// and they had already drifted apart in what a lookup row did when clicked.
//
// ═══ THE LOOP THIS SURFACE IS BUILT AROUND ═══════════════════════════════════
//        FIND  →  VERIFY  →  CHECK IN  →  NEXT
// Every mode — QR, ticket code, lookup — converges on the SAME resolve step, which
// checks nobody in, and then the SAME admission call. An operator who scanned the
// wrong person cancels; they never have to undo something that already happened.
//
// ═══ THE UI IS NEVER THE CONTROL ═════════════════════════════════════════════
// `canWalkIn` / `canUndo` arrive from the server and decide what is DRAWN. Each
// underlying route independently re-verifies the token, the permission and the
// event assignment, so editing this state in a browser changes pixels and nothing
// else. Nothing here is trusted with an authorization decision.
//
// ═══ OFFLINE IS SHOWN AS WHAT IT IS ══════════════════════════════════════════
// The offline queue is preserved (it is a licensed capability and the engine behind
// it is sound), but an offline admission is rendered as QUEUED, never as
// "successful": the server has not seen it and may still refuse it on replay. That
// is the honest-state requirement, and it is why the outcome card has a fourth
// state rather than three.

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import {
  Keyboard, Loader2, ScanLine, Search, UserPlus, AlertCircle, RefreshCw, CloudOff,
} from 'lucide-react'
import { useAuth } from '@/components/auth/AuthProvider'
import { ticketCodeFromQr } from '@/lib/checkin/qr'
import { useOfflineCheckin } from '@/lib/checkin/useOfflineCheckin'
import { cn } from '@/lib/utils/cn'
import QrScanner from '@/components/checkin/QrScanner'
import IdentifierPrompt from '@/components/checkin/IdentifierPrompt'
import IdentifierCheckinChoice from '@/components/checkin/IdentifierCheckinChoice'
import AttendeeConfirmation from '@/components/checkin/AttendeeConfirmation'
import AttendanceHeader from './AttendanceHeader'
import OutcomeCard, { type Outcome } from './OutcomeCard'
import SearchResults from './SearchResults'
import RecentStrip from './RecentStrip'
import WalkInPanel from './WalkInPanel'
import type { OpsCheckinContext } from '@/app/api/checkin/ops/[eventId]/route'
import type { CheckInResult } from '@/app/api/checkin/scan/route'
import type { CheckInCorrectResult } from '@/app/api/checkin/correct/route'
import type {
  AttendeeSearchResult, AttendeeSearchResponse,
} from '@/app/api/organizer/events/[eventId]/checkin/search/route'

type Mode = 'scan' | 'manual' | 'lookup' | 'walkin'

// ─── Connectivity ─────────────────────────────────────────────────────────────
// useSyncExternalStore rather than useState+useEffect: the browser's online flag is
// an external store, and subscribing to it directly avoids both the cascading
// render an effect-write would cause and the hydration mismatch that reading
// `navigator` during SSR would cause.

const subscribeOnline = (cb: () => void) => {
  window.addEventListener('online', cb)
  window.addEventListener('offline', cb)
  return () => {
    window.removeEventListener('online', cb)
    window.removeEventListener('offline', cb)
  }
}

function useOnlineStatus(): boolean {
  return useSyncExternalStore(subscribeOnline, () => navigator.onLine, () => true)
}

/** Server error codes in gate language. Unmapped codes show the server's own text. */
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
  IDENTIFIER_REQUIRES_ONLINE:    'This attendee needs a number assigned, which requires a connection.',
}

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

const CORRECT_ERROR_COPY: Record<string, string> = {
  NOT_YOUR_CHECKIN:         'You can only undo a check-in you performed.',
  UNDO_WINDOW_EXPIRED:      'Too long ago to undo here — ask an organizer.',
  NOT_CHECKED_IN:           'This attendee is not checked in.',
  EVENT_NOT_ASSIGNED:       'You are not assigned to this event.',
  NO_IDENTIFIER_TO_CORRECT: 'Nothing to correct yet.',
  VALUE_CONFLICT:           'Already assigned to another participant.',
  UNAUTHORIZED:             'You cannot correct this ticket.',
  TICKET_NOT_FOUND:         'Ticket not found.',
}

/** The in-flight identifier request: which ticket it belongs to, and what to show. */
interface Prompt {
  ticketCode:    string
  label:         string
  attendeeName?: string
  error:         string
  /** True when correcting an existing value rather than assigning a first one. */
  correcting?:   boolean
}

const MODES: { id: Mode; label: string; Icon: typeof ScanLine }[] = [
  { id: 'scan',   label: 'Scan QR',    Icon: ScanLine },
  { id: 'lookup', label: 'Find',       Icon: Search },
  { id: 'manual', label: 'Ticket code', Icon: Keyboard },
  { id: 'walkin', label: 'Walk-in',    Icon: UserPlus },
]

export interface CheckinWorkspaceProps {
  eventId: string
  /** Set on the organizer's own page so it does not draw a second event title. */
  embedded?: boolean
}

export default function CheckinWorkspace({ eventId, embedded = false }: CheckinWorkspaceProps) {
  const { user, getToken } = useAuth()

  const [ctx,     setCtx]     = useState<OpsCheckinContext | null>(null)
  const [token,   setToken]   = useState<string | null>(null)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [mode,    setMode]    = useState<Mode>('scan')
  const [busy,    setBusy]    = useState(false)
  const [refreshing, setRefreshing] = useState(false)

  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const [prompt,  setPrompt]  = useState<Prompt | null>(null)
  const [confirm, setConfirm] = useState<AttendeeSearchResult | null>(null)
  /** The ticket this operator most recently admitted, for a same-session undo. */
  const [lastCheckIn, setLastCheckIn] = useState<string | null>(null)

  const [manualCode, setManualCode] = useState('')
  const [query,      setQuery]      = useState('')
  const [results,    setResults]    = useState<AttendeeSearchResult[]>([])
  const [searching,  setSearching]  = useState(false)
  const [searched,   setSearched]   = useState(false)
  const [notice,     setNotice]     = useState<string | null>(null)
  const [truncated,  setTruncated]  = useState(false)

  const manualRef = useRef<HTMLInputElement>(null)
  const queryRef  = useRef<HTMLInputElement>(null)

  const online = useOnlineStatus()

  // Signed-out is DERIVED, not stored. Mirroring auth into state would mean writing
  // it from an effect, cascading a second render on every auth transition — and on
  // a gate console the first paint is the one that matters.
  const bootErr = user === null ? 'Please sign in to continue.' : loadErr

  // ── Bootstrap / refresh: this call IS the page's gate ─────────────────────
  const load = useCallback(async (opts?: { quiet?: boolean }) => {
    if (!user) return
    if (opts?.quiet) setRefreshing(true)
    try {
      const t = await getToken()
      if (!t) { setLoadErr('Please sign in to continue.'); return }
      setToken(t)

      const res = await fetch(`/api/checkin/ops/${encodeURIComponent(eventId)}?recent=8`, {
        headers: { Authorization: `Bearer ${t}` }, cache: 'no-store',
      })
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: string } | null
        setLoadErr(body?.error ?? 'You do not have access to this event.')
        return
      }
      setCtx(await res.json() as OpsCheckinContext)
      setLoadErr(null)
    } catch {
      setLoadErr('Could not reach the server. Check your connection.')
    } finally {
      setRefreshing(false)
    }
  }, [user, eventId, getToken])

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load() }, [load])

  // ── Offline queue ─────────────────────────────────────────────────────────
  // Preserved, not rebuilt: the engine already validates against the cached list,
  // refuses an attendee who still needs an identifier (which cannot be assigned
  // without the server's uniqueness transaction), and lets the SERVER win on
  // replay. What changes is that its result is presented as queued, not admitted.
  const offline = useOfflineCheckin({
    eventSlug: ctx?.eventSlug ?? '',
    // Held back until the event is resolved. The token is set a moment before
    // `ctx` is, and the hook treats an empty token as "not ready" — without this
    // guard it would fire one cache request with an empty slug and record a
    // spurious cache error on every mount.
    token:     ctx ? (token ?? '') : '',
    onSynced:  () => { void load({ quiet: true }) },
  })

  const identifierLabel = ctx?.identifierLabel ?? 'Identifier'

  // ── Step 1: RESOLVE — nobody is checked in here ───────────────────────────
  //
  // ONE resolver for QR, ticket code and a selected lookup row: they differ only in
  // where the code came from. It calls the authoritative lookup endpoint, which the
  // server authorizes with the same permission and the same event assignment.
  const resolveAttendee = useCallback(async (rawCode: string) => {
    const ticketCode = ticketCodeFromQr(rawCode)
    if (!ticketCode || !ctx) return

    setBusy(true)
    setOutcome(null)
    try {
      const t = await getToken()
      const res = await fetch(
        `/api/organizer/events/${encodeURIComponent(eventId)}/checkin/search?q=${encodeURIComponent(ticketCode)}`,
        { headers: { Authorization: `Bearer ${t}` }, cache: 'no-store' },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: string } | null
        setOutcome({ kind: 'error', title: body?.error ?? 'Could not look up this ticket.' })
        return
      }
      const data = await res.json() as AttendeeSearchResponse
      const found = data.results?.[0]
      // An empty result is the server's uniform answer for "not this event's ticket"
      // as well as "no such ticket" — it deliberately does not distinguish them.
      if (!found) { setOutcome({ kind: 'error', title: ERROR_COPY.TICKET_NOT_FOUND }); return }
      setConfirm(found)
    } catch {
      setOutcome({ kind: 'error', title: 'Network error. Check your connection and retry.' })
    } finally {
      setBusy(false)
      setManualCode('')
    }
  }, [ctx, eventId, getToken])

  // ── Step 2: ADMIT — the existing, unchanged transaction ───────────────────
  // RD-CHECKIN-ID-OPT-02 — `skipIdentifier` = the operator chose "Check in without …".
  const submitCode = useCallback(async (rawCode: string, identifierValue?: string, skipIdentifier = false) => {
    const ticketCode = ticketCodeFromQr(rawCode)
    if (!ticketCode || !ctx) return

    setBusy(true)
    if (!identifierValue) setOutcome(null)

    // ── Offline path ────────────────────────────────────────────────────────
    // Never presented as a completed check-in. The device has recorded an intent;
    // the server decides when the connection returns.
    if (!online) {
      // No cached list means the offline validator has nothing to check against,
      // and every scan would come back TICKET_NOT_FOUND — a wrong answer that
      // reads exactly like a real one. Say what is actually true instead.
      if (offline.cachedCount === 0) {
        setBusy(false)
        setPrompt(null)
        setConfirm(null)
        setOutcome({
          kind:   'error',
          title:  'Offline, with no attendee list on this device',
          detail: 'Check-in cannot continue until the connection returns. Nobody has been checked in.',
        })
        return
      }
      try {
        const res = await offline.scanOffline(ticketCode)
        setPrompt(null)
        setConfirm(null)
        if (!res.success) {
          setOutcome({ kind: 'error', title: ERROR_COPY[res.error ?? ''] ?? res.error ?? 'Not checked in.' })
        } else if (res.alreadyCheckedIn) {
          setOutcome({ kind: 'already', title: res.attendee?.name ?? 'Attendee', at: res.checkedInAt ?? null })
        } else {
          setOutcome({
            kind:     'queued',
            title:    res.attendee?.name ?? 'Attendee',
            subtitle: res.attendee?.passName,
            at:       res.checkedInAt ?? null,
            detail:   'Recorded on this device. It will be confirmed with the server when the connection returns.',
          })
        }
      } finally {
        setBusy(false)
        setManualCode('')
      }
      return
    }

    try {
      const t = await getToken()
      const res = await fetch('/api/checkin/scan', {
        method:  'POST',
        headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
        // eventSlug pins the scan to THIS gate. The server also derives the
        // operator's own event assignment independently, so this is a convenience
        // check rather than the control.
        body:    JSON.stringify({
          ticketCode, source: mode === 'walkin' ? 'manual' : mode, eventSlug: ctx.eventSlug,
          ...(identifierValue ? { identifierValue } : {}),
          ...(skipIdentifier ? { skipIdentifier: true } : {}),
        }),
      })
      const data = await res.json() as CheckInResult

      // The attendee has no identifier yet. Nothing has been written: the server
      // stops before the check-in transaction. Hold the code so Confirm (or "Check in
      // without") retries the SAME attendee — identifiers are optional (RD-CHECKIN-ID-OPT-02).
      if (data.requiresIdentifier) {
        setPrompt({
          ticketCode,
          label:        data.identifierLabel ?? identifierLabel,
          attendeeName: data.attendee?.name,
          error:        identifierValue
            ? (IDENTIFIER_ERROR_COPY[data.error ?? ''] ?? data.error ?? 'Not accepted.')
            : '',
        })
        return
      }

      setPrompt(null)
      setConfirm(null)

      if (!res.ok || !data.success) {
        const code = data.error ?? ''
        setOutcome({ kind: 'error', title: ERROR_COPY[code] ?? code ?? 'Check-in failed.' })
        return
      }

      if (data.alreadyCheckedIn) {
        setOutcome({
          kind:  'already',
          title: data.attendee?.name ?? 'Attendee',
          subtitle: data.attendee?.passName,
          at:    data.checkedInAt ?? null,
        })
        return
      }

      setOutcome({
        kind:     'success',
        title:    data.attendee?.name ?? 'Attendee',
        subtitle: data.identifierValue
          ? `${identifierLabel} ${data.identifierValue} · ${data.attendee?.passName ?? ''}`.replace(/ · $/, '')
          : data.attendee?.passName,
        at: data.checkedInAt ?? null,
        by: user?.displayName ?? null,
      })
      setLastCheckIn(ticketCode)
      // Reconcile the header and the recent strip against the server rather than
      // incrementing a local number — the counters are the authority.
      void load({ quiet: true })
    } catch {
      // A network failure must never render as an admission.
      setOutcome({ kind: 'error', title: 'Network error. The attendee was NOT checked in.' })
    } finally {
      setBusy(false)
      setManualCode('')
      manualRef.current?.focus()
    }
  }, [ctx, getToken, mode, online, offline, identifierLabel, user, load])

  // ── Corrections ───────────────────────────────────────────────────────────
  const correct = useCallback(async (
    ticketCode: string, action: 'identifier' | 'undo', identifierValue?: string,
  ): Promise<CheckInCorrectResult | null> => {
    setBusy(true)
    try {
      const t = await getToken()
      const res = await fetch('/api/checkin/correct', {
        method:  'POST',
        headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ ticketCode, action, ...(identifierValue ? { identifierValue } : {}) }),
      })
      return await res.json() as CheckInCorrectResult
    } catch {
      return null
    } finally {
      setBusy(false)
    }
  }, [getToken])

  const undo = useCallback(async (ticketCode: string, closeCard: boolean) => {
    const data = await correct(ticketCode, 'undo')
    if (!data) {
      setOutcome({ kind: 'error', title: 'Network error. Nothing was changed.' })
      return
    }
    if (!data.success) {
      setOutcome({
        kind:  'error',
        title: 'Could not undo',
        detail: CORRECT_ERROR_COPY[data.error ?? ''] ?? data.error ?? 'Please ask an organizer.',
      })
      return
    }
    if (closeCard) setConfirm(null)
    setLastCheckIn(null)
    setResults(rows => rows.map(r => (r.ticketCode === ticketCode ? { ...r, checkedIn: false } : r)))
    setOutcome({ kind: 'already', title: data.attendee?.name ?? 'Attendee', detail: 'Check-in undone.' })
    void load({ quiet: true })
  }, [correct, load])

  // ── Lookup ────────────────────────────────────────────────────────────────
  const runSearch = useCallback(async () => {
    const q = query.trim()
    if (!q || !ctx) return
    setSearching(true)
    setOutcome(null)
    try {
      const t = await getToken()
      const res = await fetch(
        `/api/organizer/events/${encodeURIComponent(eventId)}/checkin/search?q=${encodeURIComponent(q)}`,
        { headers: { Authorization: `Bearer ${t}` }, cache: 'no-store' },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: string } | null
        setResults([]); setTruncated(false)
        // The server's refusal is shown verbatim — including "name search is not
        // available yet", which must never be silently rendered as "no results".
        setNotice(body?.error ?? 'Search is unavailable right now.')
        return
      }
      const data = await res.json() as AttendeeSearchResponse
      setResults(data.results ?? [])
      setNotice(data.notice ?? null)
      setTruncated(data.truncated)
    } catch {
      setResults([]); setTruncated(false)
      setNotice('Network error. Check your connection and try again.')
    } finally {
      setSearching(false)
      setSearched(true)
    }
  }, [query, ctx, eventId, getToken])

  const reset = useCallback(() => {
    setOutcome(null); setConfirm(null); setPrompt(null); setLastCheckIn(null)
    if (mode === 'manual') manualRef.current?.focus()
    if (mode === 'lookup') queryRef.current?.focus()
  }, [mode])

  const availableModes = useMemo(
    () => MODES.filter(m => m.id !== 'walkin' || ctx?.canWalkIn),
    [ctx?.canWalkIn],
  )

  // Read once, and default to FALSE: before the context has loaded, and if the field
  // is ever missing from the payload, the safe answer is "no undo" rather than a
  // control that only fails when pressed.
  const canUndo = ctx?.canUndo === true

  // ── Render ────────────────────────────────────────────────────────────────

  if (bootErr) {
    return (
      <main className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center gap-3 px-6 text-center">
        <AlertCircle className="size-10 text-destructive" aria-hidden />
        <h1 className="text-fs-lg font-semibold">Check-in unavailable</h1>
        <p className="text-fs-sm text-muted-foreground">{bootErr}</p>
        <button
          type="button"
          onClick={() => void load()}
          className="mt-1 inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2 text-fs-sm font-semibold"
        >
          <RefreshCw className="size-4" aria-hidden /> Try again
        </button>
      </main>
    )
  }

  if (!ctx) {
    return (
      <main className="flex min-h-[60vh] items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" aria-hidden />
        <span className="sr-only">Loading check-in</span>
      </main>
    )
  }

  /** The verification / outcome stage replaces the input area once it is active. */
  const staged = Boolean(confirm || prompt || outcome)

  return (
    <main className={cn('mx-auto flex w-full flex-col gap-5', embedded ? 'max-w-6xl' : 'max-w-6xl px-4 pb-10 pt-6 sm:px-6')}>
      <AttendanceHeader
        eventName={ctx.eventName}
        // Never the email: a staff credential's address is a reserved
        // non-routable identifier, not something to show a human.
        operatorName={user?.displayName || 'Operator'}
        checkedIn={ctx.checkedIn}
        totalExpected={ctx.totalExpected}
        statsUnavailable={ctx.statsUnavailable}
        online={online}
        refreshing={refreshing}
      />

      {/* RD-CHECKIN-ID-OPT-01 — asks once per unconfigured event; otherwise states the choice. */}
      <IdentifierCheckinChoice eventId={eventId} getToken={getToken} onChanged={() => void load()} />

      {/* Offline banner — truthful about what is and is not possible. */}
      {!online && (
        <p role="status" className="flex items-start gap-2 rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-fs-sm text-foreground">
          <CloudOff className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
          {/* Two genuinely different situations, and conflating them would be the
              dishonest kind of offline UI: a device with a cached list can still
              admit people provisionally; a device with NO cached list can do
              nothing, and would otherwise report every scan as "ticket not found". */}
          {offline.cachedCount > 0 ? (
            <span>
              Offline. Scans are checked against the {offline.cachedCount.toLocaleString('en-IN')} attendees
              cached on this device and queued — each is confirmed with the server when the connection
              returns, and the server decides. Lookup and walk-in need a connection.
            </span>
          ) : (
            <span>
              Offline, and no attendee list is cached on this device — check-in cannot continue until
              the connection returns. Nothing scanned now would be recorded.
            </span>
          )}
        </p>
      )}

      {online && offline.pendingCount > 0 && (
        <p role="status" className="flex items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-2.5 text-fs-sm">
          <span className="text-muted-foreground">
            {offline.pendingCount} queued {offline.pendingCount === 1 ? 'scan' : 'scans'} waiting to be confirmed
            {offline.conflictCount > 0 && <> · {offline.conflictCount} needed review</>}
          </span>
          <button
            type="button"
            onClick={offline.syncNow}
            disabled={offline.syncing}
            className="shrink-0 rounded-lg border border-border px-3 py-1.5 text-fs-2xs font-semibold disabled:opacity-50"
          >
            {offline.syncing ? 'Syncing…' : 'Sync now'}
          </button>
        </p>
      )}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start">
        {/* ── Primary operation column ───────────────────────────────────── */}
        <div className="flex min-w-0 flex-col gap-4">
          {/* RD-CHECKIN-QA-01 — the column count follows the number of modes.
              A fixed 3-up grid left the fourth mode (Walk-in, for an operator who
              holds the permission) stranded alone on a second row with two empty
              cells beside it. Four modes read as a 2×2 block on a phone; three read
              as one row. Above `sm` they all fit on one line either way. */}
          <div
            role="tablist"
            aria-label="Check-in method"
            className={cn(
              'grid gap-2 sm:grid-cols-4',
              availableModes.length === 4 ? 'grid-cols-2' : 'grid-cols-3',
            )}
          >
            {availableModes.map(({ id, label, Icon }) => (
              <button
                key={id}
                role="tab"
                type="button"
                aria-selected={mode === id}
                onClick={() => { setMode(id); reset(); setSearched(false); setResults([]); setNotice(null) }}
                className={cn(
                  'flex min-h-14 flex-col items-center justify-center gap-1 rounded-xl border px-2 py-3 text-fs-2xs font-semibold transition-colors',
                  mode === id
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border bg-card text-muted-foreground hover:text-foreground',
                )}
              >
                <Icon className="size-5" aria-hidden />
                {label}
              </button>
            ))}
          </div>

          {/* Verification and outcome take over the operation area — the loop is
              FIND → VERIFY → CHECK IN → NEXT, one stage at a time. */}
          {prompt ? (
            <IdentifierPrompt
              label={prompt.label}
              attendeeName={prompt.attendeeName}
              error={prompt.error}
              busy={busy}
              onSubmit={value => {
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
                    setConfirm(c => (c && c.detail
                      ? { ...c, detail: { ...c.detail, identifierValue: data.identifierValue ?? null } }
                      : c))
                  })()
                  return
                }
                void submitCode(prompt.ticketCode, value)
              }}
              onSkip={prompt.correcting ? undefined : () => void submitCode(prompt.ticketCode, undefined, true)}
              onCancel={() => {
                setPrompt(null)
                if (!prompt.correcting) {
                  // RD-CHECKIN-QA-01 — the confirmation card MUST be cleared here.
                  //
                  // Browser QA: cancelling the prompt set this outcome and the
                  // operator never saw it. The stage renders `prompt ?? confirm ??
                  // outcome`, and `confirm` was still set — so the card came back
                  // with "Continue" still on it and the refusal was unreachable.
                  // The operator was left with no statement that the attendee had
                  // NOT been admitted, one tap away from looping.
                  setConfirm(null)
                  setOutcome({ kind: 'error', title: 'Check-in cancelled', detail: 'The attendee was not checked in.' })
                }
              }}
            />
          ) : confirm ? (
            <AttendeeConfirmation
              attendee={confirm}
              identifierLabel={confirm.detail?.identifierLabel ?? identifierLabel}
              busy={busy}
              onConfirm={() => void submitCode(confirm.ticketCode)}
              onCancel={() => setConfirm(null)}
              onEditIdentifier={() => setPrompt({
                ticketCode:   confirm.ticketCode,
                label:        confirm.detail?.identifierLabel ?? identifierLabel,
                attendeeName: confirm.attendeeName,
                error:        '',
                correcting:   true,
              })}
              // `canUndo` is the SERVER's answer (permissions.includes('registrations')),
              // and undoing is state, not display — so it gates the control here as well
              // as the route. Without it a gate operator was shown "Undo check-in" and
              // got a 403 on press: the button was real, the permission was not
              // (RD-CHECKIN-07 Defect 2). Both undo sites below read the same flag.
              onUndo={canUndo && confirm.checkedIn ? () => void undo(confirm.ticketCode, true) : undefined}
            />
          ) : outcome ? (
            <OutcomeCard
              outcome={outcome}
              busy={busy}
              nextLabel={mode === 'scan' ? 'Scan next' : 'Next attendee'}
              onNext={reset}
              onUndo={canUndo && outcome.kind === 'success' && lastCheckIn
                ? () => void undo(lastCheckIn, false)
                : undefined}
            />
          ) : (
            <>
              {mode === 'scan' && (
                <QrScanner active={!busy && !staged && online} onCode={resolveAttendee} />
              )}

              {mode === 'manual' && (
                <form
                  onSubmit={e => { e.preventDefault(); void resolveAttendee(manualCode) }}
                  className="flex flex-col gap-3"
                >
                  <label htmlFor="ci-ticket" className="text-fs-sm font-medium">Ticket code</label>
                  <input
                    id="ci-ticket"
                    ref={manualRef}
                    value={manualCode}
                    onChange={e => setManualCode(e.target.value)}
                    autoFocus
                    autoCapitalize="characters"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="RD-XXXX-00000"
                    className="rounded-xl border border-border bg-card px-4 py-3 font-mono text-fs-md uppercase tracking-wider outline-none focus:border-primary focus-visible:ring-2 focus-visible:ring-primary"
                  />
                  <button
                    type="submit"
                    disabled={busy || !manualCode.trim()}
                    className="rounded-xl bg-primary px-4 py-3 text-fs-md font-semibold text-primary-foreground disabled:opacity-50"
                  >
                    {busy ? 'Finding…' : 'Find attendee'}
                  </button>
                </form>
              )}

              {mode === 'lookup' && (
                <div className="flex flex-col gap-4">
                  <form onSubmit={e => { e.preventDefault(); void runSearch() }} className="flex gap-2">
                    <input
                      ref={queryRef}
                      value={query}
                      onChange={e => setQuery(e.target.value)}
                      autoFocus
                      // A configured label is the organizer's words and is printed VERBATIM.
                      placeholder={`Name, email, phone, ticket code or ${identifierLabel}`}
                      aria-label="Find an attendee"
                      className="min-w-0 flex-1 rounded-xl border border-border bg-card px-4 py-3 text-fs-md outline-none focus:border-primary focus-visible:ring-2 focus-visible:ring-primary"
                    />
                    <button
                      type="submit"
                      disabled={searching || query.trim().length < 2 || !online}
                      className="shrink-0 rounded-xl bg-primary px-5 py-3 text-fs-md font-semibold text-primary-foreground disabled:opacity-50"
                    >
                      Find
                    </button>
                  </form>

                  {!online ? (
                    <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-fs-sm text-muted-foreground">
                      Lookup needs a connection. Scan a QR code or enter a ticket code instead.
                    </p>
                  ) : (
                    <SearchResults
                      results={results}
                      identifierLabel={identifierLabel}
                      searching={searching}
                      searched={searched}
                      notice={notice}
                      truncated={truncated}
                      busy={busy}
                      onSelect={row => void resolveAttendee(row.ticketCode)}
                    />
                  )}
                </div>
              )}

              {mode === 'walkin' && ctx.canWalkIn && (
                online ? (
                  <WalkInPanel
                    slug={ctx.eventSlug}
                    token={token}
                    onRegistered={() => void load({ quiet: true })}
                  />
                ) : (
                  <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-fs-sm text-muted-foreground">
                    Walk-in registration needs a connection — capacity and duplicate checks are decided by the server.
                  </p>
                )
              )}
            </>
          )}
        </div>

        {/* ── Status column ──────────────────────────────────────────────── */}
        <aside className="flex min-w-0 flex-col gap-4">
          <RecentStrip rows={ctx.recent} identifierLabel={identifierLabel} />
        </aside>
      </div>
    </main>
  )
}
