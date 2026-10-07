// RD-EVENT-17 · everything the Conference workspace needs to SAY, with no Firestore and
// no clock of its own.
//
// PURE. Vitest runs it in the node environment with no emulator, and the tab imports the
// same functions the tests pin — so a rule cannot exist in only one of them.
//
// ═══ WHAT THIS FIXES ═════════════════════════════════════════════════════════
//
// 1. TIME WAS THE BROWSER'S. `fmtTime` and `dayKey` formatted with `en-IN` and no
//    timeZone, so an organiser working from a different country read the agenda against
//    their own clock: a 9am Chennai session showed as the previous day's 11:30pm. Every
//    formatter here takes the EVENT's timezone.
//
// 2. "0% NO-SHOW" FOR AN EMPTY SESSION. `registeredCount > 0 ? … : 0` printed a
//    confident zero for a session nobody had registered for. A percentage of nothing is
//    not zero, it is absent.
//
// 3. CANCELLED SESSIONS VANISHED. The tab filtered to `status === 'published'` and never
//    showed the rest, so cancelling made a row disappear with no trace — and the empty
//    state then said "No sessions yet" about an event that had several. `status` is a
//    first-class filter here, and "all cancelled" is its own sentence.
//
// ═══ NO EVENT-TYPE ASSUMPTIONS ═══════════════════════════════════════════════
// An agenda is not a conference-only idea: workshops run tracks, cultural events run
// stages, sports events run briefings and ceremonies. Nothing here reads `eventType`, and
// the vocabulary (session / track / hall / speaker) is the data model's own, not a
// vertical's.

import type { ScheduleBundle, SessionView, EventTrackDoc, EventHallDoc, EventSpeakerDoc } from './types'

/** The one glyph for "we could not read this", shared with passes, coupons, waitlist. */
export const UNAVAILABLE = '—'

// ─── Time, in the EVENT's zone ────────────────────────────────────────────────

