// RD-DASHBOARD-02 · Organizer daily rollups — the pure half.
//
// ═══ WHY THIS COLLECTION EXISTS ══════════════════════════════════════════════
// The dashboard's 90-day trend, today's numbers and month-to-date used to come from
// ONE query that read up to 5,000 registration documents on every dashboard open.
// Two problems, and the second is the serious one:
//
//   • COST — ~5,000 billed reads per organizer per page view, the single largest
//     read in the organizer portal. `.select()` trimmed the payload but not the bill.
//   • CORRECTNESS — above the cap the oldest in-window days silently undercount, and
//     the UI presented the result as "₹X collected in the last 30 days". A capped
//     sample stated as a total is the exact defect the Reports audit flagged (H-1).
//
// Raising the cap fixes neither. One document per organizer per day does: a 90-day
// trend becomes ~90 document reads in one `getAll`, and every figure is exact
// regardless of volume because it was counted at write time.
//
// ═══ WHAT IS PURE HERE ═══════════════════════════════════════════════════════
// Everything in this file. No Firebase import, so it runs in the repo's node-env
// vitest without booting the Admin SDK — the same split lib/team/types.ts uses.
// The Admin-SDK side lives in lib/dashboard/dailyStatsAdmin.ts.

/** Collection name. Server-only — see firestore.rules. */
export const DAILY_STATS_COLLECTION = 'organizerDailyStats'

/**
 * The reporting timezone for day bucketing.
 *
 * Fixed to IST rather than the server's zone or the browser's. An organizer in
 * Coimbatore asking "how many registered today?" means the Indian calendar day, and a
 * Vercel function running in UTC would put every registration after 18:30 IST into
 * "tomorrow" — so the dashboard would disagree with the organizer's own clock every
 * evening. RegisterDesk is India-first; when that stops being true this becomes a
 * per-organizer setting, and the bucketing is already isolated to this one function.
 */
export const REPORTING_TZ_OFFSET_MINUTES = 330   // UTC+05:30

/**
 * Bucket an instant into its organizer-local calendar day (YYYY-MM-DD).
 *
 * Deliberately NOT `toLocaleDateString` with a timezone: that depends on the host's
 * ICU data being present and correct, which differs between the Next.js server, the
 * emulator and CI. Fixed-offset arithmetic gives the same answer everywhere.
 */
