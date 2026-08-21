'use client'

// RD-CHECKIN-BIB-01 — the blocking identifier prompt shown when an attendee
// reaches the gate without the event's configured identifier.
//
// ═══ ONE COMPONENT, BOTH SURFACES ════════════════════════════════════════════
// Used by the organizer check-in page AND the /ops gate console. The prompt is a
// consequence of one server rule (scan returns IDENTIFIER_REQUIRED), so it has one
// implementation — a second copy would be a second place for the rules to drift.
//
// ═══ IT VALIDATES NOTHING ════════════════════════════════════════════════════
// Deliberately. Format, range, pool, uniqueness, blocked and retired values are
// all owned by the identifier engine, which decides inside a Firestore
// transaction. Re-implementing any of that here would create a second, weaker
// rulebook that disagrees with the server the moment an organizer edits their
// config. This component collects a string, submits it, and renders whatever the
// server says. The only thing it enforces locally is "not empty" and "not twice".
//
// The LABEL always comes from configuration ("Bib Number", "Member ID", …) and is
// never hardcoded.

import { useEffect, useRef, useState } from 'react'
import { Loader2, X } from 'lucide-react'

interface Props {
  /** Configured identifier label, from the server. */
  label:      string
  /** Who the operator is about to admit — the reason this prompt is not a bare input. */
  attendeeName?: string
  /** Server-supplied rejection from the previous attempt ('' when none). */
  error?:     string
  busy:       boolean
  onSubmit:   (value: string) => void
  onCancel:   () => void
}

export default function IdentifierPrompt({
  label, attendeeName, error, busy, onSubmit, onCancel,
}: Props) {
  const [value, setValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  // Autofocus so a gate operator can type straight after a scan without reaching
  // for the screen — this prompt sits in the middle of a queue.
  useEffect(() => { inputRef.current?.focus() }, [])

  // Escape cancels. A blocking modal with no keyboard exit is a trap when the
  // operator realises they scanned the wrong person.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onCancel() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [busy, onCancel])

  const trimmed = value.trim()

  function submit() {
    // Guarded against the double-submit a fast operator or a bouncing scanner
    // produces; the server is idempotent per value, but a second in-flight request
    // would race its own retry.
    if (busy || !trimmed) return
    onSubmit(trimmed)
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="identifier-prompt-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
    >
      <div className="w-full max-w-sm rounded-2xl border border-border bg-card p-5 shadow-xl">
        <div className="mb-1 flex items-start justify-between gap-3">
          <h2 id="identifier-prompt-title" className="text-fs-md font-bold leading-snug text-foreground">
            Enter {label}
          </h2>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            aria-label="Cancel"
            className="-mr-1 -mt-1 rounded-lg p-1 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>

        {attendeeName && (
          <p className="mb-3 truncate text-fs-sm text-muted-foreground">{attendeeName}</p>
        )}

        <form onSubmit={e => { e.preventDefault(); submit() }}>
          <input
            ref={inputRef}
            value={value}
            onChange={e => setValue(e.target.value)}
            disabled={busy}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            // `inputMode` (not `type="number"`) — many identifier configs are
            // alphanumeric or prefixed, so a numeric-only field would be wrong for
            // them. This raises a numeric keypad where it helps without excluding.
            inputMode="text"
            aria-label={label}
            aria-invalid={!!error}
            aria-describedby={error ? 'identifier-prompt-error' : undefined}
            className="w-full rounded-xl border border-border bg-background px-4 py-3 text-fs-md font-mono uppercase tracking-wider text-foreground outline-none focus:border-primary disabled:opacity-60"
          />

          {error && (
            <p id="identifier-prompt-error" role="alert" className="mt-2 text-fs-sm text-destructive">
              {error}
            </p>
          )}

          <div className="mt-4 flex gap-2">
            <button
              type="button"
              onClick={onCancel}
              disabled={busy}
              className="flex-1 rounded-xl border border-border px-4 py-2.5 text-fs-sm font-semibold text-foreground disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy || !trimmed}
              className="flex-1 inline-flex items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-fs-sm font-semibold text-primary-foreground disabled:opacity-50"
            >
              {busy && <Loader2 className="size-4 animate-spin" aria-hidden />}
              Confirm
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
