// RD-BCAST-DATE-01 · THE one definition of a broadcast's registration-date audience.
//
// Preview, creation and delivery all resolve the window through this module. That is not
// tidiness — it is the parity guarantee. Three copies of "which day did they mean" would
// eventually disagree, and the organizer would be billed for one audience and mail another.
//
// Pure and client-safe: no firebase-admin, no adminDb, no I/O. The composer imports the
// types and labels; the routes import the resolver. Timezone RESOLUTION (which needs
// Firestore) lives in resolveBroadcastTimezone.ts — deliberately not here.

import { zonedDayRange, shiftISODate, isValidISODate } from '@/lib/registrations/zonedDayRange'

export type RegistrationDateFilterType = 'all' | 'today' | 'yesterday' | 'date' | 'range'

/** What the composer sends. `all` is the default and means "no filter at all". */
export interface RegistrationDateFilterInput {
  type:  RegistrationDateFilterType
  date?: string | null   // 'date'  — YYYY-MM-DD
  from?: string | null   // 'range' — YYYY-MM-DD
  to?:   string | null   // 'range' — YYYY-MM-DD, INCLUSIVE as the organizer means it
}

/**
 * A resolved, absolute audience window.
 *
 * `startUtc`/`endUtcExclusive` are what the Firestore query uses. `fromISO`/`toISO`/
 * `timezone` are kept so a persisted campaign can be explained — and re-derived — later
 * without anyone having to know what "today" meant on the day it was created.
 */
/**
 * The two instants the Firestore query actually needs. Separated from the descriptive
 * fields so `send.ts` can rebuild them from the PERSISTED Timestamps without inventing a
 * label or a timezone it has no business re-deriving.
 */
export interface RegistrationDateBounds {
  startUtc:        Date
  /** EXCLUSIVE. Never an end-of-day instant. */
  endUtcExclusive: Date
}

export interface RegistrationDateWindow extends RegistrationDateBounds {
  timezone:        string
  fromISO:         string
  toISO:           string   // inclusive last day
  label:           string
}

/** Persisted alongside the campaign, for display and audit. */
export interface RegistrationDateFilterRecord {
  type:     Exclude<RegistrationDateFilterType, 'all'>
  label:    string
  timezone: string
  fromISO:  string
  toISO:    string
  /**
   * How many registrations in this audience had no usable `registeredAt` and were therefore
   * unreachable by the filter, as counted at creation.
   *
   * Persisted rather than merely shown, because the warning in the composer disappears the
   * moment the campaign is sent. Afterwards this is the only record that the campaign's
   * audience was smaller than "everyone who registered that day" — without it, the history
   * row would quietly imply complete coverage.
   *
   * `null` means the diagnostic could not run — NOT zero. Zero asserts that every
   * registration in the audience was date-filterable; null admits we never found out.
   */
  undatedExcluded: number | null
}

export type RegistrationDateFilterError =
  | 'invalid_type'
  | 'invalid_date'
  | 'invalid_timezone'
  | 'start_after_end'
  | 'missing_date'

const TYPES: RegistrationDateFilterType[] = ['all', 'today', 'yesterday', 'date', 'range']

/**
 * Validates a client payload into a filter input. SERVER-SIDE validation is the point:
 * the browser proposes a date, it never decides the window.
 */
export function parseRegistrationDateFilter(
  raw: unknown,
): { ok: true; value: RegistrationDateFilterInput } | { ok: false; error: RegistrationDateFilterError } {
  // Absent ⇒ 'all'. This is what keeps every existing caller and every existing campaign
  // behaving exactly as before.
  if (raw === undefined || raw === null) return { ok: true, value: { type: 'all' } }
  if (typeof raw !== 'object') return { ok: false, error: 'invalid_type' }

  const r    = raw as Record<string, unknown>
  const type = r.type
  if (typeof type !== 'string' || !TYPES.includes(type as RegistrationDateFilterType)) {
    return { ok: false, error: 'invalid_type' }
  }

  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)

  if (type === 'date') {
    const date = str(r.date)
    if (!date) return { ok: false, error: 'missing_date' }
    if (!isValidISODate(date)) return { ok: false, error: 'invalid_date' }
    return { ok: true, value: { type: 'date', date } }
  }

  if (type === 'range') {
    const from = str(r.from)
    const to   = str(r.to)
    if (!from || !to) return { ok: false, error: 'missing_date' }
    if (!isValidISODate(from) || !isValidISODate(to)) return { ok: false, error: 'invalid_date' }
    return { ok: true, value: { type: 'range', from, to } }
  }

  return { ok: true, value: { type: type as RegistrationDateFilterType } }
}

const DAY_FMT = new Intl.DateTimeFormat('en-GB', {
  // timeZone UTC because fromISO/toISO are plain calendar dates, not instants — formatting
  // them in a real zone could shift the printed day.
  day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
})
const humanDay = (iso: string) => DAY_FMT.format(new Date(`${iso}T00:00:00Z`))