export function dayKey(instant: Date | number): string {
  const ms = typeof instant === 'number' ? instant : instant.getTime()
  const shifted = new Date(ms + REPORTING_TZ_OFFSET_MINUTES * 60_000)
  const y = shifted.getUTCFullYear()
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0')
  const d = String(shifted.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/**
 * Sentinel event id for the WORKSPACE-wide row.
 *
 * A literal rather than a separate collection so both scopes share one write path,
 * one read path and one rule. `__all__` cannot collide with a Firestore-generated
 * event id (those are alphanumeric and never contain underscores).
 */
export const ALL_EVENTS = '__all__'

/**
 * Deterministic document id: `{organizerUid}__{eventId}__{YYYY-MM-DD}`.
 *
 * ═══ WHY THE EVENT DIMENSION EXISTS ══════════════════════════════════════════
 * The first cut keyed rollups on `{uid}_{day}` — workspace-wide only. That was
 * correct while the dashboard was workspace-wide, but the moment the dashboard scopes
 * to a selected event, a workspace-wide trend under an event heading is exactly the
 * "silently use workspace-level data for an event-specific chart" failure. There is
 * no way to derive one event's daily series from a workspace total, so the dimension
 * has to exist at write time.
 *
 * Two rows are written per registration change — one for the event, one for
 * `ALL_EVENTS` — in the SAME transaction as `registrationCounters`. Reading either
 * scope is then a `getAll` of computed ids: no query, no index, no cursor, and the
 * read cost is the number of DAYS requested regardless of registration volume.
 *
 * ═══ THE KEY IS THE EVENT SLUG, NOT THE DRAFT ID ════════════════════════════
 * A registration document carries `eventSlug` and NOT the eventDraft id, so the slug
 * is the only event identifier available at write time without an extra read inside
 * an already-contended transaction. The dashboard resolves draftId → slug from the
 * drafts it loads anyway, so the read side costs nothing either.
 *
 * Double underscores separate the parts so a uid or slug containing a single
 * underscore cannot produce an ambiguous id.
 */
export function dailyStatsDocId(organizerUid: string, eventId: string, day: string): string {
  return `${organizerUid}__${eventId}__${day}`
}

/** The inclusive list of day keys ending today, oldest → newest. */
export function dayKeyRange(endInstant: Date | number, days: number): string[] {
  const endMs = typeof endInstant === 'number' ? endInstant : endInstant.getTime()
  const out: string[] = []
  for (let i = days - 1; i >= 0; i--) out.push(dayKey(endMs - i * 86_400_000))
  return out
}

/** Stored shape. Every numeric field is written with FieldValue.increment. */
export interface DailyStatsDoc {
  organizerUid: string
  /** The event this row counts, or ALL_EVENTS for the workspace-wide row. */
  eventId:      string
  day:          string
  /** Net confirmed registrations that STARTED on this day. */
  confirmed:    number
  /** Cancellations recorded on this day (of a registration from any day). */
  cancelled:    number
  /** Confirmed revenue in paise attributed to this day. */
  revenuePaise: number
  /** Check-ins recorded on this day. */
  checkedIn:    number
  updatedAt:    unknown
}

/** Client-facing point, one per day, always present even for zero-activity days. */
export interface DailyStatsPoint {
  date:         string
  confirmed:    number
  cancelled:    number
  revenuePaise: number
  checkedIn:    number
}

/**
 * The delta a single registration state change contributes.
 *
 * Expressed as a value rather than applied inline so the rule is testable without a
 * database, and so every call site produces the same shape.
 */
export interface DailyStatsDelta {
  confirmed:    number
  cancelled:    number
  revenuePaise: number
  checkedIn:    number
}

export const ZERO_DELTA: DailyStatsDelta = { confirmed: 0, cancelled: 0, revenuePaise: 0, checkedIn: 0 }

/**
 * What each registration lifecycle transition contributes to its day bucket.
 *
 * ═══ THE ATTRIBUTION RULE, AND WHY ═══════════════════════════════════════════
 * A registration is counted on the day it was CREATED. A cancellation is counted on
 * the day it was CANCELLED, and it reverses the original day's confirmed count and
 * revenue.
 *
 * That reversal is why `cancel` carries the ORIGINAL day rather than today: if a
 * January registration is cancelled in March, January must stop claiming revenue it
 * no longer has, otherwise the trend chart and the revenue KPI would permanently
 * disagree with `registrationCounters`. The cancellation ITSELF is recorded on the
 * March bucket, so both questions — "what did January earn?" and "what happened in
 * March?" — stay answerable.
 */
export type RegistrationLifecycleAction =
  | 'confirm'            // a new confirmed registration (paid or free) — attributed to TODAY
  | 'reverse_confirm'    // undo of the above — attributed to the ORIGINAL day
  | 'record_cancel'      // the cancellation event itself — attributed to TODAY
  | 'restore'            // cancelled → confirmed (undo) — attributed to the ORIGINAL day
  | 'unrecord_cancel'    // undo of a recorded cancellation — attributed to TODAY
  | 'approve'            // pending → confirmed (manual approval) — attributed to TODAY
  | 'checkin'            // attendee scanned at the gate — TODAY
  | 'undo_checkin'

export interface LifecycleInput {
  action:       RegistrationLifecycleAction
  /**
   * Optional, and OMITTED for the check-in actions.
   *
   * Not merely a convenience: `app/api/checkin/scan/route.ts` is guarded by a test
   * asserting that the check-in transaction writes only attendance fields and never
   * touches money (`amount`, `paymentStatus`, `status`, `ticketCode`). Passing a
   * meaningless `amountPaise: 0` there put the word "amount" inside that transaction
   * for no reason. A check-in has no amount, so the field is simply absent.
   */
  amountPaise?: number
}

export function deltaFor(input: LifecycleInput): DailyStatsDelta {
  const raw = input.amountPaise ?? 0
  const amount = Number.isFinite(raw) ? raw : 0
  switch (input.action) {
    case 'confirm':
    case 'approve':
    case 'restore':
      return { confirmed: 1, cancelled: 0, revenuePaise: amount, checkedIn: 0 }
    case 'reverse_confirm':
      // Applied to the ORIGINAL day: that day stops claiming a registration and
      // revenue it no longer has.
      return { confirmed: -1, cancelled: 0, revenuePaise: -amount, checkedIn: 0 }
    case 'record_cancel':
      // Applied to TODAY: "a cancellation happened today" is its own fact.
      return { confirmed: 0, cancelled: 1, revenuePaise: 0, checkedIn: 0 }
    case 'unrecord_cancel':
      return { confirmed: 0, cancelled: -1, revenuePaise: 0, checkedIn: 0 }
    case 'checkin':
      return { confirmed: 0, cancelled: 0, revenuePaise: 0, checkedIn: 1 }
    case 'undo_checkin':
      return { confirmed: 0, cancelled: 0, revenuePaise: 0, checkedIn: -1 }
    default:
      return ZERO_DELTA
  }
}

/** True when a delta would write nothing — the caller can skip the write entirely. */
export function isNoOpDelta(d: DailyStatsDelta): boolean {
  return d.confirmed === 0 && d.cancelled === 0 && d.revenuePaise === 0 && d.checkedIn === 0
}

// ─── History completeness ─────────────────────────────────────────────────────

/**
 * Marks how far back the rollups can be trusted for one organizer.
 *
 * ═══ WHY THIS IS NOT OPTIONAL ════════════════════════════════════════════════
 * Rollups only exist from the moment the write path started maintaining them, plus
 * whatever the backfill has covered. A trend drawn over a period with no rollups
 * would render a flat line of zeros — indistinguishable from "nobody registered".
 *
 * That is the same lie the 5,000-cap told, in a new shape. So the API returns the
 * earliest trustworthy day and the UI states plainly that history before it is not
 * included, rather than drawing it as zero.
 */
export interface HistoryCoverage {
  /** Earliest day (YYYY-MM-DD) with trustworthy rollup data, or null when none. */
  since:    string | null
  /** True when the requested range starts before `since`. */
  partial:  boolean
}

export function resolveCoverage(requestedDays: string[], since: string | null): HistoryCoverage {
  if (!since) return { since: null, partial: requestedDays.length > 0 }
  const first = requestedDays[0]
  return { since, partial: Boolean(first && first < since) }
}

/**
 * Fills a day range from a sparse set of rollup docs.
 *
 * A missing document inside the covered window genuinely means "no activity that
 * day" — the write path only creates a document when something happened — so zero is
 * the honest value there. Outside coverage the caller must use `HistoryCoverage`
 * rather than reading these zeros as fact.
 */
export function buildSeries(days: string[], byDay: Map<string, DailyStatsPoint>): DailyStatsPoint[] {
  return days.map(date => byDay.get(date) ?? {
    date, confirmed: 0, cancelled: 0, revenuePaise: 0, checkedIn: 0,
  })
}

/** Sum a series. Used for range totals and for the previous-period comparison. */
export function sumSeries(series: DailyStatsPoint[]): { confirmed: number; revenuePaise: number; checkedIn: number } {
  return series.reduce(
    (acc, p) => ({
      confirmed:    acc.confirmed + p.confirmed,
      revenuePaise: acc.revenuePaise + p.revenuePaise,
      checkedIn:    acc.checkedIn + p.checkedIn,
    }),
    { confirmed: 0, revenuePaise: 0, checkedIn: 0 },
  )
}
