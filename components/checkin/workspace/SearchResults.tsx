'use client'

// RD-CHECKIN-2.0 — the lookup result list.
//
// ═══ AN AMBIGUOUS NAME IS NEVER RESOLVED FOR THE OPERATOR ════════════════════
// Two rows are two rows. Nothing here auto-selects, and a single result is still
// presented as a row to choose — because "one match" and "the right person" are not
// the same claim, and the cost of the difference is admitting a stranger. Selecting
// a row RESOLVES it (a read); the admission happens one deliberate step later.
//
// ═══ WHAT EACH ROW SAYS, AND WHY ═════════════════════════════════════════════
// Name, then the identifier and category, then check-in state. That is the order an
// operator disambiguates in: they are holding a printed bib or looking at a ticket,
// and two people called Arun Kumar are told apart by the number, not by the email.
// The identifier arrives on the row from the same document the row came from, so
// showing it costs no extra query.

import { Ban, CheckCircle2, ChevronRight, Loader2, SearchX } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { checkInBlockReason, type CheckInBlockReason } from '@/lib/registrations/checkinEligibility'
import type { AttendeeSearchResult } from '@/app/api/organizer/events/[eventId]/checkin/search/route'

/**
 * RD-CHECKIN-QA-01 — an ineligible attendee is labelled ON THE ROW.
 *
 * Browser QA showed an operator being led into a cancelled registration and only
 * discovering it on the confirm step. The card now refuses (see
 * AttendeeConfirmation), and the row says so first, so the dead end is visible
 * before it is entered. Same canonical rule on both surfaces.
 *
 * `paymentStatus` is deliberately absent from list rows — it is attached only to a
 * single resolved attendee — so REFUNDED cannot show here. That is the privacy
 * boundary working as intended: the card catches it a moment later.
 */
const ROW_BLOCK_LABEL: Record<CheckInBlockReason, string> = {
  CANCELLED: 'Cancelled',
  PENDING:   'Not confirmed',
  REJECTED:  'Rejected',
  REFUNDED:  'Refunded',
}

interface Props {
  results:   AttendeeSearchResult[]
  /** The event's own word for its identifier ("Bib Number", "Delegate ID"). */
  identifierLabel: string
  searching: boolean
  /** True once a query has actually been run — distinguishes "empty" from "not yet". */
  searched:  boolean
  /** The server's honest sentence about what this search could not see. */
  notice:    string | null
  truncated: boolean
  busy:      boolean
  onSelect:  (row: AttendeeSearchResult) => void
}

export default function SearchResults({
  results, identifierLabel, searching, searched, notice, truncated, busy, onSelect,
}: Props) {
  if (searching) {
    return (
      <p className="flex items-center gap-2 py-6 text-fs-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        Searching…
      </p>
    )
  }

  if (searched && results.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-border px-5 py-8 text-center">
        <SearchX className="size-6 text-muted-foreground" aria-hidden />
        <p className="text-fs-sm font-semibold text-foreground">No one found</p>
        {/* The server's own explanation, never a guess made here. */}
        <p className="max-w-sm text-fs-sm text-muted-foreground">
          {notice ?? 'Check the spelling, or try a ticket code, email address or phone number.'}
        </p>
      </div>
    )
  }

  if (results.length === 0) return null

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-fs-2xs uppercase tracking-wider text-muted-foreground" aria-live="polite">
          {results.length} {results.length === 1 ? 'match' : 'matches'}
          {truncated && ' (showing the first page)'}
        </p>
      </div>

      {/* Shown alongside RESULTS too, not only on an empty list: an operator who
          gets three hits still needs to know a surname would not have matched. */}
      {notice && <p className="text-fs-2xs text-muted-foreground">{notice}</p>}

      <ul className="flex flex-col gap-2">
        {results.map(r => (
          <li key={r.id}>
            <button
              type="button"
              onClick={() => onSelect(r)}
              disabled={busy}
              className="group flex w-full items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 text-left transition-colors hover:border-primary/50 focus-visible:border-primary disabled:opacity-50"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-fs-md font-semibold text-foreground">{r.attendeeName}</p>
                <p className="mt-0.5 truncate text-fs-2xs text-muted-foreground">
                  {r.identifierValue && (
                    <span className="font-semibold text-foreground">
                      {identifierLabel} {r.identifierValue}
                    </span>
                  )}
                  {r.identifierValue && r.passName && ' · '}
                  {r.passName}
                  {r.ticketCode && <> · <span className="font-mono">{r.ticketCode}</span></>}
                </p>
              </div>

              {/* State is a word plus an icon — never colour on its own. */}
              {(() => {
                const blocked = checkInBlockReason(r)
                return (
                  <span
                    className={cn(
                      'inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-fs-2xs font-semibold',
                      blocked      ? 'bg-destructive/10 text-destructive'
                      : r.checkedIn ? 'bg-success/10 text-success'
                                    : 'bg-muted text-muted-foreground',
                    )}
                  >
                    {blocked && <Ban className="size-3" aria-hidden />}
                    {!blocked && r.checkedIn && <CheckCircle2 className="size-3" aria-hidden />}
                    {blocked ? ROW_BLOCK_LABEL[blocked] : r.checkedIn ? 'Checked in' : 'Not checked in'}
                  </span>
                )
              })()}
              <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
