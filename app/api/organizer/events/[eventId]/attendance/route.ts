// GET /api/organizer/events/[eventId]/attendance
//
// Lightweight attendance dashboard endpoint.
// Returns summary stats, recent check-ins, per-pass breakdown,
// and hourly check-in buckets — everything the live dashboard needs in one call.
//
// Ownership: eventId is the draft doc ID under users/{uid}/eventDrafts.
// Security: organizer must own the event.

import { NextRequest, NextResponse } from 'next/server'
import { Timestamp }                 from 'firebase-admin/firestore'
import { adminDb }                   from '@/lib/firebase/admin'
import { authorizeEvent }           from '@/lib/team/workspace'
import { getEventStats, aggregateRegistrationStatusCounts } from '@/lib/firebase/firestore/registrationCounters'
import { resolveIdentifierConfig }   from '@/lib/identifiers/config'
import { todayHourRanges, hourRangeDate } from '@/lib/attendance/attendanceView'
import type { RegistrationDocument } from '@/lib/registrations/types'
import { resolveOwnedEventSlug } from '@/lib/events/liveEventRef'

// ─── Response types ───────────────────────────────────────────────────────────

export interface RecentCheckIn {
  registrationId: string
  attendeeName:   string
  ticketCode:     string
  passName:       string
  checkedInAt:    string   // ISO
}

export interface PassAttendanceStat {
  passId:        string
  passName:      string
  capacity:      number | null   // null = unlimited
  registered:    number
  checkedIn:     number
  attendancePct: number          // 0–100
}

export interface HourlyBucket {
  hour:  string   // "HH:00" — the bucket key, in the EVENT's timezone
  label: string   // "9 AM", "12 PM" etc.
  /**
   * Check-ins in this hour. RD-EVENT-11: `null` means this hour could NOT be counted
   * — it is not zero, and the chart must draw it as a gap. Previously every hour was
   * a number derived from a capped document window, so an unreadable hour and an
   * empty hour were indistinguishable.
   */
  count: number | null
}

export interface AttendanceDashboardResponse {
  // Summary
  totalRegistrations:    number
  confirmedRegistrations: number
  cancelledRegistrations: number
  checkedInCount:         number
  attendanceRate:         number   // 0–100

  // Recent check-ins — newest first, capped at 20
  recentCheckIns: RecentCheckIn[]

  // Per-pass breakdown
  passStats: PassAttendanceStat[]

  // Hourly check-in trend — the ELAPSED hours of today, in the event's timezone
  hourlyBuckets: HourlyBucket[]

  // Meta
  eventName:   string
  lastUpdated: string   // ISO timestamp of when the server computed this

  // ─── RD-EVENT-11, all additive ────────────────────────────────────────────

  /** The summary counts could not be read. Render "—", never 0. */
  statsUnavailable: boolean
  /** The hourly aggregates could not be read at all. */
  hourlyUnavailable: boolean
  /** The EVENT's timezone — the only clock a gate operator can act on. */
  timeZone: string
  /** The event-timezone day the hourly buckets cover, `YYYY-MM-DD`. */
  hourlyDate: string
  /** Exact check-ins today. `null` when any hour was unreadable — a partial sum is a lie. */
  hourlyTotal: number | null

  /**
   * The organizer's OWN name for the thing this event issues ("Bib Number",
   * "Delegate ID", "Visitor Pass"). `null` when the event issues nothing, in which
   * case the column does not exist. Never hardcoded: RegisterDesk is not a
   * marathon platform.
   */
  identifierLabel:   string | null
  identifierEnabled: boolean

