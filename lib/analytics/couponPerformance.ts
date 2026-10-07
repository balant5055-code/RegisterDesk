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
// ═══ RD-DASH-07 · WHAT THE AUDIT FOUND ═══════════════════════════════════════
// Three things, all now fixed here:
//
//   1. `activeCoupons` counted `active !== false` — ONE of the validator's four gates. On
//      the audited event all 16 coupons were active and all 16 were past `validUntil`, so
//      the card claimed 16 active coupons on a day none of them could be redeemed.
//   2. `percentUsed` was clamped to 100, which erased the only case worth seeing: a cap
//      lowered after redemptions leaves a coupon genuinely over its limit.
//   3. The organizer-wide discount aggregate had NO event filter, so in event mode it
//      would have printed the workspace total beneath one event's coupons. Masked, because
//      the aggregate was failing on a missing index and rendering as a dash.
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
import { resolveCouponState, couponToday, type CouponState } from '@/lib/coupons/couponState'

export interface CouponPerformanceRow {
  code:        string
  description: string
  /** The organizer's on/off switch ALONE. Not "usable today" — see `state`. */
  active:      boolean
  /**
   * RD-DASH-07 · what the validator would do with this code today.
   *
   * `active` was being read as "usable", and it is only the first of four gates. On the
   * audited event all sixteen coupons were `active: true` and all sixteen were past their
   * `validUntil`, so the card reported sixteen active coupons that nobody could redeem.
   */
  state:       CouponState
  /** Redemptions recorded on the coupon itself. Never decremented — see header. */
  uses:        number
  /** null = unlimited. */
  maxUses:     number | null
  /** Headroom left. Floored at 0 — a negative remaining is not a quantity. */
  remaining:   number | null
  /**
   * TRUE percentage, null when unlimited (a share of infinity is meaningless).
   *
   * RD-DASH-07 removed a `Math.min(100, …)` here. A cap lowered after redemptions leaves a
   * coupon genuinely over its limit, and clamping the FIGURE hid the one case worth seeing.
   * Bar WIDTHS are clamped at the point of drawing, which is where clamping belongs.
   */
  percentUsed: number | null
  /** uses > maxUses. Impossible to read off a clamped percentage, so it is stated. */
  exceeded:    boolean
}

export interface CouponPerformance {
  /** Sum of `currentUses` across every coupon configured for the event. */
  totalRedemptions: number
  /**
   * Exact across ALL registrations — a sum() aggregate, not a capped scan.
   *
   * MEANINGLESS unless `discountUnavailable` is false. It is 0 in the failure case only
   * because a number is needed to satisfy the type; the flag is what the surface reads.
   */
  totalDiscountPaise: number
  /** Coupons whose on/off switch is on. NOT the number that can be redeemed today. */
  activeCoupons:    number
  /** Coupons the validator would accept today — the figure an organizer actually wants. */
  redeemableCoupons: number
  /** How many coupons sit in each state. Sums to totalCoupons. */
  stateCounts:      Record<CouponState, number>
  totalCoupons:     number
  /** Ranked by uses, descending. Bounded by the number of coupons configured. */
  rows:             CouponPerformanceRow[]
  /** True when the discount aggregate could not be read; the UI must not show a 0 as fact. */
  discountUnavailable: boolean
  /**
   * RD-DASH-12 · the caller may not see money.
   *
   * Deliberately NOT folded into `discountUnavailable`: that flag means "the aggregate
   * could not be read", and the surface explains it by naming a missing index. Telling a
   * finance-restricted operator that an index is missing would be a false explanation for
   * a permission decision.
   */
  discountRestricted?: boolean
}

/** No coupons configured — every count is a genuine zero, not an unread one. */
export const EMPTY_COUPON_PERFORMANCE: CouponPerformance = {
  totalRedemptions: 0, totalDiscountPaise: 0, activeCoupons: 0, redeemableCoupons: 0,
  totalCoupons: 0, stateCounts: EMPTY_STATE_COUNTS(), rows: [], discountUnavailable: false,
}

