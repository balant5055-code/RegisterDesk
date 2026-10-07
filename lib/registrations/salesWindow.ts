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
 * RD-CE-FIX (sales window) — the current local date-time 'YYYY-MM-DDTHH:mm' in the given IANA timezone
 * (UTC when the zone is empty or unrecognised).
 */
export function nowLocalInTz(tz: string, now: Date = new Date()): string {
  const fmt = (zone: string) => {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(now)
    const get = (t: string) => parts.find(p => p.type === t)?.value ?? '00'
    return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`
  }
  try { return fmt(tz || 'UTC') } catch { return fmt('UTC') }
}

/**
 * RD-CE-FIX (sales window) — a window bound as a sortable local 'YYYY-MM-DDTHH:mm'. Pass sales and
 * registration windows are stored either date-only ('YYYY-MM-DD') or as datetime-local
 * ('YYYY-MM-DDTHH:mm'). They used to be compared as raw strings against a date-only "today", so a
 * datetime start opened sales a DAY late ('2026-10-05' < '2026-10-05T09:00') and a datetime end was
 * ignored until midnight. A date-only start means 00:00, a date-only end means 23:59 (inclusive).
 */
export function windowKey(value: string, edge: 'start' | 'end'): string {
  const v = value.trim()
  return v.length > 10 ? v.slice(0, 16) : `${v}T${edge === 'start' ? '00:00' : '23:59'}`
}

/**
 * Whether a pass's sales window is scheduled (not started), open, or ended at `nowLocal`
 * (nowLocalInTz(eventTz)). Shared with the gate (gate.ts §5) so the card state and the server gate
 * never disagree. A date-only `nowLocal` (legacy callers) is read as the start of that day.
 */
export function resolvePassSaleState(
  pass:     { salesStartDate?: string | null; salesEndDate?: string | null },
  nowLocal: string,
): PassSaleState {
  const now   = windowKey(nowLocal, 'start')
  const start = pass.salesStartDate?.trim()
  const end   = pass.salesEndDate?.trim()
  if (start && now < windowKey(start, 'start')) return 'scheduled'
  if (end && now > windowKey(end, 'end'))       return 'ended'
  return 'open'
}
