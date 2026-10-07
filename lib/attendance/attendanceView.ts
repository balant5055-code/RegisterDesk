// RD-EVENT-11 · Attendance, as pure functions.
//
// ═══ WHY THIS MODULE EXISTS ══════════════════════════════════════════════════
// The attendance tab used to compute everything inline: the rate, the labels, the
// hour buckets, the "remaining" figure. Three consequences, all of which this file
// removes:
//
//   • `attendanceRate` was `confirmed > 0 ? round(checkedIn / confirmed * 100) : 0`,
//     so an event whose counters could not be read, and an event with genuinely no
//     confirmed registrations, BOTH rendered "0%" — stated as a measurement.
//   • The identifier column was labelled "BIB". RegisterDesk is not a marathon
//     platform: the organizer configures that label, and a conference calls it
//     "Delegate ID". The label is DATA, and it lives here as such.
//   • None of it could be tested without a browser.
//
// Pure — no I/O, no React, no Firestore. Safe to import from the route AND the tab,
// which is what keeps the server's numbers and the client's words from diverging.

import { localDayStartUtc, localDateKey } from '@/lib/events/registrationTrend'

/** The em dash every RegisterDesk surface uses for "we could not read this". */
export const UNAVAILABLE = '—'

// ─── Hour ranges ──────────────────────────────────────────────────────────────

export interface HourRange {
  /** "HH:00" in the EVENT's timezone — the bucket key. */
  hour:  string
  /** "9 AM" — what a human reads. */
  label: string
  start: Date
  end:   Date
}

export function hourLabel(h: number): string {
  if (h === 0)  return '12 AM'
  if (h < 12)   return `${h} AM`
  if (h === 12) return '12 PM'
  return `${h - 12} PM`
}

/**
 * The elapsed hours of TODAY in the event's own timezone, as half-open [start, end)
 * ranges — oldest first.
 *
 * Two defects this replaces. The old chart bucketed on `new Date(iso).getHours()`,
 * which is the SERVER's local hour, so a check-in at 09:30 in Chennai landed in the
 * 04:00 bucket of a UTC server. And its window was "the newest 1000 check-ins",
 * regardless of day — so on a large event the "hourly" chart silently mixed several
 * days into the same 24 buckets.
 *
 * Bounded to 24 by construction: a day cannot have more elapsed hours than it has.
 */
export function todayHourRanges(now: Date, timeZone: string): HourRange[] {
  const dayStart = localDayStartUtc(now, timeZone)
  const elapsed  = Math.floor((now.getTime() - dayStart.getTime()) / 3_600_000) + 1
  const count    = Math.max(1, Math.min(24, elapsed))

  const out: HourRange[] = []
  for (let h = 0; h < count; h++) {
    const start = new Date(dayStart.getTime() + h * 3_600_000)
    const end   = new Date(start.getTime() + 3_600_000)
    out.push({ hour: `${String(h).padStart(2, '0')}:00`, label: hourLabel(h), start, end })
  }
  return out
}

/** The event-timezone date the hour ranges belong to, as `YYYY-MM-DD`. */
export function hourRangeDate(now: Date, timeZone: string): string {
  return localDateKey(now, timeZone)
}

// ─── The honest metrics ───────────────────────────────────────────────────────

export interface AttendanceCounts {
  confirmed: number
  checkedIn: number
  cancelled: number
  pending:   number
  total:     number
}

export interface AttendanceMetric {
  /** Ready to render. `UNAVAILABLE` when there is no authoritative figure. */
  text:        string
  /** A short qualifier, or null when none is honest. */
  sub:         string | null
  unavailable: boolean
}

const n = (v: number) => v.toLocaleString('en-IN')

/**
 * Checked in / remaining / rate — the three figures Attendance owns.
 *
 * `statsUnavailable` is the ONLY thing that produces "—". A real zero stays a zero,
 * because "nobody has arrived yet" is a fact an organizer needs at 5 a.m. and is not
 * the same fact as "we could not count".
 */