/** Every state at zero. A fresh object each call — a shared one would be mutated by callers. */
export function EMPTY_STATE_COUNTS(): Record<CouponState, number> {
  return { redeemable: 0, exhausted: 0, expired: 0, scheduled: 0, inactive: 0 }
}

/**
 * Shapes one coupon document into a display row. Pure — exported for testing.
 *
 * `today` is an ISO date; the caller passes the same value the validator computes, so the
 * card and the enforcement agree. Defaulted so every existing caller is unaffected.
 */
export function toPerformanceRow(
  c: Partial<CouponDocument>,
  today: string = couponToday(new Date()),
): CouponPerformanceRow {
  const uses    = typeof c.currentUses === 'number' && c.currentUses > 0 ? c.currentUses : 0
  const hasCap  = typeof c.maxUses === 'number' && c.maxUses > 0
  const maxUses = hasCap ? c.maxUses! : null

  return {
    code:        typeof c.code === 'string' ? c.code : '',
    description: typeof c.description === 'string' ? c.description : '',
    active:      c.active !== false,
    state:       resolveCouponState({
      active:      c.active !== false,
      validFrom:   c.validFrom,
      validUntil:  c.validUntil,
      maxUses:     maxUses ?? undefined,
      currentUses: uses,
    }, today),
    uses,
    maxUses,
    // Floored at 0: `currentUses` can legitimately exceed a cap that was lowered after
    // redemptions, and a negative "remaining" would read as a data error rather than a
    // spent coupon. The overage is reported by `exceeded`, not hidden.
    remaining:   maxUses === null ? null : Math.max(0, maxUses - uses),
    // NOT clamped. See the field comment: clamping here is what made an over-limit coupon
    // indistinguishable from one sitting exactly at its cap.
    percentUsed: maxUses === null ? null : Math.round((uses / maxUses) * 100),
    exceeded:    maxUses !== null && uses > maxUses,
  }
}

/** Tallies rows by state. Pure. */
export function countCouponStates(rows: CouponPerformanceRow[]): Record<CouponState, number> {
  const out = EMPTY_STATE_COUNTS()
  for (const r of rows) out[r.state] += 1
  return out
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
    totalRedemptions:  rows.reduce((n, r) => n + r.uses, 0),
    totalDiscountPaise,
    activeCoupons:     rows.filter(r => r.active).length,
    redeemableCoupons: rows.filter(r => r.state === 'redeemable').length,
    stateCounts:       countCouponStates(rows),
    totalCoupons:      rows.length,
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
  /**
   * RD-DASH-13 · at least one event's coupon subcollection could not be READ.
   *
   * Distinct from `partial` (a budget ceiling, known and deliberate) and from an empty
   * result (a measured "this event has no coupons"). Before this flag existed a failed
   * read returned `[]` and the card said "0 coupons", which is a statement about the
   * workspace rather than about the query.
   */
  unavailable: boolean
  /**
   * RD-DASH-15 · `stateCounts`, `activeCoupons` and `redeemableCoupons` cover only the
   * coupons that were READ, not every coupon that exists.
   *
   * Those three are the only figures on this card that cannot be answered by an
   * aggregate: each needs the four validator gates evaluated against `validFrom`,
   * `validUntil`, `maxUses` and `currentUses` on the document itself, and Firestore
   * cannot compute that server-side. `totalCoupons` and `totalRedemptions` ARE exact
   * either way — see the read strategy below.
   *
   * True ⇒ the surface must not turn them into a sentence about the whole set.
   */
  statesPartial: boolean
  /**
   * Whether the coupons READ span more than one event.
   *
   * The card used to derive this from `rows`, which was every coupon. `rows` is now
   * capped for the wire, so deriving it there would flip the per-row event label on a
   * large workspace. Resolved here, before the cap, so the rendering is unchanged.
   */
  spansEvents: boolean
}

