// GET /api/organizer/finance/analytics
//
// RD-FINANCE-P3 — the Finance Control Center's single data endpoint. READ-ONLY.
//
// Query params (all optional):
//   eventSlug  — restrict to one event; omitted = every event in the workspace
//   from, to   — ISO dates for the trend window
//   bucket     — 'day' | 'week'
//
// ═══ AUTHORIZATION IS PART OF THE DATA MODEL HERE ════════════════════════════
// Most Finance queries filter on `organizerUid`, so scope is enforced by the query itself.
// ONE does not: attendee-paid rides the dense `(eventSlug, status, amount)` index, which
// carries no organizerUid — it is the only verified dense source for what attendees were
// actually charged.
//
// So every slug used by that query is first intersected with the slugs this workspace owns
// (`events` where `uid == workspaceUid`). A slug supplied in the query string that is not in
// that set is refused with 403 rather than silently ignored: a caller probing another
// organizer's event must be told no, not handed an empty page that looks like zero revenue.
//
// No arithmetic lives in this route; it composes lib/finance/financeAnalytics.ts.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeWorkspace } from '@/lib/team/workspace'
import { adminDb } from '@/lib/firebase/admin'
import {
  getLedgerTotals, getStatusBreakdown, getAttendeePaid, getRegistrationSplit,
  getCouponTotals, getPassBreakdown, getTrend, buildHealth, MAX_TREND_BUCKETS,
  type FinanceScope, type LedgerTotals, type StatusRow, type AttendeePaid,
  type RegistrationSplit, type CouponTotals, type PassRow, type TrendPoint, type HealthItem,
} from '@/lib/finance/financeAnalytics'

export const dynamic = 'force-dynamic'

/**
 * Ledger lifecycle states, from the PlatformTransactionStatus union in lib/fees/types.ts.
 * A schema enum, not a business value — no rate, price or category is named here. Firestore
 * cannot return DISTINCT, so the set is enumerated and each is counted; a status with no rows
 * simply reports zero.
 */
const LEDGER_STATUSES = ['completed', 'pending', 'refunded', 'failed', 'disputed'] as const

/** Registration payment states written by the registration path. Same reasoning. */
const PAYMENT_STATUSES = ['paid', 'not_required', 'refunded', 'pending', 'failed'] as const

/** Registration lifecycle states that attendee-paid is summed across. */
const REG_STATUSES = ['confirmed', 'cancelled'] as const

/** Ceiling on aggregate queries per request for the bounded coupon/pass fan-outs. */
const FANOUT_BUDGET = 40

const DAY_MS = 86_400_000

export interface EventOption { slug: string; draftId: string | null }
export interface PassOption  { passId: string; passName: string | null }

export interface FinanceAnalyticsResponse {
  scope: {
    eventSlug: string | null
    from:      string | null
    to:        string | null
    bucket:    'day' | 'week'
    events:    EventOption[]
  }
  ledger:        LedgerTotals
  attendeePaid:  AttendeePaid
  registrations: RegistrationSplit
  statuses:      { rows: StatusRow[]; scoped: boolean }
  coupons:       CouponTotals
  passes:        { rows: PassRow[]; complete: boolean }
  trend:         { points: TrendPoint[]; complete: boolean; countsAvailable: false }
  health:        HealthItem[]
}

/** Slugs this workspace owns. Bounded — an organizer has few events. */
async function ownedEvents(workspaceUid: string): Promise<EventOption[]> {
  try {
    const snap = await adminDb.collection('events').where('uid', '==', workspaceUid).get()
    return snap.docs.map(d => ({
      slug:    d.id,
      draftId: typeof d.data().draftId === 'string' ? d.data().draftId : null,
    }))
  } catch { return [] }
}

/**
 * Configured passes for one event, from the draft's `pricing.passes[]`.
 *
 * Read from CONFIGURATION, never inferred from a scan of registrations: identity and display
 * name both come from the organizer's own pass definitions, so a new pass type needs no code
 * change and nothing here knows what a distance or a category is.
 */
