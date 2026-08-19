// Per-event coupon performance — server-only.
//
// ═══ WHY THIS REPLACES THE SCAN-DERIVED VERSION ══════════════════════════════
// Coupon figures used to be derived inside the eventAnalytics registration scan, which reads
// `.limit(CAP + 1)` = 5,001 documents and then iterates only the first 5,000. At 25,000
// registrations that silently under-reported every coupon number, and the `truncated` flag
// that recorded it was never rendered — so the organizer saw a confidently wrong figure.
//
// Coupon performance does not need the registrations at all:
//
//   • uses / limit / remaining / % used  →  the coupon documents themselves
//   • total discount given               →  ONE sum() aggregate, which transfers no documents
//
// Cost is therefore O(#coupons) + 1 aggregate, INDEPENDENT of registration count. It is exact
// at 25k, at 250k, and at any scale, and it never grows with the event.
//
// ═══ WHAT `uses` MEANS ═══════════════════════════════════════════════════════
// `currentUses` is the coupon's own redemption counter — the same number the validator checks
// against `maxUses`. It is incremented atomically at redemption and is NEVER decremented, so
// a cancelled or refunded registration still counts. That is deliberate and is why it is the
// right source here: "84 / 100 used" must agree with what the validator will enforce on the
// 101st attempt. It does NOT mean "84 live registrations currently hold this coupon".
//
// ═══ WHAT IS NOT AVAILABLE ═══════════════════════════════════════════════════
// Discount broken down PER coupon. Firestore has no GROUP BY, so it would require one
// aggregation query per coupon (which is the read pattern this module exists to avoid) or a
// running total stored on each coupon at redemption time (a write-path change). The total
// across all coupons is exact; the per-coupon split is deliberately absent rather than
// estimated.

import { adminDb } from '@/lib/firebase/admin'
import { AggregateField } from 'firebase-admin/firestore'
import type { CouponDocument } from '@/lib/coupons/types'

export interface CouponPerformanceRow {
  code:        string
  description: string
  active:      boolean
  /** Redemptions recorded on the coupon itself. Never decremented — see header. */
  uses:        number
  /** null = unlimited. */
  maxUses:     number | null
  /** null when unlimited. */
  remaining:   number | null
  /** 0–100, or null when unlimited (a share of infinity is meaningless). */
  percentUsed: number | null
}

export interface CouponPerformance {
  /** Sum of `currentUses` across every coupon configured for the event. */
  totalRedemptions: number
  /** Exact across ALL registrations — a sum() aggregate, not a capped scan. */
  totalDiscountPaise: number
  activeCoupons:    number
  totalCoupons:     number
  /** Ranked by uses, descending. Bounded by the number of coupons configured. */
  rows:             CouponPerformanceRow[]
  /** True when the discount aggregate could not be read; the UI must not show a 0 as fact. */
  discountUnavailable: boolean
}

export const EMPTY_COUPON_PERFORMANCE: CouponPerformance = {
  totalRedemptions: 0, totalDiscountPaise: 0, activeCoupons: 0, totalCoupons: 0,
  rows: [], discountUnavailable: false,
}

/** Shapes one coupon document into a display row. Pure — exported for testing. */
export function toPerformanceRow(c: Partial<CouponDocument>): CouponPerformanceRow {
  const uses    = typeof c.currentUses === 'number' && c.currentUses > 0 ? c.currentUses : 0
  const hasCap  = typeof c.maxUses === 'number' && c.maxUses > 0
  const maxUses = hasCap ? c.maxUses! : null

  return {
    code:        typeof c.code === 'string' ? c.code : '',
    description: typeof c.description === 'string' ? c.description : '',
    active:      c.active !== false,
    uses,
    maxUses,
    // Clamped: `currentUses` can legitimately exceed a cap that was lowered after redemptions,
    // and a negative "remaining" would read as a data error rather than a full coupon.
    remaining:   maxUses === null ? null : Math.max(0, maxUses - uses),
    percentUsed: maxUses === null ? null : Math.min(100, Math.round((uses / maxUses) * 100)),
  }
}

/** Orders coupons for display: most-used first, then alphabetically for a stable tie-break. */
export function rankCouponRows(rows: CouponPerformanceRow[]): CouponPerformanceRow[] {
  return [...rows].sort((a, b) => b.uses - a.uses || a.code.localeCompare(b.code))
}

/**
 * Reads coupon performance for ONE event.
 *
 * Exactly two round trips regardless of event size:
 *   1. the event's `coupons` subcollection (typically a handful of documents)
 *   2. one sum('discountAmount') aggregate over the event's registrations
 */
