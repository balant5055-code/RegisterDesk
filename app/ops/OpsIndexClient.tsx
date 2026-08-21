'use client'

// /ops — the gate operator's landing surface.
//
// ═══ WHY THIS PAGE EXISTS ════════════════════════════════════════════════════
// It used to be a static dead end: "open the check-in link your organizer shared with
// you". An operator who arrived here without that link — because they were assigned two
// events and CheckinStaffGuard could not pick one for them — had nowhere to go and no way
// to find out which events were even theirs. This turns the dead end into the choice the
// guard deliberately declines to make on their behalf.
//
// ═══ NO NEW PERMISSION, NO NEW API ═══════════════════════════════════════════
// Both endpoints already exist and both already gate themselves:
//   • /api/organizer/workspace   — token → workspace; no permission required, and it is
//                                  the same call CheckinStaffGuard makes.
//   • /api/checkin/ops/{eventId} — authorizeEvent(req, 'checkin', eventId), the SAME
//                                  guard the gate page itself passes through.
//
// The `events` permission is not requested and would not be granted: a gate-only role
// does not hold it. So the names below are never a listing of the workspace's events —
// they are the events this operator can already open, resolved one at a time through the
// very gate that would admit them. An operator assigned nothing sees nothing, and an
// event whose check-in is closed shows as closed rather than as a link that fails on
// arrival.

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { AlertCircle, ChevronRight, Loader2, RefreshCw, ScanLine } from 'lucide-react'
import { useAuth } from '@/components/auth/AuthProvider'
import type { WorkspaceInfoResponse } from '@/app/api/organizer/workspace/route'
import type { OpsCheckinContext } from '@/app/api/checkin/ops/[eventId]/route'

/** One assigned event, resolved as far as this operator's own access allows. */
interface Gate {
  eventId:   string
  eventName: string
  /** Present only when the gate is open; the counts come from the gate API itself. */
  counts:    { checkedIn: number, totalExpected: number } | null
  /** Set when the gate refused — shown instead of a link that would fail on arrival. */
  closed:    string | null
}

export default function OpsIndexClient() {
  const { user, getToken } = useAuth()

  const [gates,   setGates]   = useState<Gate[] | null>(null)
  const [empty,   setEmpty]   = useState(false)
  const [error,   setError]   = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const token = await getToken()
      if (!token) throw new Error('Your session has expired. Please sign in again.')
      const auth = { Authorization: `Bearer ${token}` }

      const wsRes = await fetch('/api/organizer/workspace', { headers: auth, cache: 'no-store' })
      if (!wsRes.ok) throw new Error('Could not load your check-in assignments.')
      const ws = await wsRes.json() as WorkspaceInfoResponse

      // [] means unrestricted, which this surface cannot enumerate without the `events`
      // permission — and must not. Treated as "nothing to offer" rather than guessed at.
      if (ws.eventIds.length === 0) { setEmpty(true); setGates([]); return }

      // One call per assignment, in parallel. This is an operator's event assignments, so
      // it is a handful of ids, not a page of them.
      const resolved = await Promise.all(ws.eventIds.map(async (eventId): Promise<Gate> => {
        try {
          const res = await fetch(`/api/checkin/ops/${encodeURIComponent(eventId)}`, {
            headers: auth, cache: 'no-store',
          })
          if (!res.ok) {
            const body = await res.json().catch(() => ({})) as { error?: string }
            return { eventId, eventName: 'This event', counts: null, closed: body.error ?? 'Unavailable' }
          }
          const ctx = await res.json() as OpsCheckinContext
          return {
            eventId,
            eventName: ctx.eventName,
            counts:    { checkedIn: ctx.checkedIn, totalExpected: ctx.totalExpected },
            closed:    null,
          }
        } catch {
          return { eventId, eventName: 'This event', counts: null, closed: 'Could not be reached' }
        }
      }))

      setEmpty(false)
      setGates(resolved)
    } catch (e) {
      setGates(null)
      setError(e instanceof Error ? e.message : 'Could not load your check-in assignments.')
    } finally {
      setLoading(false)
    }
  }, [getToken])

  // Same shape as every other client list surface in the repo (see AssetLibraryClient):
  // the effect only kicks off a fetch, which then sets state.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { if (user) void load() }, [user, load])

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col gap-4 px-6 py-10">
      <header className="space-y-1">
        <p className="text-fs-2xs font-semibold uppercase tracking-wider text-muted-foreground">RegisterDesk</p>
        <h1 className="text-fs-lg font-semibold text-foreground">Check-in console</h1>
      </header>

      {loading && (
        <p className="flex items-center gap-2 text-fs-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" aria-hidden /> Loading your events…
        </p>
      )}

      {!loading && error && (
        <div className="space-y-3 rounded-xl border border-border p-4">
          <p className="flex items-start gap-2 text-fs-sm text-foreground">
            <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden /> {error}
          </p>
          <button
            type="button"
            onClick={() => { void load() }}
            className="inline-flex items-center gap-2 text-fs-sm font-semibold text-primary hover:underline"
          >
            <RefreshCw className="size-3.5" aria-hidden /> Try again
          </button>
        </div>
      )}

      {!loading && !error && empty && (
        <p className="text-fs-sm text-muted-foreground">
          Open the check-in link your organizer shared with you to start scanning.
        </p>
      )}

      {!loading && !error && !empty && gates && gates.length > 0 && (
        <>
          <p className="text-fs-sm text-muted-foreground">
            {gates.length === 1 ? 'Your assigned event.' : 'Choose the event you are working.'}
          </p>

          <ul className="space-y-2">
            {gates.map(gate => (
              <li key={gate.eventId}>
                {gate.closed === null ? (
                  <Link
                    href={`/ops/checkin/${encodeURIComponent(gate.eventId)}`}
                    className="flex items-center gap-3 rounded-xl border border-border p-4 hover:border-primary"
                  >
                    <ScanLine className="size-5 shrink-0 text-primary" aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-fs-sm font-semibold text-foreground">{gate.eventName}</span>
                      {gate.counts && (
                        <span className="block text-fs-2xs text-muted-foreground">
                          {gate.counts.checkedIn} of {gate.counts.totalExpected} checked in
                        </span>
                      )}
                    </span>
                    <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  </Link>
                ) : (
                  // No link. A gate that would refuse on arrival is shown as closed here,
                  // so the operator learns it at a glance instead of at the turnstile.
                  <div className="flex items-center gap-3 rounded-xl border border-border p-4 opacity-60">
                    <AlertCircle className="size-5 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-fs-sm font-semibold text-foreground">{gate.eventName}</span>
                      <span className="block text-fs-2xs text-muted-foreground">{gate.closed}</span>
                    </span>
                  </div>
                )}
              </li>
            ))}
          </ul>

          <button
            type="button"
            onClick={() => { void load() }}
            className="inline-flex items-center gap-2 self-start text-fs-2xs font-medium text-muted-foreground hover:text-foreground"
          >
            <RefreshCw className="size-3.5" aria-hidden /> Refresh
          </button>
        </>
      )}
    </main>
  )
}