export function attendanceMetrics(
  counts: AttendanceCounts | null,
  statsUnavailable: boolean,
): { checkedIn: AttendanceMetric; remaining: AttendanceMetric; rate: AttendanceMetric } {
  if (statsUnavailable || !counts) {
    const un = (): AttendanceMetric => ({ text: UNAVAILABLE, sub: null, unavailable: true })
    return { checkedIn: un(), remaining: un(), rate: un() }
  }

  const remaining = Math.max(0, counts.confirmed - counts.checkedIn)
  return {
    checkedIn: {
      text: n(counts.checkedIn),
      sub:  counts.confirmed > 0 ? `of ${n(counts.confirmed)} confirmed` : 'no confirmed registrations yet',
      unavailable: false,
    },
    remaining: {
      text: n(remaining),
      // The caller renders "<label> · <sub>", so a sub that restates the label reads
      // as "Yet to arrive · Yet to arrive". It only ever ADDS something.
      sub:  remaining === 0 && counts.confirmed > 0 ? 'everyone has arrived' : null,
      unavailable: false,
    },
    rate: {
      // A percentage of nothing is not 0% — it is undefined, and saying "0%" invites
      // an organizer to read a healthy pre-event morning as a failure.
      text: counts.confirmed > 0 ? `${Math.round((counts.checkedIn / counts.confirmed) * 100)}%` : UNAVAILABLE,
      sub:  counts.confirmed > 0 ? null : 'needs confirmed registrations',
      unavailable: counts.confirmed === 0,
    },
  }
}

/** The progress-bar fill, or null when there is nothing authoritative to draw. */
export function attendancePercent(
  counts: AttendanceCounts | null,
  statsUnavailable: boolean,
): number | null {
  if (statsUnavailable || !counts || counts.confirmed <= 0) return null
  return Math.min(100, Math.round((counts.checkedIn / counts.confirmed) * 100))
}

// ─── Bars ─────────────────────────────────────────────────────────────────────

/**
 * A bar's height as a percentage of the tallest bar.
 *
 * `null` in, `null` out — an hour that could not be counted must render as a gap,
 * never as a zero-height bar, because a zero-height bar reads as "nobody arrived".
 */
export function hourBarPercent(count: number | null, peak: number): number | null {
  if (count === null) return null
  if (peak <= 0) return 0
  return Math.round((count / peak) * 100)
}

export interface HourlyView {
  peak:     number
  total:    number | null   // null when ANY hour is unreadable — a partial sum is a lie
  allZero:  boolean
  partial:  boolean         // at least one hour could not be counted
}

export function hourlyView(buckets: { count: number | null }[]): HourlyView {
  const known   = buckets.filter(b => b.count !== null).map(b => b.count as number)
  const partial = known.length !== buckets.length
  return {
    peak:    known.length ? Math.max(...known) : 0,
    total:   partial ? null : known.reduce((a, b) => a + b, 0),
    allZero: known.length > 0 && known.every(c => c === 0),
    partial,
  }
}

// ─── Event-type vocabulary ────────────────────────────────────────────────────

/**
 * What this event calls the thing it issues to a participant.
 *
 * RegisterDesk supports marathons, conferences, expos, awards nights and more, and
 * the organizer NAMES this field in Setup — "Bib Number", "Delegate ID", "Visitor
 * Pass". Never hardcode "BIB": on a conference it is simply wrong, and on an event
 * that issues nothing there is no column at all.
 */
export function identifierColumnLabel(
  identifierEnabled: boolean,
  identifierLabel: string | null,
): string | null {
  if (!identifierEnabled) return null
  const trimmed = (identifierLabel ?? '').trim()
  return trimmed || null
}

/**
 * What this event calls the people attending it.
 *
 * Deliberately conservative: everything that is not clearly a competitive sport is a
 * "participant", which is correct everywhere and wrong nowhere. The alternative —
 * inventing a word per event type — produces "runner" on an awards night.
 */
