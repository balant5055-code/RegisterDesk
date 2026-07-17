// GET /api/admin/events/[slug]/360 — Event 360 overview + permanent Health Panel.
//
// The backbone read for the Event 360 Console. Admin-gated. Resolves the event →
// its owning organizer → REUSES existing services (getLicenseDetail, getEventStats)
// and O(1) counters. NO organizer API is called, NO business logic is duplicated,
// and NO new registration scan is performed — the health strip's four core signals
// come from the counters + the license row. Certificates/Communications/Analytics
// start `neutral` and are upgraded client-side from the (lazy) analytics endpoint.

import { NextRequest, NextResponse } from 'next/server'
import { adminDb }                   from '@/lib/firebase/admin'
import { resolveAdminUid }           from '@/lib/admin/auth'
import { getLicenseDetail }          from '@/lib/admin/licenseAdminService'
import { getEventStats }             from '@/lib/firebase/firestore/registrationCounters'
import type {
  Event360Overview, Event360Response, HealthIndicator, HealthLevel,
} from '@/lib/admin/event360Types'

interface RouteContext { params: Promise<{ slug: string }> }

const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}

function tsToISO(ts: unknown): string | null {
  if (ts && typeof (ts as { toDate?: () => Date }).toDate === 'function') {
    try { return (ts as { toDate: () => Date }).toDate().toISOString() } catch { return null }
  }
  return null
}
function tsMs(ts: unknown): number | null {
  if (ts && typeof (ts as { toMillis?: () => number }).toMillis === 'function') {
    try { return (ts as { toMillis: () => number }).toMillis() } catch { return null }
  }
  return null
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null)
const num = (v: unknown): number => (typeof v === 'number' ? v : 0)

