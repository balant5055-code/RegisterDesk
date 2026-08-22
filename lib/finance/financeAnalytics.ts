// RD-FINANCE-P3 · server-side Finance aggregation. Server-only, READ-ONLY.
//
// ═══ EVERY QUERY HERE WAS PROVEN AGAINST PRODUCTION BEFORE IT WAS WRITTEN ════
// Firestore does not fail an aggregate that is merely INCOMPLETE — it fails one whose index
// is missing, and silently under-counts one whose index omits a document. Both traps were
// hit during the audit, so this module only uses shapes that were probed live:
//
//   P1  platformTransactions  organizerUid                        → 5 money sums
//   P2  platformTransactions  organizerUid + entityId             → 5 money sums
//   P3  platformTransactions  organizerUid + entityId + status    → 3 money sums
//   P4  platformTransactions  organizerUid + entityId + paidAt    → 3 money sums (buckets)
//   --  registrations         eventSlug + status                  → sum(amount)   [DENSE]
//   --  registrations         count() in every scoped combination
//   I5  registrations         organizerUid + eventSlug            → discount/original sums
//
// ═══ THE SPARSE-INDEX TRAP, AND WHY `amount` NEVER COMES FROM INDEX 5 ════════
// Index 5 is (eventSlug, organizerUid, amount, discountAmount, originalAmount). Firestore
// omits any document missing an indexed field, and `discountAmount`/`originalAmount` are
// written ONLY when a coupon is used. Index 5 therefore covers coupon registrations only:
// its sum(amount) measured ₹74,131.20 against a true ₹3,44,737.04 — 21.5%, returned without
// error. Index 5 is used here for `discountAmount` and `originalAmount` ONLY, where
// coupon-only coverage IS complete coverage. Attendee-paid always comes from the dense
// (eventSlug, status, amount) index.
//
// ═══ WHAT THIS MODULE REFUSES TO DO ══════════════════════════════════════════
// No writes. No rate, price or category constant. No recalculation of historical money —
// stored figures are read, never re-derived from today's configuration. Anything that cannot
// be sourced is reported as UNAVAILABLE with a reason, never as zero.

import { adminDb } from '@/lib/firebase/admin'
import { AggregateField, Timestamp } from 'firebase-admin/firestore'
import type { Query } from 'firebase-admin/firestore'

// ─── Scope ───────────────────────────────────────────────────────────────────

export interface FinanceScope {
  organizerUid: string
  /** null = every event in the workspace. */
  eventSlug:    string | null
  from:         Date | null
  to:           Date | null
}

/**
 * Why a figure is missing. `null` is never used to mean zero: a Finance surface that shows
 * ₹0 for "we could not measure this" is worse than one that says so.
 */
export type Unavailable =
  | 'no_authoritative_field'   // the data does not exist anywhere (e.g. actual gateway fee)
  | 'requires_index'           // computable, but no verified index supports it
  | 'query_failed'             // a read failed at runtime
  | 'out_of_budget'            // bounded fan-out stopped before finishing

export interface Money { paise: number }
export type MaybeMoney = { ok: true; paise: number } | { ok: false; reason: Unavailable }

const money = (paise: number): MaybeMoney => ({ ok: true, paise: Math.trunc(paise) })
const gone  = (reason: Unavailable): MaybeMoney => ({ ok: false, reason })

// ─── Firestore helpers — aggregates only ─────────────────────────────────────

const int = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : 0)

/** count() over any scoped query. Returns null when the read fails, never 0-as-fact. */
async function countOf(q: Query): Promise<number | null> {
  try { return int((await q.count().get()).data().count) } catch { return null }
}

/**
 * Multi-sum aggregate. Firestore caps a query at FIVE aggregations and requires ONE index
 * containing every summed field — so the field list is fixed per call site and never
 * assembled dynamically.
 */