  /** The lifecycle state, so the client can explain itself without a second read. */
  lifecycleStatus: string | null
  /** Whether this event accepts check-ins right now (mirrors lib/checkin/eventStatus). */
  checkInAccepted: boolean
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toISO(val: unknown): string | null {
  if (!val) return null
  if (typeof (val as { toDate?: () => Date }).toDate === 'function') {
    return (val as { toDate: () => Date }).toDate().toISOString()
  }
  return null
}

// `hourLabel` moved to lib/attendance/attendanceView, where the hour RANGES are built
// — the label and the boundary it names must come from one place, or a chart can be
// captioned "9 AM" over a bucket that is not 9 AM anywhere.

interface CheckinRow {
  registrationId: string
  attendeeName:   string
  ticketCode:     string
  passName:       string
  passId:         string
  checkedInAt:    string   // ISO ('' when unresolved)
}

/**
 * How many recent check-ins the widget shows. It has ALWAYS shown twenty; until
 * RD-EVENT-11 it read a thousand documents to find them.
 */
const RECENT_CHECKIN_LIMIT = 20

/**
 * The newest check-ins — exactly as many as are rendered.
 *
 * ═══ WHY THIS IS 20 AND NOT 1000 ═════════════════════════════════════════════
 * This query used to `limit(1000)`, because the same window fed three things: the
 * twenty-row recent list, the hourly chart, and (in the fallback) per-pass
 * checked-in counts. So every attendance load billed up to a thousand document
 * reads — and the tab auto-refreshes, so an organizer who left it open on a gate
 * laptop spent 120,000 reads an hour looking at twenty rows.
 *
 * The hourly chart now comes from `count()` aggregates, which transfer no documents
 * and are exact at any size. Per-pass checked-in comes from `passCheckedInCounts`
 * on the counter, and from those same aggregates when the counter is not backfilled.
 * Nothing needs the window any more, so it shrank to what it displays.
 *
 * A registration carries `checkedInAt` IFF it is checked in (check-in sets it,
 * undo-checkin deletes it), so ordering by `checkedInAt` yields exactly the recent
 * checked-in registrations through the existing (organizerUid, eventSlug,
 * checkedInAt) index. Projected — no full documents, no attendee PII beyond the
 * four fields the list renders.
 */
async function fetchRecentCheckinRows(uid: string, slug: string): Promise<CheckinRow[]> {
  const ciSnap = await adminDb.collection('registrations')
    .where('organizerUid', '==', uid).where('eventSlug', '==', slug)
    .orderBy('checkedInAt', 'desc').limit(RECENT_CHECKIN_LIMIT)
    .select('attendee.name', 'ticketCode', 'passName', 'passId', 'checkedInAt')
    .get()
  return ciSnap.docs.map(doc => {
    const r = doc.data() as RegistrationDocument
    return {
      registrationId: doc.id,
      attendeeName:   r.attendee?.name ?? '',
      ticketCode:     r.ticketCode ?? '',
      passName:       r.passName ?? '',
      passId:         r.passId ?? '',
      checkedInAt:    toISO(r.checkedInAt) ?? '',
    }
  })
}

function toRecentCheckIns(rows: CheckinRow[]): RecentCheckIn[] {
  return rows
    .filter(r => r.checkedInAt)
    .sort((a, b) => b.checkedInAt.localeCompare(a.checkedInAt))
    .map(r => ({
      registrationId: r.registrationId,
      attendeeName:   r.attendeeName,
      ticketCode:     r.ticketCode,
      passName:       r.passName,
      checkedInAt:    r.checkedInAt,
    }))
}

/**
 * Today's check-ins, hour by hour, in the EVENT's timezone — from `count()`
 * aggregates that transfer ZERO documents.
 *
 * Two defects this closes beyond the read cost. The hours were the SERVER's
 * (`new Date(iso).getHours()`), so a 09:30 arrival in Chennai landed in the 04:00
 * bucket of a UTC server. And the window was "the newest 1000 check-ins" rather than
 * a day, so a busy event silently folded several days into one 24-hour chart and
 * captioned it "1000 check-ins shown" as though that were the total.
 *
 * Each bucket settles independently: a failed aggregate becomes `null`, which the
 * chart draws as a gap. Bounded to 24 by construction — a day has no more hours.
 * Served by the existing (organizerUid, eventSlug, checkedInAt) composite.
 */
async function fetchHourlyBuckets(
  uid: string, slug: string, timeZone: string, now: Date,
): Promise<{ buckets: HourlyBucket[]; total: number | null; unavailable: boolean }> {
  const base = adminDb.collection('registrations')
    .where('organizerUid', '==', uid).where('eventSlug', '==', slug)

  const ranges = todayHourRanges(now, timeZone)
  const counts = await Promise.all(ranges.map(r =>
    base
      .where('checkedInAt', '>=', Timestamp.fromDate(r.start))
      .where('checkedInAt', '<',  Timestamp.fromDate(r.end))
      .count().get()
      .then(s => s.data().count as number)
      // A failed bucket stays NULL. Rendering it as 0 would claim nobody arrived in
      // that hour — the one thing this chart must never invent.
      .catch(() => null),
  ))

  const buckets = ranges.map((r, i) => ({ hour: r.hour, label: r.label, count: counts[i] }))
  const known   = counts.filter((c): c is number => c !== null)
  return {
    buckets,
    total:       known.length === counts.length ? known.reduce((a, b) => a + b, 0) : null,
    unavailable: known.length === 0 && counts.length > 0,
  }
}

/**
 * Per-pass checked-in counts for a legacy event whose counter is not backfilled —
 * one `count()` aggregate per pass, zero documents.
 *
 * The fallback used to derive these by tallying the 1000-document window, which was
 * exact only for events smaller than the cap and silently wrong above it. Passes are
 * a handful per event, so this is a handful of aggregates and exact at any size.
 */
async function fetchPassCheckedInCounts(
  uid: string, slug: string, passIds: string[],
): Promise<Map<string, number | null>> {
  const base = adminDb.collection('registrations')
    .where('organizerUid', '==', uid).where('eventSlug', '==', slug)

  const out = new Map<string, number | null>()
  const counts = await Promise.all(passIds.map(id =>
    base.where('passId', '==', id).where('checkedIn', '==', true)
      .count().get().then(s => s.data().count as number).catch(() => null),
  ))
  passIds.forEach((id, i) => out.set(id, counts[i]))
  return out
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function GET(
  req:     NextRequest,
  context: { params: Promise<{ eventId: string }> },
): Promise<NextResponse<AttendanceDashboardResponse | { error: string }>> {
  // ── 1. Auth ────────────────────────────────────────────────────────────────
  // RD-ORGANIZER-02 P1: the live attendance dashboard is an event-day read for gate
  // operators, so it is gated by 'checkin' (held by checkin_staff/manager/admin/owner) —
  // not 'events' (which locked the very role built for the gate out of this view). Tenant
  // isolation is unchanged: the event is still resolved under the caller's own uid namespace.
  // RD-CHECKIN-STAFF-01: eventId comes from the ROUTE PATH, and authorizeEvent
  // additionally confirms a gate-only operator is assigned to this event — so
  // attendance for an unassigned event is refused, not merely un-navigable.
  const { eventId } = await context.params

  const authz = await authorizeEvent(req, 'checkin', eventId)
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  const uid = authz.workspaceUid

  // ── 2. Ownership — load draft ──────────────────────────────────────────────
  const draftRef  = adminDb.doc(`users/${uid}/eventDrafts/${eventId}`)
  const draftSnap = await draftRef.get()
  if (!draftSnap.exists) {
    return NextResponse.json({ error: 'Event not found' }, { status: 404 })
  }

  const draft    = draftSnap.data() as Record<string, unknown>
  const details  = (draft.eventDetails as Record<string, unknown>) ?? {}
  const info     = (details.info       as Record<string, unknown>) ?? {}
  const pricing  = (draft.pricing      as Record<string, unknown>) ?? {}

  // RD-CE-FIX C1 · only a slug proven to be THIS workspace's live event (counter stats have no owner filter).
  const slug      = await resolveOwnedEventSlug(uid, eventId, draft)
  const eventName = typeof info.name   === 'string' ? info.name : 'Event'

  const lifecycleStatus = typeof draft.lifecycleStatus === 'string' ? draft.lifecycleStatus : null

  // RD-EVENT-11 · The lifecycle set is the ONE the check-in routes enforce
  // (lib/checkin/eventStatus). Read here only so the client can explain itself
  // without a second request; every mutation is still refused server-side.
  const checkInAccepted = lifecycleStatus === 'published'
    || lifecycleStatus === 'registration_closed'
    || lifecycleStatus === 'completed'

  // The EVENT's timezone, so an hour bucket is the organizer's hour — not the
  // server's and not the viewer's. Falls back to the platform default rather than
  // throwing on an unrecognised zone.
  const schedule = (details.schedule as Record<string, unknown>) ?? {}
  const rawZone  = typeof schedule.timezone === 'string' ? schedule.timezone : null
  let timeZone = 'Asia/Kolkata'
  if (rawZone) {
    try { new Intl.DateTimeFormat('en-CA', { timeZone: rawZone }); timeZone = rawZone }
    catch { /* unrecognised zone — keep the default */ }
  }

  if (!slug) {
    // A draft has no slug and therefore no registrations. That is a STATE, not a
    // fault: returning 404 made the tab render "Failed to load dashboard" on every
    // unpublished event, which reads as a broken product rather than an early one.
    return NextResponse.json({
      totalRegistrations: 0, confirmedRegistrations: 0, cancelledRegistrations: 0,
      checkedInCount: 0, attendanceRate: 0,
      recentCheckIns: [], passStats: [], hourlyBuckets: [],
      eventName, lastUpdated: new Date().toISOString(),
      statsUnavailable: false, hourlyUnavailable: false,
      timeZone, hourlyDate: hourRangeDate(new Date(), timeZone), hourlyTotal: 0,
      identifierLabel: null, identifierEnabled: false,
      lifecycleStatus, checkInAccepted: false,
    })
  }

  // ── 3. Attendance statistics ───────────────────────────────────────────────
  // Summary + per-pass are served O(1) from registrationCounters when the event's
  // stats are backfilled (statsVersion current). Legacy events pre-backfill fall
  // back to the former full scan, so no event is ever mis-reported. Recent
  // check-ins + hourly buckets need per-row timestamps, so they come from a
  // BOUNDED, index-ordered checkedInAt query (O(cap)) instead of a full scan.
  const rawPasses = Array.isArray(pricing.passes)
    ? (pricing.passes as Record<string, unknown>[])
    : []

  let totalRegistrations = 0, confirmedRegistrations = 0, cancelledRegistrations = 0, checkedInCount = 0
  let statsUnavailable = false
  let passStats:      PassAttendanceStat[] = []
  let recentCheckIns: RecentCheckIn[]      = []

  const now = new Date()

  // ── The three independent reads, issued together ──────────────────────────
  // Each settles on its own so one failure scopes to its own section: an unreadable
  // counter must not blank the hourly chart, and an unreadable hour must not blank
  // the summary. Identifiers are read here too — one document — because the column
  // label is DATA the organizer configured, and the client must not guess it.
  const [statsResult, rows, hourly, identifier] = await Promise.all([
    getEventStats(slug).catch(() => null),
    fetchRecentCheckinRows(uid, slug).catch(() => null),
    fetchHourlyBuckets(uid, slug, timeZone, now)
      .catch(() => ({ buckets: [] as HourlyBucket[], total: null, unavailable: true })),
    resolveIdentifierConfig(slug).catch(() => null),
  ])

  const { counter, complete } = statsResult ?? { counter: null, complete: false }
  // passCounts (registered per pass) is ALWAYS maintained, so it is trusted in
  // both paths; only the per-pass CHECKED-IN source differs.
  const passCounts = counter?.passCounts ?? {}

  const passStatOf = (registeredOf: (id: string) => number, checkedInOf: (id: string) => number): PassAttendanceStat[] =>
    rawPasses.map(p => {
      const passId   = String(p.id   ?? '')
      const passName = String(p.name ?? 'Pass')
      const capacity: number | null = p.unlimited === true
        ? null
        : typeof p.quantity === 'number' ? p.quantity : null
      const registered = registeredOf(passId)
      const checkedIn  = checkedInOf(passId)
      const attendancePct = registered > 0 ? Math.round((checkedIn / registered) * 100) : 0
      return { passId, passName, capacity, registered, checkedIn, attendancePct }
    })

  recentCheckIns = toRecentCheckIns(rows ?? [])

  if (complete && counter) {
    // ── O(1) path — summary + per-pass from the counter doc ───────────────────
    confirmedRegistrations = counter.totalCount     ?? 0
    cancelledRegistrations = counter.cancelledCount ?? 0
    checkedInCount         = counter.checkedInCount ?? 0
    totalRegistrations     = confirmedRegistrations + (counter.pendingCount ?? 0) + cancelledRegistrations + (counter.rejectedCount ?? 0)

    const passCheckedIn = counter.passCheckedInCounts ?? {}
    passStats = passStatOf(id => passCounts[id] ?? 0, id => passCheckedIn[id] ?? 0)
  } else {
    // ── Fallback (legacy / not-yet-backfilled events) ─────────────────────────
    // Summary counts come from the ONE shared statistics fallback
    // (aggregateRegistrationStatusCounts) that the registrations list also uses —
    // indexed count() aggregates that transfer ZERO documents.
    //
    // RD-EVENT-11 · Per-pass checked-in is now its own small set of aggregates
    // rather than a tally over a capped document window. The window was exact only
    // for events smaller than the cap and quietly wrong above it, which is the worst
    // way for a number to be wrong: invisibly, and only on the largest events.
    const passIds = rawPasses.map(p => String(p.id ?? '')).filter(Boolean)
    const [counts, passCheckedIn] = await Promise.all([
      aggregateRegistrationStatusCounts(uid, slug).catch(() => null),
      fetchPassCheckedInCounts(uid, slug, passIds).catch(() => new Map<string, number | null>()),
    ])

    if (counts) {
      totalRegistrations     = counts.total
      confirmedRegistrations = counts.confirmed
      cancelledRegistrations = counts.cancelled
      checkedInCount         = counts.checkedIn
    } else {
      // Both the counter and the aggregate fallback failed. Say so — do not report
      // an event with registrations as an event with none.
      statsUnavailable = true
    }

    passStats = passStatOf(id => passCounts[id] ?? 0, id => passCheckedIn.get(id) ?? 0)
  }

  // Kept for backward compatibility with existing consumers. `statsUnavailable` is
  // what tells a caller whether this figure means anything; the tab reads the honest
  // resolver in lib/attendance/attendanceView instead of this number.
  const attendanceRate = !statsUnavailable && confirmedRegistrations > 0
    ? Math.round((checkedInCount / confirmedRegistrations) * 100)
    : 0

  const idConfig = identifier?.config ?? null

  // ── 4. Return ──────────────────────────────────────────────────────────────
  return NextResponse.json({
    totalRegistrations,
    confirmedRegistrations,
    cancelledRegistrations,
    checkedInCount,
    attendanceRate,
    recentCheckIns,
    passStats,
    hourlyBuckets: hourly.buckets,
    eventName,
    lastUpdated: now.toISOString(),

    statsUnavailable,
    hourlyUnavailable: hourly.unavailable,
    timeZone,
    hourlyDate:  hourRangeDate(now, timeZone),
    hourlyTotal: hourly.total,

    identifierLabel:   idConfig?.enabled ? (idConfig.label ?? null) : null,
    identifierEnabled: Boolean(idConfig?.enabled),

    lifecycleStatus,
    checkInAccepted,
  })
}