export async function GET(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { slug } = await ctx.params

  const eventSnap = await adminDb.collection('events').doc(slug).get()
  if (!eventSnap.exists) return NextResponse.json({ error: 'Event not found' }, { status: 404 })
  const ev  = eventSnap.data() as Record<string, unknown>
  const uid = str(ev.uid) ?? ''

  // Resolve owning organizer + license + O(1) counters in parallel (no scans).
  const [licSnap, userSnap, licenseDetail, stats] = await Promise.all([
    adminDb.doc(`eventLicenses/${slug}`).get(),
    uid ? adminDb.doc(`users/${uid}`).get() : Promise.resolve(null),
    getLicenseDetail(slug).catch(() => null),
    getEventStats(slug),
  ])
  const licDoc = licSnap.exists ? (licSnap.data() as Record<string, unknown>) : null
  const user   = userSnap && userSnap.exists ? (userSnap.data() as Record<string, unknown>) : null

  // Coupon (denormalized on the license order) — best-effort, never fatal.
  let coupon: Event360Overview['coupon'] = null
  const orderId = str(licDoc?.orderId)
  if (orderId) {
    const orderSnap = await adminDb.doc(`licenseOrders/${orderId}`).get().catch(() => null)
    const order = orderSnap && orderSnap.exists ? (orderSnap.data() as Record<string, unknown>) : null
    if (order && str(order.couponCode)) {
      coupon = {
        code:            str(order.couponCode),
        campaign:        str(order.campaign),
        discountPaise:   num(order.discountPaise),
        finalPricePaise: typeof order.finalPricePaise === 'number' ? order.finalPricePaise : null,
      }
    }
  }

  const ed        = rec(ev.eventDetails)
  const info      = rec(ed.info)
  const schedule  = rec(ed.schedule)
  const venue     = rec(ed.venue)
  const organizer = rec(ed.organizer)
  const physical  = rec(venue.physical)
  const online    = rec(venue.online)

  const row = licenseDetail?.row ?? null
  const expiresMs = tsMs(licDoc?.expiresAt)
  const consumed  = licDoc?.consumed === true
  const expired   = expiresMs != null && expiresMs < Date.now() && !consumed

  const license: Event360Overview['license'] = row ? {
    tier:              row.tier,
    displayStatus:     row.displayStatus,
    paymentStatus:     row.paymentStatus,
    registrationLimit: row.registrationLimit,
    used:              row.used,
    amountPaidPaise:   row.amountPaidPaise,
    hasOverrides:      row.hasOverrides,
    complimentary:     row.complimentary,
    expiresAt:         tsToISO(licDoc?.expiresAt),
    consumed,
  } : null

  const counter = stats.counter
  const counters = {
    totalRegistrations: num(counter?.totalCount),
    checkedIn:          num(counter?.checkedInCount),
    revenuePaise:       num(counter?.revenuePaise),
    pending:            num(counter?.pendingCount),
    cancelled:          num(counter?.cancelledCount),
    statsComplete:      stats.complete,
  }

  // ── Health Panel (permanent). Core four from O(1) sources; the rest neutral. ──
  const health: HealthIndicator[] = []

  // License
  {
    let level: HealthLevel = 'neutral'; let detail = 'No license'
    if (license) {
      if (license.displayStatus === 'suspended' || license.displayStatus === 'cancelled') {
        level = 'red'; detail = `License ${license.displayStatus}`
      } else if (expired) {
        level = 'red'; detail = 'License expired'
      } else if (license.displayStatus === 'pending') {
        level = 'yellow'; detail = 'License pending'
      } else if (license.hasOverrides) {
        level = 'yellow'; detail = 'Active · has overrides'
      } else {
        level = 'green'; detail = `Active · ${license.tier ?? ''}`.trim()
      }
    }
    health.push({ key: 'license', label: 'License', level, detail })
  }

  // Payments
  {
    let level: HealthLevel = 'neutral'; let detail = 'No payment'
    const ps = license?.paymentStatus
    if (ps === 'paid' || ps === 'free' || ps === 'complimentary') { level = 'green'; detail = ps }
    else if (ps === 'pending') { level = 'yellow'; detail = 'Payment pending' }
    else if (ps === 'failed') { level = 'red'; detail = 'Payment failed' }
    else if (ps === 'refunded') { level = 'yellow'; detail = 'Refunded' }
    health.push({ key: 'payments', label: 'Payments', level, detail })
  }

  // Registrations (vs limit)
  {
    const total = counters.totalRegistrations
    const limit = license?.registrationLimit ?? null
    let level: HealthLevel = 'neutral'; let detail = 'No registrations'
    if (limit != null && total >= limit) { level = 'red'; detail = `At capacity (${total}/${limit})` }
    else if (limit != null && total >= Math.floor(limit * 0.9)) { level = 'yellow'; detail = `Near capacity (${total}/${limit})` }
    else if (total > 0) { level = 'green'; detail = limit != null ? `${total} / ${limit}` : `${total} registered` }
    health.push({ key: 'registrations', label: 'Registrations', level, detail })
  }

  // Attendance
  {
    const ci = counters.checkedIn
    health.push({
      key: 'attendance', label: 'Attendance',
      level: ci > 0 ? 'green' : 'neutral',
      detail: ci > 0 ? `${ci} checked in` : 'No check-ins yet',
    })
  }

  // Deferred signals — upgraded client-side once the analytics endpoint is fetched.
  health.push({ key: 'certificates',   label: 'Certificates',   level: 'neutral', detail: 'Open Operations' })
  health.push({ key: 'print',          label: 'Print',          level: 'neutral', detail: 'Open Operations' })
  health.push({ key: 'communications', label: 'Communications', level: 'neutral', detail: 'Open Business' })
  health.push({ key: 'analytics',      label: 'Analytics',      level: 'neutral', detail: 'Open Business' })

  const overview: Event360Overview = {
    slug,
    eventName:        str(info.name) ?? 'Untitled Event',
    tagline:          str(info.tagline) ?? '',
    eventType:        str(ev.eventType),
    lifecycleStatus:  str(ev.lifecycleStatus),
    reviewStatus:     str(ev.reviewStatus),
    moderationStatus: str(ev.moderationStatus),
    organizer: {
      uid,
      name:      str(user?.name) ?? str(organizer.name),
      email:     str(user?.email) ?? str(organizer.email),
      workspace: str(user?.organizationName),
      phone:     str(organizer.phone),
    },
    schedule: {
      startDate: str(schedule.startDate),
      startTime: str(schedule.startTime),
      endDate:   str(schedule.endDate),
      timezone:  str(schedule.timezone),
    },
    venue: {
      type:  str(venue.type),
      name:  str(physical.name) ?? str(online.platform),
      city:  str(physical.city),
      state: str(physical.state),
    },
    license,
    coupon,
    counters,
    lifecycle: {
      createdAt:   tsToISO(ev.createdAt),
      publishedAt: tsToISO(ev.publishedAt),
      approvedAt:  tsToISO(ev.approvedAt),
    },
    health,
  }

  return NextResponse.json({ overview } satisfies Event360Response, {
    headers: { 'Cache-Control': 'no-store' },
  })
}
