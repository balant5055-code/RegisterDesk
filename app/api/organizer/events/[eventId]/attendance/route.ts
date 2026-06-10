// GET /api/organizer/events/[eventId]/attendance
//
// Lightweight attendance dashboard endpoint.
// Returns summary stats, recent check-ins, per-pass breakdown,
// and hourly check-in buckets — everything the live dashboard needs in one call.
//
// Ownership: eventId is the draft doc ID under users/{uid}/eventDrafts.
// Security: organizer must own the event.

import { NextRequest, NextResponse } from 'next/server'
import { adminDb, adminAuth }        from '@/lib/firebase/admin'
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

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function GET(
  req:     NextRequest,
  context: { params: Promise<{ eventId: string }> },
): Promise<NextResponse<AttendanceDashboardResponse | { error: string }>> {
  // ── 1. Auth ────────────────────────────────────────────────────────────────
  const token = (req.headers.get('authorization') ?? '').replace(/^Bearer /, '')
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let uid: string
  try {
    uid = (await adminAuth.verifyIdToken(token)).uid
  } catch {
    return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
  }

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

  // ── 3. Load registrations ──────────────────────────────────────────────────
  const regsSnap = await adminDb
    .collection('registrations')
    .where('organizerUid', '==', uid)
    .where('eventSlug',    '==', slug)
    .get()

  const registrations = regsSnap.docs.map(doc => doc.data() as RegistrationDocument)

  // ── 4. Summary stats ───────────────────────────────────────────────────────
  const totalRegistrations    = registrations.length
  const confirmedRegistrations = registrations.filter(r => r.status === 'confirmed').length
  const cancelledRegistrations = registrations.filter(r => r.status === 'cancelled').length
  const checkedInCount         = registrations.filter(r => r.checkedIn === true).length
  const attendanceRate         = confirmedRegistrations > 0
    ? Math.round((checkedInCount / confirmedRegistrations) * 100)
    : 0

  // ── 5. Recent check-ins (last 20, sorted by checkedInAt desc) ─────────────
  const checkedInRegs = registrations
    .filter(r => r.checkedIn && r.checkedInAt)
    .map(r => ({ r, ts: toISO(r.checkedInAt) ?? '' }))
    .filter(({ ts }) => ts !== '')
    .sort((a, b) => b.ts.localeCompare(a.ts))
    .slice(0, 20)

  const recentCheckIns: RecentCheckIn[] = checkedInRegs.map(({ r, ts }) => ({
    registrationId: r.id,
    attendeeName:   r.attendee.name,
    ticketCode:     r.ticketCode,
    passName:       r.passName,
    checkedInAt:    ts,
  }))

  // ── 6. Per-pass breakdown ──────────────────────────────────────────────────
  const rawPasses = Array.isArray(pricing.passes)
    ? (pricing.passes as Record<string, unknown>[])
    : []

  // Load counter for accurate sold counts
  const counterSnap = await adminDb.collection('registrationCounters').doc(slug).get()
  const passCounts: Record<string, number> = counterSnap.exists
    ? ((counterSnap.data() as { passCounts?: Record<string, number> }).passCounts ?? {})
    : {}

  const passStats: PassAttendanceStat[] = rawPasses.map(p => {
    const passId   = String(p.id   ?? '')
    const passName = String(p.name ?? 'Pass')
    const capacity: number | null = p.unlimited === true
      ? null
      : typeof p.quantity === 'number' ? p.quantity : null

    const registered = passCounts[passId] ?? 0
    const checkedIn  = registrations.filter(
      r => r.passId === passId && r.checkedIn === true,
    ).length

    const attendancePct = registered > 0
      ? Math.round((checkedIn / registered) * 100)
      : 0

    return { passId, passName, capacity, registered, checkedIn, attendancePct }
  })

  // ── 7. Hourly check-in buckets ─────────────────────────────────────────────
  const hourCounts: Record<number, number> = {}
  registrations
    .filter(r => r.checkedIn && r.checkedInAt)
    .forEach(r => {
      const iso = toISO(r.checkedInAt)
      if (!iso) return
      const hour = new Date(iso).getHours()
      hourCounts[hour] = (hourCounts[hour] ?? 0) + 1
    })

  const activeHours = Object.keys(hourCounts).map(Number)

  // Show range from first check-in hour (−1) to last (+1), defaulting to 8 AM–6 PM
  const minH = activeHours.length > 0 ? Math.max(0,  Math.min(...activeHours) - 1) : 8
  const maxH = activeHours.length > 0 ? Math.min(23, Math.max(...activeHours) + 1) : 18

  const hourlyBuckets: HourlyBucket[] = []
  for (let h = minH; h <= maxH; h++) {
    hourlyBuckets.push({
      hour:  `${String(h).padStart(2, '0')}:00`,
      label: hourLabel(h),
      count: hourCounts[h] ?? 0,
    })
  }

  // ── 8. Return ──────────────────────────────────────────────────────────────
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