/** Guards an unknown IANA zone so one bad value cannot take the whole agenda down. */
function withZone(tz: string | null, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormatOptions {
  if (!tz) return opts
  try {
    new Intl.DateTimeFormat('en-IN', { ...opts, timeZone: tz })
    return { ...opts, timeZone: tz }
  } catch {
    return opts
  }
}

export function formatSessionTime(ms: number, tz: string | null): string {
  if (!Number.isFinite(ms)) return UNAVAILABLE
  return new Date(ms).toLocaleTimeString('en-IN',
    withZone(tz, { hour: 'numeric', minute: '2-digit', hour12: true }))
}

export function formatSessionRange(start: number, end: number, tz: string | null): string {
  if (!Number.isFinite(start) || !Number.isFinite(end)) return UNAVAILABLE
  return `${formatSessionTime(start, tz)} – ${formatSessionTime(end, tz)}`
}

/** The day heading an agenda groups by. Stable within one timezone. */
export function formatSessionDay(ms: number, tz: string | null): string {
  if (!Number.isFinite(ms)) return UNAVAILABLE
  return new Date(ms).toLocaleDateString('en-IN',
    withZone(tz, { weekday: 'long', day: 'numeric', month: 'long' }))
}

/**
 * A sortable key for the calendar day a session falls on IN THE EVENT'S ZONE.
 *
 * `toISOString().slice(0,10)` would be the UTC day, which splits an evening session in
 * Asia/Kolkata onto the following date. `en-CA` yields `YYYY-MM-DD`, which sorts.
 */
export function sessionDayKey(ms: number, tz: string | null): string {
  if (!Number.isFinite(ms)) return ''
  return new Date(ms).toLocaleDateString('en-CA', withZone(tz, {}))
}

/** Whole minutes between two instants; null when either is unusable. */
export function sessionMinutes(start: number, end: number): number | null {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null
  return Math.round((end - start) / 60000)
}

export function formatDuration(minutes: number | null): string {
  if (minutes === null) return UNAVAILABLE
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (h === 0) return `${m} min`
  return m === 0 ? `${h} hr` : `${h} hr ${m} min`
}

// ─── State ────────────────────────────────────────────────────────────────────

export type SessionState = 'cancelled' | 'live' | 'ended' | 'upcoming'

export const SESSION_STATE_LABEL: Record<SessionState, string> = {
  cancelled: 'Cancelled',
  live:      'On now',
  ended:     'Finished',
  upcoming:  'Upcoming',
}

/**
 * Where a session is in its own life.
 *
 * `cancelled` outranks the clock: a cancelled session that would otherwise be "on now" is
 * not on now. `now` is a parameter so nothing here reads a clock.
 */
export function sessionState(s: Pick<SessionView, 'status' | 'startTime' | 'endTime'>, now: number): SessionState {
  if (s.status === 'cancelled') return 'cancelled'
  if (now >= s.startTime && now < s.endTime) return 'live'
  if (now >= s.endTime) return 'ended'
  return 'upcoming'
}

// ─── Attendance ───────────────────────────────────────────────────────────────

/**
 * The share who registered but did not check in.
 *
 * `null` when nobody registered — a percentage OF nothing is not zero. The old tab
 * printed "0% no-show" for every empty session, which reads as perfect attendance.
 */
export function noShowPercent(registered: number, checkedIn: number): number | null {
  if (!Number.isFinite(registered) || registered <= 0) return null
  const pct = Math.round((1 - Math.min(checkedIn, registered) / registered) * 100)
  return Math.max(0, Math.min(100, pct))
}

export interface CapacityView {
  /** null = unlimited. */
  capacity:  number | null
  registered: number
  /** Seats left. null when unlimited. Floored at 0. */
  remaining: number | null
  /** TRUE share, unclamped — a capacity lowered after sign-ups can exceed 100. */
  percent:   number | null
  over:      boolean
}

export function capacityView(s: Pick<SessionView, 'capacity' | 'registeredCount'>): CapacityView {
  const registered = Math.max(0, s.registeredCount ?? 0)
  const capacity = typeof s.capacity === 'number' && s.capacity > 0 ? s.capacity : null
  return {
    capacity, registered,
    remaining: capacity === null ? null : Math.max(0, capacity - registered),
    percent:   capacity === null ? null : Math.round((registered / capacity) * 100),
    over:      capacity !== null && registered > capacity,
  }
}

// ─── Summary ──────────────────────────────────────────────────────────────────

export interface ConferenceSummary {
  scheduled:   number
  cancelled:   number
  /** Distinct calendar days the schedule spans, in the event's zone. */
  days:        number
  /** Total scheduled minutes across live sessions. null when no session has a usable span. */
  minutes:     number | null
  registered:  number
  checkedIn:   number
  /** null when nobody has registered for any session. */
  noShowPct:   number | null
  /** Sessions that have reached or passed their capacity. */
  full:        number
  /** Sessions with no room assigned — they cannot be checked for a clash. */
  withoutHall: number
}

export function conferenceSummary(
  sessions: readonly SessionView[],
  tz: string | null,
): ConferenceSummary {
  const live = sessions.filter(s => s.status !== 'cancelled')
  const days = new Set(live.map(s => sessionDayKey(s.startTime, tz)).filter(Boolean))

  let minutes: number | null = null
  for (const s of live) {
    const m = sessionMinutes(s.startTime, s.endTime)
    if (m !== null) minutes = (minutes ?? 0) + m
  }

  const registered = live.reduce((n, s) => n + Math.max(0, s.registeredCount ?? 0), 0)
  const checkedIn  = live.reduce((n, s) => n + Math.max(0, s.checkedInCount ?? 0), 0)

  return {
    scheduled: live.length,
    cancelled: sessions.length - live.length,
    days: days.size,
    minutes,
    registered,
    checkedIn,
    noShowPct: noShowPercent(registered, checkedIn),
    full: live.filter(s => { const c = capacityView(s); return c.capacity !== null && c.remaining === 0 }).length,
    withoutHall: live.filter(s => !s.hallId).length,
  }
}

// ─── Room utilisation ─────────────────────────────────────────────────────────

export interface HallUsage {
  hallId:   string
  name:     string
  sessions: number
  /** Scheduled minutes in this room. */
  minutes:  number
  /** Seats taken across its sessions, against the room's own capacity. */
  registered: number
  capacity: number | null
  percent:  number | null
}

/**
 * "How full are the rooms?" — the one visualisation this page earns.
 *
 * Returns `[]` unless at least one hall carries a capacity, so the surface omits the
 * chart rather than drawing bars against an invented denominator.
 */
export function hallUsage(
  sessions: readonly SessionView[],
  halls: readonly EventHallDoc[],
): HallUsage[] {
  const live = sessions.filter(s => s.status !== 'cancelled')
  const rows = halls.map(h => {
    const mine = live.filter(s => s.hallId === h.hallId)
    const minutes = mine.reduce((n, s) => n + (sessionMinutes(s.startTime, s.endTime) ?? 0), 0)
    const registered = mine.reduce((n, s) => n + Math.max(0, s.registeredCount ?? 0), 0)
    const capacity = typeof h.capacity === 'number' && h.capacity > 0 ? h.capacity : null
    // Peak occupancy is the honest measure for a ROOM: the busiest single session, not
    // the sum of everyone who ever sat in it across a whole day.
    const peak = mine.reduce((n, s) => Math.max(n, Math.max(0, s.registeredCount ?? 0)), 0)
    return {
      hallId: h.hallId, name: h.name, sessions: mine.length, minutes, registered,
      capacity, percent: capacity === null ? null : Math.round((peak / capacity) * 100),
    }
  })
  return rows.some(r => r.capacity !== null) ? rows : []
}

// ─── Grouping ─────────────────────────────────────────────────────────────────

export interface SessionGroup {
  key:      string
  label:    string
  sessions: SessionView[]
}

export function groupByDay(sessions: readonly SessionView[], tz: string | null): SessionGroup[] {
  const map = new Map<string, SessionView[]>()
  for (const s of sessions) {
    const k = sessionDayKey(s.startTime, tz) || 'unknown'
    if (!map.has(k)) map.set(k, [])
    map.get(k)!.push(s)
  }
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, list]) => ({
      key,
      label: key === 'unknown' ? 'Date unavailable' : formatSessionDay(list[0].startTime, tz),
      sessions: [...list].sort((a, b) => a.startTime - b.startTime),
    }))
}

