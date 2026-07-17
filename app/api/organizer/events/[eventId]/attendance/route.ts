// GET /api/organizer/events/[eventId]/attendance
//
// Lightweight attendance dashboard endpoint.
// Returns summary stats, recent check-ins, per-pass breakdown,
// and hourly check-in buckets — everything the live dashboard needs in one call.
//
// Ownership: eventId is the draft doc ID under users/{uid}/eventDrafts.
// Security: organizer must own the event.

import { NextRequest, NextResponse } from 'next/server'
import { adminDb }                   from '@/lib/firebase/admin'
import { authorizeWorkspace }        from '@/lib/team/workspace'
import { getEventStats }             from '@/lib/firebase/firestore/registrationCounters'
import type { RegistrationDocument } from '@/lib/registrations/types'

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
  hour:  string   // "HH:00" — the bucket key
  label: string   // "9 AM", "12 PM" etc.
  count: number   // check-ins in this hour
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

  // Hourly check-in trend (covers active hours only, min 1 bucket)
  hourlyBuckets: HourlyBucket[]

  // Meta
  eventName:   string
  lastUpdated: string   // ISO timestamp of when the server computed this
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toISO(val: unknown): string | null {
  if (!val) return null
  if (typeof (val as { toDate?: () => Date }).toDate === 'function') {
    return (val as { toDate: () => Date }).toDate().toISOString()
  }
  return null
}

function hourLabel(h: number): string {
  if (h === 0)  return '12 AM'
  if (h < 12)   return `${h} AM`
  if (h === 12) return '12 PM'
  return `${h - 12} PM`
}

interface CheckinRow {
  registrationId: string
  attendeeName:   string
  ticketCode:     string
  passName:       string
  checkedInAt:    string   // ISO ('' when unresolved)
}

/**
 * Builds the recent-check-ins list (newest 20) and hourly buckets from a set of
 * checked-in rows. Shared by both read paths: the O(1) path feeds it a bounded,
 * index-ordered window; the legacy fallback feeds it the full scan. Pure — no I/O.
 */