export function participantNoun(eventType: string | null | undefined): { one: string; many: string } {
  return eventType === 'sports'
    ? { one: 'participant', many: 'participants' }
    : { one: 'attendee',    many: 'attendees'    }
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

/**
 * Whether this event accepts check-ins, and what to say when it does not.
 *
 * This MIRRORS `lib/checkin/eventStatus.ts` — the server's rule, which every check-in
 * route already enforces. It is duplicated here as WORDS, never as a second decision:
 * the server refuses regardless, and this only decides whether to offer a button that
 * would certainly fail. Keep the set identical to ACCEPTING_STATUSES.
 */
export const CHECKIN_LIFECYCLE_STATES = ['published', 'registration_closed', 'completed'] as const

export type AttendanceGate =
  | { accepts: true }
  | { accepts: false; title: string; body: string }

export function attendanceGate(
  lifecycleStatus: string | null | undefined,
  eventType?: string | null,
): AttendanceGate {
  const noun = participantNoun(eventType)
  const ls   = lifecycleStatus ?? ''

  if ((CHECKIN_LIFECYCLE_STATES as readonly string[]).includes(ls)) return { accepts: true }

  switch (ls) {
    case 'draft':
    case 'pending_review':
    case 'changes_requested':
      return {
        accepts: false,
        title:   'Attendance starts once this event is published',
        body:    `Nobody can register yet, so there is no one to check in. Publish the event to open registration and attendance.`,
      }
    case 'unpublished':
      return {
        accepts: false,
        title:   'This event is unpublished',
        body:    `Check-in is closed while the event is hidden. Any attendance already recorded is kept.`,
      }
    case 'cancelled':
      return {
        accepts: false,
        title:   'This event is cancelled',
        body:    `Check-in is closed. Attendance recorded before the cancellation is kept for your records.`,
      }
    case 'archived':
      return {
        accepts: false,
        title:   'This event is archived',
        body:    `Check-in is closed. Attendance is read-only from here.`,
      }
    default:
      return {
        accepts: false,
        title:   'Check-in is not available',
        body:    `This event is not in a state that accepts ${noun.many}. Attendance already recorded is unchanged.`,
      }
  }
}

/** `completed` still accepts check-ins, but the framing is historical, not live. */
export function isLiveAttendance(lifecycleStatus: string | null | undefined): boolean {
  return lifecycleStatus === 'published' || lifecycleStatus === 'registration_closed'
}

// ─── One row, from either source ──────────────────────────────────────────────

/**
 * The roll call has TWO sources and one row shape.
 *
 * Browsing uses `/registrations`, which filters and paginates server-side over the
 * whole set. Searching uses `/checkin/search`, because `/registrations?q=` is an
 * EXACT lookup — it matches a ticket code or an email and nothing else. Browser QA
 * caught what that means in practice: "Bartholomew" satisfies the route's
 * `^[a-z0-9]{6,}$` ticket-code heuristic, so a real attendee's name was uppercased,
 * looked up as a code, and reported as "no one matches"; and a Tamil name matched
 * neither heuristic, fell through to the unfiltered page, and returned EVERYONE as
 * though they were all results.
 *
 * `/checkin/search` already does name/email/phone matching server-side, is already
 * gated on the same `checkin` permission and the same lifecycle rule, and is what the
 * gate screen uses. Reusing it is why this shape exists.
 */
export interface AttendanceRow {
  id:           string
  name:         string
  ticketCode:   string
  passName:     string
  status:       string
  paymentStatus: string | null
  checkedIn:    boolean
  checkedInAt:  string | null
  identifier:   string | null
}

export function rowFromRegistration(r: {
  id: string
  attendee?: { name?: string } | null
  ticketCode?: string | null
  passName?: string | null
  status?: string | null
  paymentStatus?: string | null
  checkedIn?: boolean | null
  checkedInAt?: string | null
  identifier?: { value?: string | null } | null
}): AttendanceRow {
  return {
    id:            r.id,
    name:          r.attendee?.name ?? '',
    ticketCode:    r.ticketCode ?? '',
    passName:      r.passName ?? '',
    status:        r.status ?? '',
    paymentStatus: r.paymentStatus ?? null,
    checkedIn:     Boolean(r.checkedIn),
    checkedInAt:   r.checkedInAt ?? null,
    identifier:    r.identifier?.value ?? null,
  }
}

export function rowFromSearchResult(r: {
  id: string
  attendeeName?: string | null
  ticketCode?: string | null
  passName?: string | null
  status?: string | null
  checkedIn?: boolean | null
  checkedInAt?: string | null
}): AttendanceRow {
  return {
    id:            r.id,
    name:          r.attendeeName ?? '',
    ticketCode:    r.ticketCode ?? '',
    passName:      r.passName ?? '',
    status:        r.status ?? '',
    // The search route does not return paymentStatus. Left null rather than guessed:
    // `rowAction` then falls through to the server, which owns the refunded rule.
    paymentStatus: null,
    checkedIn:     Boolean(r.checkedIn),
    checkedInAt:   r.checkedInAt ?? null,
    identifier:    null,
  }
}

/** Search runs on the server; two characters is the route's own minimum. */
export const SEARCH_MIN_CHARS = 2

export function shouldSearch(q: string): boolean {
  return q.trim().length >= SEARCH_MIN_CHARS
}

// ─── Row-level state ──────────────────────────────────────────────────────────

export type RowAction =
  | { kind: 'check-in' }
  | { kind: 'undo' }
  | { kind: 'blocked'; reason: string }

/**
 * What action a row offers.
 *
 * The blocking rules are NOT re-derived here — they mirror
 * `lib/registrations/checkinEligibility.ts`, the one canonical rule every check-in
 * entry point consults. This turns its reason code into a sentence; the server still
 * refuses independently.
 */
export function rowAction(
  reg: { status: string; paymentStatus?: string | null; checkedIn: boolean },
  gateAccepts: boolean,
): RowAction {
  if (!gateAccepts) return { kind: 'blocked', reason: 'Check-in is closed for this event' }
  if (reg.checkedIn) return { kind: 'undo' }
  if (reg.status === 'cancelled')       return { kind: 'blocked', reason: 'Registration cancelled' }
  if (reg.status === 'pending')         return { kind: 'blocked', reason: 'Awaiting approval' }
  if (reg.status === 'rejected')        return { kind: 'blocked', reason: 'Registration rejected' }
  if (reg.paymentStatus === 'refunded') return { kind: 'blocked', reason: 'Payment refunded' }
  return { kind: 'check-in' }
}

// ─── Filters ──────────────────────────────────────────────────────────────────

export type AttendanceFilter = 'all' | 'in' | 'out'

export function isAttendanceFilter(v: string | null | undefined): v is AttendanceFilter {
  return v === 'all' || v === 'in' || v === 'out'
}

/**
 * The query the list filter becomes.
 *
 * Both directions are SERVER-side: `checkedIn` is stored on every registration and the
 * (organizerUid, eventSlug, checkedIn, registeredAt) composite already exists, so
 * "not checked in" paginates over the whole set rather than filtering a page in the
 * browser — which is what would make it wrong past the first 50 rows.
 */
export function filterParam(f: AttendanceFilter): string | null {
  if (f === 'in')  return 'yes'
  if (f === 'out') return 'no'
  return null
}

export function filterEmptyMessage(f: AttendanceFilter, hasQuery: boolean, noun: { many: string }): string {
  if (hasQuery)    return 'No one matches this search.'
  if (f === 'in')  return `No ${noun.many} have checked in yet.`
  if (f === 'out') return `Every confirmed ${noun.many.replace(/s$/, '')} has checked in.`
  return `No ${noun.many} yet.`
}

// ─── Time ─────────────────────────────────────────────────────────────────────

/** "14:32" in the EVENT's timezone — the only clock that means anything at a gate. */
export function checkInClock(iso: string | null, timeZone: string): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone, hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(d)
  } catch {
    return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false }).format(d)
  }
}

/** "4m ago" — relative to a clock the CALLER owns, so render stays pure. */
export function sinceLabel(iso: string | null, now: number): string | null {
  if (!iso) return null
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return null
  const secs = Math.floor((now - t) / 1000)
  if (secs < 0)    return 'just now'
  if (secs < 60)   return `${secs}s ago`
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`
  return `${Math.floor(secs / 86400)}d ago`
}