export function groupByTrack(sessions: readonly SessionView[], tracks: readonly EventTrackDoc[]): SessionGroup[] {
  const groups = tracks.map(t => ({
    key: t.trackId, label: t.name,
    sessions: sessions.filter(s => s.trackId === t.trackId).sort((a, b) => a.startTime - b.startTime),
  }))
  const untracked = sessions.filter(s => !s.trackId).sort((a, b) => a.startTime - b.startTime)
  if (untracked.length > 0) groups.push({ key: '__none', label: 'No track', sessions: untracked })
  return groups.filter(g => g.sessions.length > 0)
}

export function groupBySpeaker(sessions: readonly SessionView[], speakers: readonly EventSpeakerDoc[]): SessionGroup[] {
  const groups = speakers.map(sp => ({
    key: sp.speakerId, label: sp.name,
    sessions: sessions.filter(s => s.speakerIds.includes(sp.speakerId)).sort((a, b) => a.startTime - b.startTime),
  }))
  const unassigned = sessions.filter(s => s.speakerIds.length === 0).sort((a, b) => a.startTime - b.startTime)
  if (unassigned.length > 0) groups.push({ key: '__none', label: 'No speaker assigned', sessions: unassigned })
  return groups.filter(g => g.sessions.length > 0)
}

// ─── Filtering ────────────────────────────────────────────────────────────────

export type ConferenceStatusFilter = 'scheduled' | 'cancelled' | 'all'
export type ConferenceView = 'agenda' | 'track' | 'speaker'

export const CONFERENCE_VIEWS: { key: ConferenceView; label: string }[] = [
  { key: 'agenda',  label: 'By day' },
  { key: 'track',   label: 'By track' },
  { key: 'speaker', label: 'By speaker' },
]