export async function getCouponPerformance(
  eventSlug: string,
  organizerUid: string,
): Promise<CouponPerformance> {
  const couponsSnap = await adminDb
    .collection('events').doc(eventSlug)
    .collection('coupons')
    .get()

  const rows = rankCouponRows(
    couponsSnap.docs.map(d => toPerformanceRow(d.data() as CouponDocument)),
  )

  // The discount total comes from the REGISTRATIONS, because it is the historical money that
  // actually left the price — the coupon document does not record it. A sum() aggregate reads
  // index entries only, so this stays flat as the event grows.
  let totalDiscountPaise = 0
  let discountUnavailable = false
  try {
    const agg = await adminDb.collection('registrations')
      .where('organizerUid', '==', organizerUid)
      .where('eventSlug', '==', eventSlug)
      .aggregate({ total: AggregateField.sum('discountAmount') })
      .get()
    const total = agg.data().total
    totalDiscountPaise = typeof total === 'number' && Number.isFinite(total) ? total : 0
  } catch {
    // A missing index or an unsupported backend must not turn into "₹0 of discount given",
    // which is a claim rather than an absence. The flag lets the UI say so.
    discountUnavailable = true
  }

  return {
    totalRedemptions: rows.reduce((n, r) => n + r.uses, 0),
    totalDiscountPaise,
    activeCoupons:    rows.filter(r => r.active).length,
    totalCoupons:     rows.length,
    rows,
    discountUnavailable,
  }
}

// ─── Organizer-wide (the /dashboard view) ────────────────────────────────────

/** A coupon row carrying the event it belongs to — coupons are per-event, the dashboard is not. */
export interface OrganizerCouponRow extends CouponPerformanceRow {
  eventSlug: string
  eventName: string
}

export interface OrganizerCouponPerformance
  extends Omit<CouponPerformance, 'rows'> {
  rows: OrganizerCouponRow[]
  /** True when the event budget was hit, so coupons from later events are not counted. */
  partial: boolean
}

export const EMPTY_ORGANIZER_COUPON_PERFORMANCE: OrganizerCouponPerformance = {
  totalRedemptions: 0, totalDiscountPaise: 0, activeCoupons: 0, totalCoupons: 0,
  rows: [], discountUnavailable: false, partial: false,
}

/**
 * Ceiling on coupon-collection reads for ONE dashboard load.
 *
 * Coupons live under each event, so an organizer-wide view costs one subcollection read per
 * event. Mirrors PASS_AGGREGATE_BUDGET in the dashboard route: past the ceiling the result is
 * flagged `partial` rather than silently under-reported.
 */
export const COUPON_EVENT_BUDGET = 60

/**
 * Coupon performance across an ALREADY-BOUNDED set of the organizer's events.
 *
 * Read cost:
 *   • one coupons-subcollection read per event, capped at COUPON_EVENT_BUDGET
 *   • ONE sum('discountAmount') aggregate for the whole organizer — not one per event, and
 *     not one per coupon
 *
 * No registration document is ever read. The caller supplies the event list, so this never
 * enumerates events itself and cannot widen the dashboard's existing scope.
 */
export async function getOrganizerCouponPerformance(
  organizerUid: string,
  events: { slug: string; name: string }[],
): Promise<OrganizerCouponPerformance> {
  const considered = events.slice(0, COUPON_EVENT_BUDGET)
  const partial    = events.length > COUPON_EVENT_BUDGET

  const perEvent = await Promise.all(considered.map(async ev => {
    try {
      const snap = await adminDb
        .collection('events').doc(ev.slug)
        .collection('coupons')
        .get()
      return snap.docs.map(d => ({
        ...toPerformanceRow(d.data() as CouponDocument),
        eventSlug: ev.slug,
        eventName: ev.name,
      }))
    } catch {
      // One unreadable event must not remove every other event's coupons from the card.
      return [] as OrganizerCouponRow[]
    }
  }))

  const rows = perEvent.flat()
    .sort((a, b) => b.uses - a.uses || a.code.localeCompare(b.code))

  // ONE aggregate for the entire organizer. Scoped by organizerUid, so it can never include
  // another workspace's registrations, and it transfers no documents.
  let totalDiscountPaise = 0
  let discountUnavailable = false
  try {
    const agg = await adminDb.collection('registrations')
      .where('organizerUid', '==', organizerUid)
      .aggregate({ total: AggregateField.sum('discountAmount') })
      .get()
    const total = agg.data().total
    totalDiscountPaise = typeof total === 'number' && Number.isFinite(total) ? total : 0
  } catch {
    discountUnavailable = true
  }

  return {
    totalRedemptions: rows.reduce((n, r) => n + r.uses, 0),
    totalDiscountPaise,
    activeCoupons:    rows.filter(r => r.active).length,
    totalCoupons:     rows.length,
    rows,
    discountUnavailable,
    partial,
  }
}