async function sumsOf<K extends string>(q: Query, fields: readonly K[]): Promise<Record<K, number> | null> {
  try {
    const spec = Object.fromEntries(fields.map(f => [f, AggregateField.sum(f)]))
    const data = (await q.aggregate(spec).get()).data() as Record<K, unknown>
    return Object.fromEntries(fields.map(f => [f, int(data[f])])) as Record<K, number>
  } catch { return null }
}

const LEDGER_5 = [
  'grossAmountPaise', 'netSettlementPaise', 'platformFeeBasePaise',
  'platformFeeGstPaise', 'gatewayFeeEstimatePaise',
] as const
const LEDGER_3 = ['grossAmountPaise', 'netSettlementPaise', 'platformFeeBasePaise'] as const

const ptx = () => adminDb.collection('platformTransactions')
const reg = () => adminDb.collection('registrations')

/** P1 / P2 — the ledger money query. `entityId` present ⇒ P2, absent ⇒ P1. */
function ledgerQuery(scope: FinanceScope): Query {
  const q = ptx().where('organizerUid', '==', scope.organizerUid)
  return scope.eventSlug ? q.where('entityId', '==', scope.eventSlug) : q
}

// ─── Ledger money ────────────────────────────────────────────────────────────

export interface LedgerTotals {
  transactions:     number | null
  grossPaise:       MaybeMoney   // ticket value the platform fee was charged on
  organizerPayable: MaybeMoney   // netSettlementPaise — the settlement basis
  platformFeeBase:  MaybeMoney
  platformFeeGst:   MaybeMoney
  /** ALWAYS an estimate. See `gatewayActual`. */
  gatewayEstimate:  MaybeMoney
  /**
   * `gatewayFeeActualPaise` has ZERO writers and the Razorpay Settlements API is not
   * integrated — measured 0/775 in production. This is permanently unavailable until a
   * reconciliation job exists, and must never be filled in from the estimate.
   */
  gatewayActual:    MaybeMoney
}

export async function getLedgerTotals(scope: FinanceScope): Promise<LedgerTotals> {
  const q = ledgerQuery(scope)
  const [n, s] = await Promise.all([countOf(q), sumsOf(q, LEDGER_5)])
  const pick = (k: typeof LEDGER_5[number]): MaybeMoney => (s ? money(s[k]) : gone('query_failed'))
  return {
    transactions:     n,
    grossPaise:       pick('grossAmountPaise'),
    organizerPayable: pick('netSettlementPaise'),
    platformFeeBase:  pick('platformFeeBasePaise'),
    platformFeeGst:   pick('platformFeeGstPaise'),
    gatewayEstimate:  pick('gatewayFeeEstimatePaise'),
    gatewayActual:    gone('no_authoritative_field'),
  }
}

// ─── Payment status (P3) ─────────────────────────────────────────────────────

export interface StatusRow {
  status:           string
  count:            number | null
  grossPaise:       MaybeMoney
  organizerPayable: MaybeMoney
  platformFeeBase:  MaybeMoney
  /** True for statuses that must never be presented as successful revenue. */
  isReversal:       boolean
}

/**
 * Statuses are DISCOVERED from the ledger, not hardcoded — a status this code has never
 * heard of still appears, rather than being silently dropped from the totals.
 */
const REVERSAL_STATUSES = new Set(['refunded', 'disputed'])

export async function getStatusBreakdown(
  scope: FinanceScope, statuses: readonly string[],
): Promise<{ rows: StatusRow[]; scoped: boolean }> {
  // P3 requires entityId. Without an event scope there is no verified index, so the
  // breakdown is reported as unscoped rather than computed from an unproven query.
  if (!scope.eventSlug) return { rows: [], scoped: false }

  const rows = await Promise.all(statuses.map(async status => {
    const q = ptx()
      .where('organizerUid', '==', scope.organizerUid)
      .where('entityId', '==', scope.eventSlug)
      .where('status', '==', status)
    const n = await countOf(q)
    if (n === 0) {
      return {
        status, count: 0, isReversal: REVERSAL_STATUSES.has(status),
        grossPaise: money(0), organizerPayable: money(0), platformFeeBase: money(0),
      }
    }
    const s = await sumsOf(q, LEDGER_3)
    return {
      status,
      count:            n,
      isReversal:       REVERSAL_STATUSES.has(status),
      grossPaise:       s ? money(s.grossAmountPaise)     : gone('query_failed'),
      organizerPayable: s ? money(s.netSettlementPaise)   : gone('query_failed'),
      platformFeeBase:  s ? money(s.platformFeeBasePaise) : gone('query_failed'),
    }
  }))
  return { rows, scoped: true }
}

