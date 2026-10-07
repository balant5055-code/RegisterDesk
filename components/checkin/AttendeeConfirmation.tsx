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
import { Ban, Loader2, Pencil, RotateCcw, UserCheck, X } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { checkInBlockReason, type CheckInBlockReason } from '@/lib/registrations/checkinEligibility'
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

/**
 * RD-CHECKIN-QA-01 — why an ineligible attendee can never reach the confirm button.
 *
 * ═══ THE DEFECT THIS CLOSES ══════════════════════════════════════════════════
 * Browser QA resolved a CANCELLED registration and this card offered "Continue".
 * Nothing on it said the registration was cancelled. The server refuses at
 * `/api/checkin/scan`, so nobody was ever admitted — but the operator was walked
 * all the way to the confirm button and only told at the end, in front of the
 * person. Worse: that attendee had no bib, so "Continue" would first have opened
 * the blocking identifier prompt and asked the operator to assign a number to
 * somebody who can never be admitted.
 *
 * ═══ ONE RULE, NOT A SECOND RULEBOOK ═════════════════════════════════════════
 * `checkInBlockReason` is the SAME canonical rule the scan route, the bulk path
 * and the offline queue consult — it is pure and structural precisely so a client
 * can share it. This card therefore cannot disagree with the server about who is
 * admissible: it renders the refusal the server would give, before the operator
 * acts, and the server still decides.
 */
const BLOCK_COPY: Record<CheckInBlockReason, { title: string; detail: string }> = {
  CANCELLED: { title: 'Registration cancelled', detail: 'This registration was cancelled and cannot be checked in.' },
  PENDING:   { title: 'Not confirmed yet',      detail: 'This registration is still pending confirmation.' },
  REJECTED:  { title: 'Registration rejected',  detail: 'This registration was rejected and cannot be checked in.' },
  REFUNDED:  { title: 'Registration refunded',  detail: 'This registration was refunded and cannot be checked in.' },
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
  // The canonical rule, shared with the server. `paymentStatus` is present only on a
  // single resolved attendee — which is exactly when this card renders — so the
  // REFUNDED case is covered here too. A missing field simply cannot block.
  const blocked  = checkInBlockReason(attendee)
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
            {/* Payment state is shown only when it is NOT the ordinary case — an
                operator does not need to be told that a paid ticket was paid, but a
                complimentary or gate-collected one is worth seeing. */}
            {attendee.paymentStatus && attendee.paymentStatus !== 'paid' && (
              <Row label="Payment" value={attendee.paymentStatus.replace(/_/g, ' ')} />
            )}
            {detail?.eventName && <Row label="Event" value={detail.eventName} />}

            {/* ── Timing chip ──────────────────────────────────────────────
                RD-CHECKIN-2.0 — rendered ONLY when the event has timing enabled.
                The server omits `timingLabel` entirely for every other event, so a
                non-timing gate has nothing to render timing vocabulary from — the
                word cannot leak in through a null or a dash. The label itself is
                the organizer's configured wording, printed verbatim. */}
            {detail?.timingLabel && (
              <Row label={detail.timingLabel} value={detail.timingValue || 'Not assigned'} />
            )}

            {/* Registration-form answers — dynamic, labelled and ordered upstream. */}
            {detail?.answers.map(a => <Row key={a.fieldId} label={a.label} value={a.value} />)}
          </dl>

          {/* ── Ineligible ───────────────────────────────────────────────────
              Stated BEFORE the identifier block, because when an attendee cannot
              be admitted their bib is not the operator's next question. */}
          {blocked && (
            <div
              role="status"
              className="mt-4 flex items-start gap-3 rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3"
            >
              <Ban className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
              <div className="min-w-0">
                <p className="text-fs-sm font-semibold text-foreground">{BLOCK_COPY[blocked].title}</p>
                <p className="mt-0.5 text-fs-2xs text-muted-foreground">{BLOCK_COPY[blocked].detail}</p>
              </div>
            </div>
          )}

          {/* ── Identifier ───────────────────────────────────────────────────
              Hidden for a blocked attendee: "you will be asked for it next" is a
              promise this card must not make when there is no next step. */}
          {!blocked && (
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
          )}

          {attendee.checkedIn && (
            // The ORIGINAL time is the point of this banner: "already checked in"
            // is a question about when, and answering it here saves the operator
            // from having to ask anyone.
            <p role="status" className="mt-3 rounded-xl border border-warning/30 bg-warning/10 px-4 py-2.5 text-fs-sm text-foreground">
              Already checked in
              {attendee.checkedInAt && (() => {
                const d = new Date(attendee.checkedInAt)
                return Number.isNaN(d.getTime())
                  ? '.'
                  : ` at ${d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true })}.`
              })()}
            </p>
          )}
        </div>

        {/* ── Actions ──────────────────────────────────────────────────────
            An attendee who is ALREADY checked in is never offered check-in
            again — the card becomes a read-only record with, at most, the
            restricted undo. Whether that undo is actually permitted (their own
            check-in, inside the window) is decided by the server; offering the
            button is not a claim that it will succeed.

            RD-CHECKIN-QA-01: an INELIGIBLE attendee is likewise never offered an
            action. The card becomes a read-only record explaining why, so the
            refusal happens before the operator commits rather than after. */}
        <div className="flex gap-2 border-t border-border px-5 py-4">
          <button
            ref={blocked ? confirmRef : undefined}
            type="button" onClick={onCancel} disabled={busy}
            className="flex-1 rounded-xl border border-border px-4 py-2.5 text-fs-sm font-semibold text-foreground disabled:opacity-50"
          >
            {attendee.checkedIn || blocked ? 'Close' : 'Cancel'}
          </button>

          {blocked ? null : attendee.checkedIn ? (
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