/**
 * Resolves a filter input into an absolute window.
 *
 * `todayISO` is a PARAMETER, not read from the clock inside. Two reasons: the function
 * stays pure and testable at any boundary, and — the important one — the caller is forced
 * to state which day it means, in a named timezone, at the moment of creation. That is the
 * mechanism that stops "today" from being re-interpreted at delivery time.
 *
 * Returns `window: null` for `all`, meaning no constraint is added anywhere downstream.
 */
export function resolveRegistrationDateWindow(
  input:    RegistrationDateFilterInput,
  timezone: string,
  todayISO: string,
): { ok: true; window: RegistrationDateWindow | null } | { ok: false; error: RegistrationDateFilterError } {
  if (input.type === 'all') return { ok: true, window: null }

  let fromISO: string
  let toISO:   string

  switch (input.type) {
    case 'today':     fromISO = toISO = todayISO; break
    case 'yesterday': fromISO = toISO = shiftISODate(todayISO, -1); break
    case 'date':
      if (!input.date) return { ok: false, error: 'missing_date' }
      fromISO = toISO = input.date
      break
    case 'range':
      if (!input.from || !input.to) return { ok: false, error: 'missing_date' }
      fromISO = input.from
      toISO   = input.to
      break
    default:
      return { ok: false, error: 'invalid_type' }
  }

  const r = zonedDayRange(fromISO, toISO, timezone)
  if (!r.ok) return { ok: false, error: r.error }

  return {
    ok: true,
    window: {
      startUtc:        r.range.startUtc,
      endUtcExclusive: r.range.endUtcExclusive,
      timezone:        r.range.timezone,
      fromISO,
      toISO,
      label: fromISO === toISO ? humanDay(fromISO) : `${humanDay(fromISO)} – ${humanDay(toISO)}`,
    },
  }
}

/** The record persisted on the campaign document. `all` persists nothing — see below. */
export function toFilterRecord(
  input:  RegistrationDateFilterInput,
  window: RegistrationDateWindow,
  undatedExcluded: number | null = 0,
): RegistrationDateFilterRecord {
  return {
    type:     input.type === 'all' ? 'date' : input.type,
    label:    window.label,
    timezone: window.timezone,
    fromISO:  window.fromISO,
    toISO:    window.toISO,
    undatedExcluded,
  }
}

/**
 * Adds the registration-date constraint to an audience query.
 *
 * THIS IS THE SAFETY-CRITICAL FUNCTION. The range must reach Firestore as a `where`, so
 * that `.limit(cap + 1)` downstream bounds the FILTERED set. The audience query carries no
 * orderBy and is therefore limited in document-ID order; filtering in memory after that
 * limit would, on any event larger than the cap, quietly return a fraction of the matching
 * registrations and look entirely plausible doing it.
 *
 * A null window returns the query untouched — byte-identical to the behaviour before this
 * feature existed.
 *
 * Typed structurally so this module stays free of firebase-admin and can be imported from
 * the browser alongside the rest of the filter model.
 */
export function applyRegistrationDateRange<Q extends {
  where(field: string, op: '>=' | '<', value: Date): Q
}>(query: Q, bounds: RegistrationDateBounds | null): Q {
  if (!bounds) return query
  return query
    .where('registeredAt', '>=', bounds.startUtc)
    .where('registeredAt', '<',  bounds.endUtcExclusive)
}

/**
 * Rebuilds the query bounds from what was PERSISTED on the campaign document.
 *
 * This is the delivery-side counterpart of `resolveRegistrationDateWindow`, and the fact
 * that it takes no timezone and no "today" is the point: at send time there is nothing
 * left to interpret. A campaign created on 20 Aug carries 20 Aug's instants, and the cron
 * running on 21 Aug can only reproduce the same audience.
 *
 * Accepts a Firestore Timestamp (anything with `toDate()`) or a Date. Returns null unless
 * BOTH bounds are present and valid — a half-written pair would silently widen the
 * audience to one open-ended side, so it is treated as no filter rather than half a one.
 */
export function persistedDateBounds(from: unknown, to: unknown): RegistrationDateBounds | null {
  const asDate = (v: unknown): Date | null => {
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v
    if (v && typeof (v as { toDate?: () => Date }).toDate === 'function') {
      const d = (v as { toDate: () => Date }).toDate()
      return d instanceof Date && !Number.isNaN(d.getTime()) ? d : null
    }
    return null
  }

  const startUtc        = asDate(from)
  const endUtcExclusive = asDate(to)
  if (!startUtc || !endUtcExclusive) return null
  return { startUtc, endUtcExclusive }
}

/**
 * Bounds used to count registrations that HAVE a usable `registeredAt`.
 *
 * Firestore omits documents missing a field from that field's index, so a range query
 * cannot see them — they vanish from a date-filtered audience with no error and no row.
 * Counting the ones that ARE indexable is how we learn the size of that blind spot.
 *
 * The upper bound matters: Firestore orders by TYPE before value, and strings sort above
 * timestamps, so `>= epoch` alone would also match a `registeredAt` that is a string (which
 * `extraFields` could theoretically produce). Bounding above keeps the count to real
 * Timestamps.
 */
export const DATED_LOWER_BOUND = new Date(0)
export const DATED_UPPER_BOUND = new Date('3000-01-01T00:00:00.000Z')