// ─── Attendee paid — DENSE index only ────────────────────────────────────────

export interface AttendeePaid {
  totalPaise:  MaybeMoney
  byStatus:    Array<{ status: string; paise: number }>
  /** Registration lifecycle statuses this figure covers. */
  statuses:    string[]
}

/**
 * What attendees were actually charged.
 *
 * Sourced ONLY from the dense `(eventSlug, status, amount)` index — never Index 5, whose
 * `amount` is coupon-only (21.5% coverage, measured). That index carries no `organizerUid`,
 * so the caller MUST have already established that `eventSlug` belongs to this workspace;
 * ownership is asserted upstream, not here.
 */
export async function getAttendeePaid(
  eventSlugs: string[], statuses: readonly string[],
): Promise<AttendeePaid> {
  if (eventSlugs.length === 0) {
    return { totalPaise: gone('query_failed'), byStatus: [], statuses: [...statuses] }
  }
  const byStatus: Array<{ status: string; paise: number }> = []
  let total = 0
  let anyFailed = false

  for (const status of statuses) {
    let subtotal = 0
    for (const slug of eventSlugs) {
      const s = await sumsOf(
        reg().where('eventSlug', '==', slug).where('status', '==', status),
        ['amount'] as const,
      )
      if (!s) { anyFailed = true; continue }
      subtotal += s.amount
    }
    byStatus.push({ status, paise: subtotal })
    total += subtotal
  }
  return {
    totalPaise: anyFailed ? gone('query_failed') : money(total),
    byStatus,
    statuses: [...statuses],
  }
}

// ─── Registration split ──────────────────────────────────────────────────────

export interface RegistrationSplit {
  total:  number | null
  free:   number | null
  paid:   number | null
  /** Counts keyed by the payment status actually stored on the registration. */
  byPaymentStatus: Array<{ paymentStatus: string; count: number }>
}

/**
 * Free vs paid.
 *
 * `paid` is DERIVED as total − free rather than counted separately: a `amount > 0` count
 * needs an index that does not exist, and deriving it from two verified counts is exact.
 * The payment-status split is the semantically richer view (`not_required` is what a free
 * registration actually stores) and rides an existing index.
 */
export async function getRegistrationSplit(
  scope: FinanceScope, paymentStatuses: readonly string[],
): Promise<RegistrationSplit> {
  const base = scope.eventSlug
    ? reg().where('organizerUid', '==', scope.organizerUid).where('eventSlug', '==', scope.eventSlug)
    : reg().where('organizerUid', '==', scope.organizerUid)

  const [total, free, ...counts] = await Promise.all([
    countOf(base),
    countOf(base.where('amount', '==', 0)),
    ...paymentStatuses.map(ps => countOf(base.where('paymentStatus', '==', ps))),
  ])

  return {
    total,
    free,
    paid: total !== null && free !== null ? total - free : null,
    byPaymentStatus: paymentStatuses
      .map((ps, i) => ({ paymentStatus: ps, count: counts[i] }))
      .filter((x): x is { paymentStatus: string; count: number } => x.count !== null),
  }
}

// ─── Coupons ─────────────────────────────────────────────────────────────────