export const EMPTY_ORGANIZER_COUPON_PERFORMANCE: OrganizerCouponPerformance = {
  totalRedemptions: 0, totalDiscountPaise: 0, activeCoupons: 0, redeemableCoupons: 0,
  totalCoupons: 0, stateCounts: EMPTY_STATE_COUNTS(),
  rows: [], discountUnavailable: false, partial: false, unavailable: false,
  statesPartial: false, spansEvents: false,
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
 * RD-DASH-15 · ceiling on coupon DOCUMENTS read per event.
 *
 * `COUPON_EVENT_BUDGET` bounded the event axis; the coupon axis had no bound at all, so
 * one `.collection('coupons').get()` per event transferred every coupon that existed.
 * Measured during RD-DASH-14: five events carrying 2,000 coupons each produced 10,000
 * documents and a 1,993 KB response, for a card that renders five rows.
 *
 * 100 is chosen so that in practice NOTHING changes — every event under a hundred
 * coupons still yields an exact, complete result from one read, exactly as before. Past
 * it the read stays bounded and the two totals are recovered from aggregates instead.
 */
export const COUPON_DOC_BUDGET = 100

/**
 * Ceiling on coupon rows SERIALISED to the client.
 *
 * The card renders `COUPON_ROWS_SHOWN` (5). Sending sixty events × a hundred rows would
 * be a megabyte of JSON to draw five lines, so the wire carries the top slice only.
 * Every TOTAL is computed before this cut, so no figure depends on it.
 */
export const COUPON_ROWS_SERIALIZED = 25

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
  /**
   * RD-DASH-07 · which scope the DISCOUNT aggregate belongs to.
   *
   * The coupon ROWS have always followed the caller's event list, but the discount total
   * did not: it was one `where(organizerUid)` aggregate with no event filter, so in event
   * mode the card would have shown one event's coupons above the WHOLE WORKSPACE's
   * discount. It was invisible only because the aggregate was failing on a missing index
   * and rendering as a dash.
   *
   * Passed as an intention rather than a slug that might be missing — an event can be
   * selected while unpublished, and an unpublished event has no slug.
   */
  /**
   * `financeAllowed` gates the DISCOUNT aggregate only — coupon codes, their state and
   * their redemption counts are registration data, not money, and stay visible.
   * Defaults to true so existing callers are unchanged.
   */
  scope: { scoped: boolean; slug: string | null; financeAllowed?: boolean }
    = { scoped: false, slug: null },
): Promise<OrganizerCouponPerformance> {
  const considered = events.slice(0, COUPON_EVENT_BUDGET)
  const partial    = events.length > COUPON_EVENT_BUDGET

  let readFailed = false

  // ═══ RD-DASH-15 · BOUNDED, AND STILL EXACT WHERE IT MATTERS ════════════════
  // The read is capped, so the two figures the card leads with are recovered from
  // AGGREGATES rather than from the documents when the cap bites:
  //
  //   totalCoupons     ← count()                exact, transfers no documents
  //   totalRedemptions ← sum(currentUses)       exact, transfers no documents
  //   rows             ← orderBy(currentUses desc).limit(cap)   the true top slice
  //
  // The state breakdown cannot follow: `redeemable` / `expired` / `scheduled` /
  // `exhausted` / `inactive` come from four validator gates evaluated per document",
  // and no aggregate can express them. Those three figures are therefore flagged
  // `statesPartial` rather than presented as a whole — see the field.
  //
  // THE COMMON CASE IS UNCHANGED. The first read is UNORDERED and takes one more than
  // the budget: under the cap it holds every coupon, every figure is exact from the
  // documents, and no aggregate is issued at all. Unordered deliberately — `orderBy`
  // excludes documents missing the field, and a legacy coupon without `currentUses`
  // (which `toPerformanceRow` still defends against) must not vanish from the count.
  const perEvent = await Promise.all(considered.map(async ev => {
    const col = adminDb.collection('events').doc(ev.slug).collection('coupons')
    const shape = (d: FirebaseFirestore.QueryDocumentSnapshot): OrganizerCouponRow => ({
      ...toPerformanceRow(d.data() as CouponDocument),
      eventSlug: ev.slug,
      eventName: ev.name,
    })
    try {
      const first = await col.limit(COUPON_DOC_BUDGET + 1).get()
      if (first.size <= COUPON_DOC_BUDGET) {
        // Everything this event has. Identical to the previous behaviour, bounded.
        const rows = first.docs.map(shape)
        return {
          rows, complete: true,
          count: rows.length,
          uses:  rows.reduce((n, r) => n + r.uses, 0),
        }
      }
      // Past the cap. Totals from aggregates, rows from the ordered top slice.
      const [cnt, sum, top] = await Promise.all([
        col.count().get(),
        col.aggregate({ u: AggregateField.sum('currentUses') }).get(),
        col.orderBy('currentUses', 'desc').limit(COUPON_DOC_BUDGET).get(),
      ])
      const c = cnt.data().count
      const u = sum.data().u
      return {
        rows: top.docs.map(shape),
        complete: false,
        count: typeof c === 'number' && Number.isFinite(c) ? c : first.size,
        uses:  typeof u === 'number' && Number.isFinite(u) ? Math.trunc(u) : 0,
      }
    } catch {
      // One unreadable event must not remove every other event's coupons from the card —
      // but RD-DASH-13: it must not silently look like an event with no coupons either.
      // The rows that WERE read are still shown, and the card says the count is partial.
      readFailed = true
      return { rows: [] as OrganizerCouponRow[], complete: false, count: 0, uses: 0 }
    }
  }))

  // Same comparator as before — the display order is unchanged. Applied to the rows in
  // hand, which for a capped event are already its most-redeemed.
  const allRows = perEvent.flatMap(e => e.rows)
    .sort((a, b) => b.uses - a.uses || a.code.localeCompare(b.code))
  // Resolved BEFORE the wire cut, so the per-row event label cannot flip.
  const spansEvents  = new Set(allRows.map(r => r.eventSlug)).size > 1
  const statesPartial = perEvent.some(e => !e.complete)
  const exactCount = perEvent.reduce((n, e) => n + e.count, 0)
  const exactUses  = perEvent.reduce((n, e) => n + e.uses, 0)
  const rows = allRows.slice(0, COUPON_ROWS_SERIALIZED)

  // ONE aggregate. Always filtered by organizerUid, so it can never include another
  // workspace's registrations, and narrowed to the selected event when there is one — the
  // rows above are that event's, and a workspace discount total beneath them would be a
  // figure from a different population.
  //
  // A scoped event with no slug reads NOTHING rather than falling back to the workspace:
  // every registration carries an eventSlug, so an event without one cannot have a
  // discount attributed to it. That is a measured zero, not an unread one.
  let totalDiscountPaise = 0
  let discountUnavailable = false
  let discountRestricted  = false
  if (scope.financeAllowed === false) {
    // RD-DASH-12 · not read at all. "Restricted" and "unavailable" are different facts and
    // the surface says which one it is — the existing unavailable copy blames a missing
    // index, which would be a false explanation here.
    discountRestricted = true
  } else if (scope.scoped && !scope.slug) {
    totalDiscountPaise = 0
  } else {
    try {
      const base = adminDb.collection('registrations')
        .where('organizerUid', '==', organizerUid)
      const q = scope.slug ? base.where('eventSlug', '==', scope.slug) : base
      const agg = await q
        .aggregate({ total: AggregateField.sum('discountAmount') })
        .get()
      const total = agg.data().total
      totalDiscountPaise = typeof total === 'number' && Number.isFinite(total) ? total : 0
    } catch {
      // Needs (organizerUid[, eventSlug], discountAmount) — an aggregation index must carry
      // the SUMMED field. Declared in firestore.indexes.json; until it is deployed this
      // stays flagged and the surface says so rather than printing "₹0 of discount given".
      discountUnavailable = true
    }
  }

  return {
    // EXACT whatever the cap did — an aggregate answered these when the documents
    // could not. Never `rows.reduce`, which would now be a sum over a truncated slice.
    totalRedemptions:  exactUses,
    totalCoupons:      exactCount,
    totalDiscountPaise,
    // State-derived, so only ever over the coupons actually read. `statesPartial` says so.
    activeCoupons:     allRows.filter(r => r.active).length,
    redeemableCoupons: allRows.filter(r => r.state === 'redeemable').length,
    stateCounts:       countCouponStates(allRows),
    rows,
    discountUnavailable,
    discountRestricted,
    partial,
    unavailable: readFailed,
    statesPartial,
    spansEvents,
  }
}
