'use client'

// RD-CHECKIN-CONFIRM-01 — the ATTENDEE INFORMATION confirmation step.
//
// ═══ WHAT CHANGED AND WHY ════════════════════════════════════════════════════
// The gate used to admit someone the instant a code resolved. An operator had no
// chance to check they were looking at the right person, and — when an identifier
// was missing — the very first thing they saw was a bare number input with no
// indication of who it belonged to. This inserts one deliberate beat between
// "found" and "checked in".
//
// ═══ IT IS A VIEW, NOT A SECOND CHECK-IN PATH ════════════════════════════════
// Nothing here checks anyone in. It renders what the server already returned and
// hands the operator's decision back through `onConfirm`, which the caller routes
// into the SAME `POST /api/checkin/scan` it has always used — same transaction,
// same identifier engine, same event-scope authorization, same permission.
//
// ═══ THE FIELDS ARE THE ORGANIZER'S, NOT OURS ════════════════════════════════
// `detail.answers` arrives already labelled and ordered by the server from the
// event's own registration form. Nothing is invented, nothing is hardcoded, and an
// answer whose question no longer exists is dropped upstream rather than shown as
// an opaque field id. The identifier label is likewise the configured one.

import { useEffect, useRef } from 'react'
import { Loader2, Pencil, RotateCcw, UserCheck, X } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import type { AttendeeSearchResult } from '@/app/api/organizer/events/[eventId]/checkin/search/route'

interface Props {
  attendee: AttendeeSearchResult
  /** Configured identifier label for this event, for the "not assigned yet" line. */
  identifierLabel: string
  busy:     boolean
  /** Confirm → the caller performs the existing check-in. */
  onConfirm: () => void
  onCancel:  () => void
  /**
   * RD-CHECKIN-FIX-01 — optional "correct this identifier" action.
   *
   * Offered only where the surface supports it; omitting it renders the value
   * read-only exactly as before. It is a UI affordance, never an authorization:
   * the correction endpoint independently requires `checkin`, event assignment,
   * and that the attendee already holds a value.
   */
  onEditIdentifier?: () => void
  /**
   * RD-CHECKIN-LOOKUP-01 — optional restricted undo, offered only when the
   * attendee is ALREADY checked in.
   *
   * Like the edit action this is an affordance, not an authorization: the
   * correction endpoint independently requires `checkin`, event assignment, that
   * the check-in was THIS operator's, and that it is inside the 15-minute window.
   * Omitting it renders the card as a pure read-only record.
   */
  onUndo?: () => void
}

/** One label/value row. Values are plain text — never HTML. */
function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5">
      <dt className="shrink-0 text-fs-2xs uppercase tracking-wider text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words text-right text-fs-sm font-medium text-foreground">{value}</dd>
    </div>
  )
}