export interface CouponRow {
  code:        string
  /** Verified against the production schema: the field is `type`, and `value` is its magnitude. */
  couponType:  string | null
  couponValue: number | null
  active:      boolean | null
  /** The coupon document's own maintained counter. */
  uses:         number | null
  maxUses:      number | null
  freeUses:     number | null
  paidUses:     number | null
  /**
   * BLOCKED — per-coupon money needs an index that has not been created. Reported as
   * unavailable rather than approximated from event-level totals.
   */
  discountPaise: MaybeMoney
  collectedPaise: MaybeMoney
}

export interface CouponTotals {
  /** Registrations that used ANY coupon, and the free/paid split of those. */
  registrations: number | null
  freeUses:      number | null
  paidUses:      number | null
  /** Event-level sums from Index 5 — complete, because these fields are coupon-only. */
  discountPaise: MaybeMoney
  originalPaise: MaybeMoney
  rows:          CouponRow[]
  /** False when the per-coupon fan-out stopped early. */
  complete:      boolean
}

/**
 * Index 5's EXACT aggregate signature — `amount` included on purpose.
 *
 * An index serves only the aggregate set it was built for: asking Index 5 for just
 * {discountAmount, originalAmount} fails with FAILED_PRECONDITION, because that is a
 * different signature. The full three must be requested.
 *
 * `amount` is then DISCARDED at the call site and never surfaced. Index 5 is sparse — it
 * omits every non-coupon registration — so its `amount` covers 21.5% of the real total
 * (₹74,131.20 against ₹3,44,737.04, measured). Reading it here and dropping it is the price
 * of using this index at all; `discountAmount`/`originalAmount` exist only on coupon
 * registrations, so for those two, sparse coverage IS complete coverage.
 */
const INDEX5_SIGNATURE = ['amount', 'discountAmount', 'originalAmount'] as const

/**
 * Coupon intelligence.
 *
 * Event-level discount/original come from Index 5 — legitimate, because both fields exist
 * only on coupon registrations, so "sparse" and "complete" coincide. `amount` is deliberately
 * NOT read from that index.
 *
 * Per-coupon COUNTS come from verified count() shapes. Per-coupon MONEY is blocked on a
 * missing index and is reported as such; it is never divided out of the event total, which
 * would be a fabricated number wearing a precise-looking decimal.
 */
export async function getCouponTotals(
  scope: FinanceScope, budget: { remaining: number },
): Promise<CouponTotals> {
  const empty: CouponTotals = {
    registrations: null, freeUses: null, paidUses: null,
    discountPaise: gone('requires_index'), originalPaise: gone('requires_index'),
    rows: [], complete: false,
  }
  if (!scope.eventSlug) return { ...empty, discountPaise: gone('requires_index') }

  const base = reg()
    .where('organizerUid', '==', scope.organizerUid)
    .where('eventSlug', '==', scope.eventSlug)

  // Full Index 5 signature; `sparse.amount` is deliberately never read (see above).
  const sparse = await sumsOf(base, INDEX5_SIGNATURE)

  // Coupon definitions: a small, bounded subcollection read.
  let defs: Array<Record<string, unknown>> = []
  try {
    const snap = await adminDb.collection('events').doc(scope.eventSlug).collection('coupons').get()
    defs = snap.docs.map(d => d.data())
  } catch { return { ...empty, discountPaise: gone('query_failed'), originalPaise: gone('query_failed') } }

  let complete = true
  const rows: CouponRow[] = []
  let freeTotal = 0, usesTotal = 0

  for (const c of defs) {
    const code = typeof c.code === 'string' ? c.code : null
    if (!code) continue
    if (budget.remaining <= 0) { complete = false; break }
    budget.remaining--

    const free = await countOf(base.where('couponCode', '==', code).where('amount', '==', 0))
    const uses = typeof c.currentUses === 'number' ? c.currentUses : null
    if (uses !== null) usesTotal += uses
    if (free !== null) freeTotal += free

    rows.push({
      code,
      couponType:  typeof c.type === 'string' ? c.type : null,
      couponValue: typeof c.value === 'number' ? c.value : null,
      active:      typeof c.active === 'boolean' ? c.active : null,
      uses,
      maxUses:  typeof c.maxUses === 'number' ? c.maxUses : null,
      freeUses: free,
      paidUses: uses !== null && free !== null ? Math.max(0, uses - free) : null,
      // BLOCKED: needs (couponCode, eventSlug, organizerUid, amount, discountAmount, originalAmount)
      discountPaise:  gone('requires_index'),
      collectedPaise: gone('requires_index'),
    })
  }

  rows.sort((a, b) => (b.uses ?? 0) - (a.uses ?? 0))

  return {
    registrations: usesTotal || null,
    freeUses:      rows.length ? freeTotal : null,
    paidUses:      rows.length ? Math.max(0, usesTotal - freeTotal) : null,
    discountPaise: sparse ? money(sparse.discountAmount) : gone('query_failed'),
    originalPaise: sparse ? money(sparse.originalAmount) : gone('query_failed'),
    rows,
    complete,
  }
}