export function isConferenceView(v: string | null | undefined): v is ConferenceView {
  return v === 'agenda' || v === 'track' || v === 'speaker'
}

export function isStatusFilter(v: string | null | undefined): v is ConferenceStatusFilter {
  return v === 'scheduled' || v === 'cancelled' || v === 'all'
}

export interface ConferenceFilters {
  query:   string
  trackId: string | null
  hallId:  string | null
  status:  ConferenceStatusFilter
}

/**
 * Filtering happens in the browser ON PURPOSE.
 *
 * The whole schedule is already in memory — an agenda is bounded by the hours in a day,
 * not by the size of the audience — so there is no second page a client-side filter could
 * silently hide. That is the distinction RD-EVENT-12 drew: never filter a SERVER-PAGED
 * list in the browser; filtering a complete set is correct.
 */
export function filterSessions(
  sessions: readonly SessionView[],
  f: ConferenceFilters,
  speakers: readonly EventSpeakerDoc[] = [],
): SessionView[] {
  const q = f.query.trim().toLocaleLowerCase()
  const speakerName = (id: string) => speakers.find(s => s.speakerId === id)?.name ?? ''

  return sessions.filter(s => {
    if (f.status === 'scheduled' && s.status === 'cancelled') return false
    if (f.status === 'cancelled' && s.status !== 'cancelled') return false
    if (f.trackId && s.trackId !== f.trackId) return false
    if (f.hallId && s.hallId !== f.hallId) return false
    if (!q) return true
    return s.title.toLocaleLowerCase().includes(q)
      || s.description.toLocaleLowerCase().includes(q)
      || s.speakerIds.some(id => speakerName(id).toLocaleLowerCase().includes(q))
  })
}

/** Each reason gets its OWN sentence — "no results" must never read as "no sessions". */
export function conferenceEmptyMessage(f: ConferenceFilters, totalScheduled: number, totalCancelled: number): string {
  if (f.query.trim()) return `No session matches “${f.query.trim()}”.`
  if (f.trackId || f.hallId) return 'No session matches these filters.'
  if (f.status === 'cancelled') return 'No session has been cancelled.'
  if (totalScheduled === 0 && totalCancelled > 0) {
    return totalCancelled === 1
      ? 'The only session on this schedule was cancelled.'
      : `All ${totalCancelled} sessions on this schedule were cancelled.`
  }
  return 'No sessions on the schedule yet.'
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

/**
 * Can the schedule be EDITED?
 *
 * Mirrors `isLocked` in lib/eventSetup/readiness — cancelled and archived events refuse
 * configuration writes server-side, so offering the controls would be a lie. `completed`
 * is deliberately NOT locked: post-event corrections and exports stay useful, which is
 * the same call that module already made.
 */
export function conferenceEditable(lifecycleStatus: string | null): boolean {
  return lifecycleStatus !== 'cancelled' && lifecycleStatus !== 'archived'
}

export function conferenceLockReason(lifecycleStatus: string | null): string | null {
  if (lifecycleStatus === 'cancelled') return 'This event is cancelled, so its schedule is read-only.'
  if (lifecycleStatus === 'archived')  return 'This event is archived, so its schedule is read-only.'
  return null
}

// ─── Bundle helpers ───────────────────────────────────────────────────────────

export const trackName = (bundle: Pick<ScheduleBundle, 'tracks'>, id: string | null): string | null =>
  id ? bundle.tracks.find(t => t.trackId === id)?.name ?? null : null

export const hallName = (bundle: Pick<ScheduleBundle, 'halls'>, id: string | null): string | null =>
  id ? bundle.halls.find(h => h.hallId === id)?.name ?? null : null

export const speakerNames = (bundle: Pick<ScheduleBundle, 'speakers'>, ids: readonly string[]): string[] =>
  ids.map(id => bundle.speakers.find(s => s.speakerId === id)?.name).filter((n): n is string => Boolean(n))