function buildCheckinViews(rows: CheckinRow[]): { recentCheckIns: RecentCheckIn[]; hourlyBuckets: HourlyBucket[] } {
  const sorted = rows.filter(r => r.checkedInAt).sort((a, b) => b.checkedInAt.localeCompare(a.checkedInAt))

  const recentCheckIns: RecentCheckIn[] = sorted.slice(0, 20).map(r => ({
    registrationId: r.registrationId,
    attendeeName:   r.attendeeName,
    ticketCode:     r.ticketCode,
    passName:       r.passName,
    checkedInAt:    r.checkedInAt,
  }))

  const hourCounts: Record<number, number> = {}
  for (const r of rows) {
    if (!r.checkedInAt) continue
    const hour = new Date(r.checkedInAt).getHours()
    hourCounts[hour] = (hourCounts[hour] ?? 0) + 1
  }
  const activeHours = Object.keys(hourCounts).map(Number)
  const minH = activeHours.length > 0 ? Math.max(0,  Math.min(...activeHours) - 1) : 8
  const maxH = activeHours.length > 0 ? Math.min(23, Math.max(...activeHours) + 1) : 18

  const hourlyBuckets: HourlyBucket[] = []
  for (let h = minH; h <= maxH; h++) {
    hourlyBuckets.push({ hour: `${String(h).padStart(2, '0')}:00`, label: hourLabel(h), count: hourCounts[h] ?? 0 })
  }
  return { recentCheckIns, hourlyBuckets }
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function GET(
  req:     NextRequest,
  context: { params: Promise<{ eventId: string }> },
): Promise<NextResponse<AttendanceDashboardResponse | { error: string }>> {
  // ── 1. Auth ────────────────────────────────────────────────────────────────
  const authz = await authorizeWorkspace(req, 'events')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  const uid = authz.workspaceUid

  const { eventId } = await context.params

  // ── 2. Ownership — load draft ──────────────────────────────────────────────
  const draftRef  = adminDb.doc(`users/${uid}/eventDrafts/${eventId}`)
  const draftSnap = await draftRef.get()
  if (!draftSnap.exists) {
    return NextResponse.json({ error: 'Event not found' }, { status: 404 })
  }

  const draft    = draftSnap.data() as Record<string, unknown>
  const details  = (draft.eventDetails as Record<string, unknown>) ?? {}
  const info     = (details.info       as Record<string, unknown>) ?? {}
  const seo      = (details.seo        as Record<string, unknown>) ?? {}
  const pricing  = (draft.pricing      as Record<string, unknown>) ?? {}

  const slug      = typeof seo.urlSlug === 'string' && seo.urlSlug ? seo.urlSlug : null
  const eventName = typeof info.name   === 'string' ? info.name : 'Event'

  if (!slug) {
    return NextResponse.json({ error: 'Event slug not resolved' }, { status: 404 })
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
  let passStats:      PassAttendanceStat[] = []
  let recentCheckIns: RecentCheckIn[]      = []
  let hourlyBuckets:  HourlyBucket[]       = []

  const { counter, complete } = await getEventStats(slug)
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

  if (complete && counter) {
    // ── O(1) path — summary + per-pass from the counter doc ───────────────────
    confirmedRegistrations = counter.totalCount     ?? 0
    cancelledRegistrations = counter.cancelledCount ?? 0
    checkedInCount         = counter.checkedInCount ?? 0
    totalRegistrations     = confirmedRegistrations + (counter.pendingCount ?? 0) + cancelledRegistrations + (counter.rejectedCount ?? 0)

    const passCheckedIn = counter.passCheckedInCounts ?? {}
    passStats = passStatOf(id => passCounts[id] ?? 0, id => passCheckedIn[id] ?? 0)

    // Recent check-ins + hourly buckets — one bounded, index-ordered query.
    const RECENT_CHECKIN_CAP = 1000
    const ciSnap = await adminDb.collection('registrations')
      .where('organizerUid', '==', uid).where('eventSlug', '==', slug)
      .orderBy('checkedInAt', 'desc').limit(RECENT_CHECKIN_CAP)
      .select('attendee.name', 'ticketCode', 'passName', 'checkedInAt')
      .get()
    const rows: CheckinRow[] = ciSnap.docs.map(doc => {
      const r = doc.data() as RegistrationDocument
      return {
        registrationId: doc.id,
        attendeeName:   r.attendee?.name ?? '',
        ticketCode:     r.ticketCode ?? '',
        passName:       r.passName ?? '',
        checkedInAt:    toISO(r.checkedInAt) ?? '',
      }
    })
    ;({ recentCheckIns, hourlyBuckets } = buildCheckinViews(rows))
  } else {
    // ── Fallback — full scan (unchanged legacy behaviour until backfilled) ─────
    const regsSnap = await adminDb.collection('registrations')
      .where('organizerUid', '==', uid).where('eventSlug', '==', slug).get()
    const registrations = regsSnap.docs.map(doc => doc.data() as RegistrationDocument)

    totalRegistrations     = registrations.length
    confirmedRegistrations = registrations.filter(r => r.status === 'confirmed').length
    cancelledRegistrations = registrations.filter(r => r.status === 'cancelled').length
    checkedInCount         = registrations.filter(r => r.checkedIn === true).length

    passStats = passStatOf(
      id => passCounts[id] ?? 0,   // registered from the always-maintained counter
      id => registrations.filter(r => r.passId === id && r.checkedIn === true).length,
    )

    const rows: CheckinRow[] = registrations
      .filter(r => r.checkedIn && r.checkedInAt)
      .map(r => ({
        registrationId: r.id,
        attendeeName:   r.attendee?.name ?? '',
        ticketCode:     r.ticketCode ?? '',
        passName:       r.passName ?? '',
        checkedInAt:    toISO(r.checkedInAt) ?? '',
      }))
    ;({ recentCheckIns, hourlyBuckets } = buildCheckinViews(rows))
  }

  const attendanceRate = confirmedRegistrations > 0
    ? Math.round((checkedInCount / confirmedRegistrations) * 100)
    : 0

  // ── 4. Return ──────────────────────────────────────────────────────────────
  return NextResponse.json({
    totalRegistrations,
    confirmedRegistrations,
    cancelledRegistrations,
    checkedInCount,
    attendanceRate,
    recentCheckIns,
    passStats,
    hourlyBuckets,
    eventName,
    lastUpdated: new Date().toISOString(),
  })
}