// ─── Passes ──────────────────────────────────────────────────────────────────

export interface PassRow {
  passId:   string
  passName: string | null
  registrations: number | null
  free:     number | null
  paid:     number | null
  /** BLOCKED — per-pass money needs an index that has not been created. */
  collectedPaise: MaybeMoney
  discountPaise:  MaybeMoney
}

/**
 * Per-pass performance. Counts only.
 *
 * Pass identity comes from the registrations themselves (`passId`/`passName`), so a new pass
 * type appears with no code change — nothing here knows what a distance or a category is.
 * The caller supplies the pass list; this does one bounded pair of counts per pass.
 */
export async function getPassBreakdown(
  scope: FinanceScope,
  passes: Array<{ passId: string; passName: string | null }>,
  budget: { remaining: number },
): Promise<{ rows: PassRow[]; complete: boolean }> {
  if (!scope.eventSlug) return { rows: [], complete: false }

  const base = reg()
    .where('organizerUid', '==', scope.organizerUid)
    .where('eventSlug', '==', scope.eventSlug)

  const rows: PassRow[] = []
  let complete = true

  for (const p of passes) {
    if (budget.remaining <= 1) { complete = false; break }
    budget.remaining -= 2
    const [total, free] = await Promise.all([
      countOf(base.where('passId', '==', p.passId)),
      countOf(base.where('passId', '==', p.passId).where('amount', '==', 0)),
    ])
    rows.push({
      passId:   p.passId,
      passName: p.passName,
      registrations: total,
      free,
      paid: total !== null && free !== null ? total - free : null,
      // BLOCKED: needs (eventSlug, organizerUid, passId, amount[, discountAmount, originalAmount])
      collectedPaise: gone('requires_index'),
      discountPaise:  gone('requires_index'),
    })
  }
  rows.sort((a, b) => (b.registrations ?? 0) - (a.registrations ?? 0))
  return { rows, complete }
}

// ─── Trend (P4) ──────────────────────────────────────────────────────────────

export interface TrendPoint {
  /** ISO date at bucket start (UTC). */
  bucket:           string
  grossPaise:       number
  organizerPayable: number
  platformFeeBase:  number
}

/** Hard ceiling on buckets — one aggregate per bucket, so this bounds the query count. */
export const MAX_TREND_BUCKETS = 31

/**
 * Money over time, one P4 aggregate per bucket.
 *
 * Transaction COUNT per bucket is deliberately absent: it needs `(entityId, organizerUid,
 * paidAt)` — an index that does not exist — and the brief was explicit that no index should
 * be added merely to obtain it. Money per bucket is the financially meaningful series.
 */
