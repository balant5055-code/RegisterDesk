// RD-ATTENDEE-03A M2 — shared per-pass sales-window resolution.
//
// Pure + dependency-free (Intl only), so the SAME date-only, timezone-aware window
// logic the server gate enforces (lib/registrations/gate.ts) can also drive the
// attendee-facing display surfaces (ticket cards) without duplicating the rule or
// risking SSR/client drift (resolved once, server-side, into the pass payload).

export type PassSaleState = 'scheduled' | 'open' | 'ended'

/**
 * Today's date as 'YYYY-MM-DD' in the given IANA timezone. Falls back to UTC when the
 * zone is empty or unrecognised. (Extracted from gate.ts so both share one impl.)
 */
export function todayISOInTz(tz: string): string {
  const zone = tz || 'UTC'
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date())
  } catch {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date())
  }
}

/**
 * Whether a pass's sales window is scheduled (not started), open, or ended, given
 * today's date (YYYY-MM-DD) in the event timezone. Mirrors the gate's date-only
 * comparison (gate.ts §5) so the card state and the server gate never disagree.
 */
export function resolvePassSaleState(
  pass:     { salesStartDate?: string | null; salesEndDate?: string | null },
  todayISO: string,
): PassSaleState {
  const start = pass.salesStartDate?.trim()
  const end   = pass.salesEndDate?.trim()
  if (start && todayISO < start) return 'scheduled'
  if (end && todayISO > end)     return 'ended'
  return 'open'
}
