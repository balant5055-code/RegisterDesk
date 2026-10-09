'use client'

// RD-CHECKIN-ID-OPT-01 — "Do you want to use identifiers at check-in for this event?"
//
// Asked ONCE per event, and only when the event has never configured identifiers. The answer
// is stored in the EXISTING identifier configuration (`identifierConfigs/{event}.enabled`, via
// the existing PUT /identifiers/config) — no new setting. From then on the workspace states the
// event's choice instead of asking again; the organizer changes it in Bibs and badges.
//
//   Yes → enabled: true  — an attendee without an identifier is OFFERED one at check-in,
//                          validated by the existing identifier rules (the server decides);
//                          the operator may skip it (RD-CHECKIN-ID-OPT-02 — always optional).
//   No  → enabled: false — check-in never asks.
//
// Never offered when identifiers are ALREADY assigned on an unconfigured event: "No" would
// also switch identifier search off, and existing identifiers must stay usable. Rendered only
// for callers who may read the identifier setup (the API answers 403 to gate-only staff, who
// simply get the event's configured behaviour).

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { Hash, Loader2 } from 'lucide-react'

interface Overview {
  configured: boolean
  label:      string
  config:     { enabled?: boolean }
  totals?:    { assigned?: number | null }
}

type State =
  | { kind: 'hidden' }
  | { kind: 'ask' }
  | { kind: 'existing'; assigned: number; label: string }
  | { kind: 'set'; enabled: boolean; label: string }

/** What to show for this event, from the existing identifier overview. Never guesses. */
async function readState(eventId: string, getToken: () => Promise<string | null>): Promise<State> {
  const t = await getToken()
  if (!t) return { kind: 'hidden' }
  const res = await fetch(`/api/organizer/events/${encodeURIComponent(eventId)}/identifiers`, {
    headers: { Authorization: `Bearer ${t}` }, cache: 'no-store',
  }).catch(() => null)
  if (!res || !res.ok) return { kind: 'hidden' }                          // 403 for gate staff
  const o = await res.json().catch(() => null) as Overview | null
  if (!o) return { kind: 'hidden' }
  const label = o.label || 'Identifier'
  if (o.configured) return { kind: 'set', enabled: o.config?.enabled !== false, label }
  const assigned = typeof o.totals?.assigned === 'number' ? o.totals.assigned : null
  if (assigned === null) return { kind: 'hidden' }                         // unknown → never guess
  return assigned > 0 ? { kind: 'existing', assigned, label } : { kind: 'ask' }
}

export default function IdentifierCheckinChoice({ eventId, getToken, onChanged }: {
  eventId:   string
  getToken:  () => Promise<string | null>
  onChanged?: () => void
}) {
  const [state,   setState]   = useState<State>({ kind: 'hidden' })
  const [saving,  setSaving]  = useState<boolean | null>(null)
  const [error,   setError]   = useState<string | null>(null)
  const [version, setVersion] = useState(0)          // bumped after a save → re-read

  useEffect(() => {
    let alive = true
    void (async () => {
      const next = await readState(eventId, getToken)
      if (alive) setState(next)
    })()
    return () => { alive = false }
  }, [eventId, getToken, version])

  const choose = useCallback(async (enabled: boolean) => {
    setSaving(enabled); setError(null)
    try {
      const t = await getToken()
      const res = await fetch(`/api/organizer/events/${encodeURIComponent(eventId)}/identifiers/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: `Bearer ${t}` } : {}) },
        body: JSON.stringify({ enabled }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: string } | null
        setError(body?.error ?? 'Could not save your choice. Please try again.')
        return
      }
      setVersion(v => v + 1)
      onChanged?.()
    } catch {
      setError('Could not save your choice. Check your connection and try again.')
    } finally {
      setSaving(null)
    }
  }, [eventId, getToken, onChanged])

  const settingsHref = `/dashboard/events/${encodeURIComponent(eventId)}?tab=identifiers`

  if (state.kind === 'hidden') return null

  if (state.kind === 'set') {
    return (
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-border bg-card px-4 py-2.5 text-fs-sm text-muted-foreground" data-testid="identifier-checkin-state">
        <Hash className="size-4 shrink-0" aria-hidden />
        <span>
          {state.enabled
            ? <>Identifiers at check-in: <span className="font-semibold text-foreground">On</span> — an attendee without a {state.label} is offered one. It is optional: you can check them in without it.</>
            : <>Identifiers at check-in: <span className="font-semibold text-foreground">Off</span> — check-in never asks for one.</>}
        </span>
        <Link href={settingsHref} className="font-semibold text-primary underline-offset-2 hover:underline">Change</Link>
      </p>
    )
  }

  if (state.kind === 'existing') {
    return (
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-border bg-card px-4 py-2.5 text-fs-sm text-muted-foreground" data-testid="identifier-checkin-existing">
        <Hash className="size-4 shrink-0" aria-hidden />
        <span>
          {state.assigned.toLocaleString('en-IN')} {state.label}{state.assigned === 1 ? ' is' : 's are'} already assigned and stay searchable.
          Check-in will not ask for one unless you set up identifiers.
        </span>
        <Link href={settingsHref} className="font-semibold text-primary underline-offset-2 hover:underline">Set up identifiers</Link>
      </p>
    )
  }

  return (
    <section className="rounded-xl border border-border bg-card px-4 py-3" aria-labelledby="identifier-choice-heading" data-testid="identifier-checkin-choice">
      <h2 id="identifier-choice-heading" className="flex items-center gap-2 text-fs-sm font-semibold text-foreground">
        <Hash className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        Use identifiers at check-in for this event?
      </h2>
      <p className="mt-1 text-fs-sm text-muted-foreground">
        Identifiers are numbers such as bib or badge numbers. Choose Yes to be offered one when an attendee
        without an identifier checks in — you can always skip it. Choose No to never be asked. You can change this later in Bibs and badges.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" disabled={saving !== null} onClick={() => void choose(false)}
          className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-border bg-card px-3 text-fs-sm font-semibold text-foreground hover:bg-muted disabled:opacity-60">
          {saving === false && <Loader2 className="size-4 animate-spin" aria-hidden />}No, check in without identifiers
        </button>
        <button type="button" disabled={saving !== null} onClick={() => void choose(true)}
          className="inline-flex min-h-9 items-center gap-1.5 rounded-lg bg-primary px-3 text-fs-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-60">
          {saving === true && <Loader2 className="size-4 animate-spin" aria-hidden />}Yes, offer an identifier
        </button>
      </div>
      {error && <p role="alert" className="mt-2 text-fs-sm text-destructive">{error}</p>}
    </section>
  )
}