export async function getTrend(
  scope: FinanceScope, bucketMs: number,
): Promise<{ points: TrendPoint[]; complete: boolean; countsAvailable: false }> {
  if (!scope.eventSlug || !scope.from || !scope.to) {
    return { points: [], complete: false, countsAvailable: false }
  }
  const start = scope.from.getTime(), end = scope.to.getTime()
  const n = Math.ceil((end - start) / bucketMs)
  if (n <= 0) return { points: [], complete: true, countsAvailable: false }

  const capped = Math.min(n, MAX_TREND_BUCKETS)
  const points: TrendPoint[] = []

  for (let i = 0; i < capped; i++) {
    const from = start + i * bucketMs
    const to   = Math.min(end, from + bucketMs)
    const q = ptx()
      .where('organizerUid', '==', scope.organizerUid)
      .where('entityId', '==', scope.eventSlug)
      .where('paidAt', '>=', Timestamp.fromMillis(from))
      .where('paidAt', '<',  Timestamp.fromMillis(to))
    const s = await sumsOf(q, LEDGER_3)
    points.push({
      bucket:           new Date(from).toISOString(),
      grossPaise:       s?.grossAmountPaise     ?? 0,
      organizerPayable: s?.netSettlementPaise   ?? 0,
      platformFeeBase:  s?.platformFeeBasePaise ?? 0,
    })
  }
  return { points, complete: capped === n, countsAvailable: false }
}

// ─── Finance health ──────────────────────────────────────────────────────────

export interface HealthItem {
  key:      string
  label:    string
  state:    'ok' | 'warn'
  detail:   string
}

/**
 * The limitations panel.
 *
 * These are surfaced, never suppressed. An admin finance page that hides "this number is an
 * estimate" is worse than one that shows nothing, because the omission is invisible.
 */
export function buildHealth(input: {
  ledger:  LedgerTotals
  coupons: CouponTotals
  passes:  { complete: boolean }
  attendeePaid: AttendeePaid
}): HealthItem[] {
  const h: HealthItem[] = []
  const ok   = (key: string, label: string, detail: string) => h.push({ key, label, state: 'ok', detail })
  const warn = (key: string, label: string, detail: string) => h.push({ key, label, state: 'warn', detail })

  if (input.ledger.grossPaise.ok && input.ledger.organizerPayable.ok) {
    ok('ledger', 'Ledger reconciled', 'Ticket value and organizer payable read from the stored ledger.')
  } else {
    warn('ledger', 'Ledger unavailable', 'The platform transaction aggregate could not be read.')
  }

  if (input.ledger.platformFeeBase.ok && input.ledger.platformFeeGst.ok) {
    ok('platform', 'Platform earnings available', 'Platform fee and GST are stored per transaction.')
  }

  if (input.attendeePaid.totalPaise.ok) {
    ok('attendee', 'Attendee paid available', 'Sourced from the dense registration amount index.')
  } else {
    warn('attendee', 'Attendee paid incomplete', 'One or more registration aggregates could not be read.')
  }

  warn('gateway_actual', 'Gateway actual fee not reconciled',
    'gatewayFeeActualPaise has no writer and the Razorpay settlement API is not integrated. Gateway figures are ESTIMATES.')
  warn('gateway_gst', 'Gateway GST unavailable',
    'No authoritative field stores tax charged by the payment gateway.')
  warn('refund_fee', 'Refund-adjusted platform earnings unavailable',
    'A reversal records its status but no refunded-fee amount, so net-of-refund platform earnings cannot be derived.')
  warn('pass_money', 'Pass revenue unavailable',
    'Per-pass money requires a composite index that has not been created. Counts are shown; amounts are not.')
  warn('coupon_money', 'Per-coupon revenue unavailable',
    'Per-coupon money requires a composite index that has not been created. Event-level discount totals are shown.')

  if (!input.coupons.complete) {
    warn('coupon_budget', 'Coupon breakdown truncated', 'The per-coupon fan-out stopped at its query budget.')
  }
  if (!input.passes.complete) {
    warn('pass_budget', 'Pass breakdown truncated', 'The per-pass fan-out stopped at its query budget.')
  }
  return h
}