export default function AttendeeConfirmation({
  attendee, identifierLabel, busy, onConfirm, onCancel, onEditIdentifier, onUndo,
}: Props) {
  const confirmRef = useRef<HTMLButtonElement>(null)

  // Focus Confirm so a gate operator can scan → glance → Enter without reaching
  // for the screen. Escape cancels, so a wrong scan is never a trap.
  useEffect(() => { confirmRef.current?.focus() }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onCancel() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [busy, onCancel])

  const detail   = attendee.detail
  const assigned = detail?.identifierValue ?? null
  // The label the attendee's own identifier carries wins; otherwise the event's
  // configured label. Never a literal "Bib".
  const label    = detail?.identifierLabel ?? identifierLabel

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="attendee-confirm-title"
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4"
    >
      <div className="flex max-h-[92dvh] w-full max-w-sm flex-col rounded-t-2xl border border-border bg-card shadow-xl sm:rounded-2xl">

        {/* ── Header ───────────────────────────────────────────────────── */}
        <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <h2 id="attendee-confirm-title" className="text-fs-2xs font-semibold uppercase tracking-wider text-muted-foreground">
              Attendee information
            </h2>
            <p className="mt-1 truncate text-fs-lg font-bold leading-snug text-foreground">
              {attendee.attendeeName}
            </p>
          </div>
          <button
            type="button" onClick={onCancel} disabled={busy} aria-label="Cancel"
            className="-mr-1 -mt-1 rounded-lg p-1 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>

        {/* ── Scrollable body — a long form must not push the actions away ── */}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
          <dl className="divide-y divide-border">
            <Row label="Ticket code" value={attendee.ticketCode} />
            {attendee.attendeeEmail && <Row label="Email" value={attendee.attendeeEmail} />}
            {attendee.attendeePhone && <Row label="Phone" value={attendee.attendeePhone} />}
            {attendee.passName && <Row label="Category" value={attendee.passName} />}
            {detail?.eventName && <Row label="Event" value={detail.eventName} />}

            {/* Registration-form answers — dynamic, labelled and ordered upstream. */}
            {detail?.answers.map(a => <Row key={a.fieldId} label={a.label} value={a.value} />)}
          </dl>

          {/* ── Identifier ───────────────────────────────────────────────── */}
          <div className="mt-4 rounded-xl border border-border bg-muted/20 px-4 py-3">
            <div className="flex items-center justify-between gap-3">
              <p className="text-fs-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                {label}
              </p>
              {/* Correction is offered only when there IS a value to correct —
                  assigning a first one belongs to the check-in operation. */}
              {assigned && onEditIdentifier && (
                <button
                  type="button" onClick={onEditIdentifier} disabled={busy}
                  className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-fs-2xs font-semibold text-primary transition-opacity hover:opacity-75 disabled:opacity-50"
                >
                  <Pencil className="size-3" aria-hidden />
                  Edit
                </button>
              )}
            </div>
            {assigned ? (
              <p className="mt-1 font-mono text-fs-lg font-bold tracking-wider text-foreground">{assigned}</p>
            ) : (
              // No value yet — the prompt appears AFTER Confirm, so the operator has
              // seen who they are assigning it to before they are asked for it.
              <p className="mt-1 text-fs-sm text-muted-foreground">
                Not assigned yet — you will be asked for it next.
              </p>
            )}
          </div>

          {attendee.checkedIn && (
            <p role="status" className="mt-3 rounded-xl border border-warning/30 bg-warning/10 px-4 py-2.5 text-fs-sm text-foreground">
              Already checked in.
            </p>
          )}
        </div>

        {/* ── Actions ──────────────────────────────────────────────────────
            An attendee who is ALREADY checked in is never offered check-in
            again — the card becomes a read-only record with, at most, the
            restricted undo. Whether that undo is actually permitted (their own
            check-in, inside the window) is decided by the server; offering the
            button is not a claim that it will succeed. */}
        <div className="flex gap-2 border-t border-border px-5 py-4">
          <button
            type="button" onClick={onCancel} disabled={busy}
            className="flex-1 rounded-xl border border-border px-4 py-2.5 text-fs-sm font-semibold text-foreground disabled:opacity-50"
          >
            {attendee.checkedIn ? 'Close' : 'Cancel'}
          </button>

          {attendee.checkedIn ? (
            onUndo && (
              <button
                ref={confirmRef}
                type="button" onClick={onUndo} disabled={busy}
                className="flex-1 inline-flex items-center justify-center gap-2 rounded-xl border border-border px-4 py-2.5 text-fs-sm font-semibold text-foreground disabled:opacity-50"
              >
                {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <RotateCcw className="size-4" aria-hidden />}
                Undo check-in
              </button>
            )
          ) : (
            <button
              ref={confirmRef}
              type="button" onClick={onConfirm} disabled={busy}
              className={cn(
                'flex-1 inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5',
                'text-fs-sm font-semibold text-primary-foreground bg-primary disabled:opacity-50',
              )}
            >
              {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <UserCheck className="size-4" aria-hidden />}
              {assigned ? 'Check In' : 'Continue'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