async function configuredPasses(workspaceUid: string, draftId: string | null): Promise<PassOption[]> {
  if (!draftId) return []
  try {
    const snap = await adminDb.collection('users').doc(workspaceUid)
      .collection('eventDrafts').doc(draftId).get()
    const pricing = snap.data()?.pricing as { passes?: unknown } | undefined
    const passes  = Array.isArray(pricing?.passes) ? pricing.passes : []
    return passes
      .map(p => p as Record<string, unknown>)
      .filter(p => typeof p.id === 'string')
      .map(p => ({ passId: p.id as string, passName: typeof p.name === 'string' ? p.name : null }))
  } catch { return [] }
}

function parseDate(v: string | null): Date | null {
  if (!v) return null
  const t = Date.parse(v)
  return Number.isFinite(t) ? new Date(t) : null
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const authz = await authorizeWorkspace(req, 'transactions')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  const uid = authz.workspaceUid

  const sp        = req.nextUrl.searchParams
  const rawSlug   = sp.get('eventSlug')
  const bucket    = sp.get('bucket') === 'week' ? 'week' : 'day'

  const events = await ownedEvents(uid)
  const owned  = new Set(events.map(e => e.slug))

  // The ownership gate for the organizerUid-less dense index. Refuse, do not ignore.
  if (rawSlug && !owned.has(rawSlug)) {
    return NextResponse.json({ error: 'Event not found in this workspace.' }, { status: 403 })
  }
  const eventSlug = rawSlug && owned.has(rawSlug) ? rawSlug : null

  // Default window: the last 30 days, so the trend has a defined range without the client
  // having to supply one.
  const to   = parseDate(sp.get('to'))   ?? new Date()
  const from = parseDate(sp.get('from')) ?? new Date(to.getTime() - 30 * DAY_MS)

  const scope: FinanceScope = { organizerUid: uid, eventSlug, from, to }

  // Attendee-paid runs ONLY over owned slugs — scoped to one event when filtered, otherwise
  // across the workspace's own events. Never a slug from the query string directly.
  const paidSlugs = eventSlug ? [eventSlug] : events.map(e => e.slug)

  const draftId = eventSlug ? (events.find(e => e.slug === eventSlug)?.draftId ?? null) : null
  const passes  = await configuredPasses(uid, draftId)

  const budget = { remaining: FANOUT_BUDGET }

  // Independent aggregate groups run concurrently; each is internally bounded.
  const [ledger, attendeePaid, registrations, statuses] = await Promise.all([
    getLedgerTotals(scope),
    getAttendeePaid(paidSlugs, REG_STATUSES),
    getRegistrationSplit(scope, PAYMENT_STATUSES),
    getStatusBreakdown(scope, LEDGER_STATUSES),
  ])

  // Fan-outs share ONE budget, so they are run in sequence rather than racing for it.
  const coupons = await getCouponTotals(scope, budget)
  const passRes = await getPassBreakdown(scope, passes, budget)

  const span     = Math.max(0, to.getTime() - from.getTime())
  const bucketMs = bucket === 'week' ? 7 * DAY_MS : DAY_MS
  // Widen the bucket rather than truncate the window when the range exceeds the ceiling.
  const effective = span / bucketMs > MAX_TREND_BUCKETS
    ? Math.ceil(span / MAX_TREND_BUCKETS)
    : bucketMs
  const trend = await getTrend(scope, effective)

  const health = buildHealth({ ledger, coupons, passes: passRes, attendeePaid })

  const body: FinanceAnalyticsResponse = {
    scope: { eventSlug, from: from.toISOString(), to: to.toISOString(), bucket, events },
    ledger, attendeePaid, registrations, statuses,
    coupons, passes: passRes, trend, health,
  }
  return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } })
}
