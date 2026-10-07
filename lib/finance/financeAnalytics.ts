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
import { PAID_PAYMENT_STATUSES } from '@/lib/registrations/types'
import { registrationRevenueBasisPaise } from '@/lib/registrations/revenueBasis'
import { isInPlaceReversal, IN_PLACE_REVERSAL_STATUSES } from '@/lib/finance/ledgerReversal'
import {
  money, gone, resolveGatewayFee,
  type MaybeMoney, type GatewayResolution,
} from './gatewayFee'
import {
  listOrganizerRefunds, ORGANIZER_REFUND_READ_CAP, type OrganizerRefundRead,
} from '@/lib/refunds/registrationRefunds'
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
 * The money vocabulary and the gateway resolver are PURE and live in ./gatewayFee, so they
 * can be tested without booting the Admin SDK that this module imports at load. They are
 * re-exported here because every existing consumer imports them from this path.
 */
export {
  money, gone, resolveGatewayFee,
  type Unavailable, type Money, type MaybeMoney,
  type GatewayFeeBasis, type GatewayResolution, type CoveredGatewayRows,
} from './gatewayFee'

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

/**
 * count() and sum() in ONE aggregate. Firestore's cap of five spans both kinds together,
 * so a covered-row count rides along with its sums for the price of one round trip.
 */
async function countAndSumsOf<K extends string>(
  q: Query, fields: readonly K[],
): Promise<{ count: number; sums: Record<K, number> } | null> {
  try {
    const spec = {
      __count: AggregateField.count(),
      ...Object.fromEntries(fields.map(f => [f, AggregateField.sum(f)])),
    }
    const data = (await q.aggregate(spec).get()).data() as Record<string, unknown>
    return {
      count: int(data.__count),
      sums:  Object.fromEntries(fields.map(f => [f, int(data[f])])) as Record<K, number>,
    }
  } catch { return null }
}

const LEDGER_5 = [
  'grossAmountPaise', 'netSettlementPaise', 'platformFeeBasePaise',
  'platformFeeGstPaise', 'gatewayFeeEstimatePaise',
] as const
const LEDGER_3 = ['grossAmountPaise', 'netSettlementPaise', 'platformFeeBasePaise'] as const

/**
 * The covered-row aggregate: the gateway facts, plus the ESTIMATE of those same rows.
 *
 * That third sum is not redundant. It is what makes per-transaction resolution
 * expressible as an aggregate at all — see `resolveGatewayFee`.
 */
const GATEWAY_ACTUAL_AGG = [
  'gatewayFeeActualPaise', 'gatewayTaxPaise', 'gatewayFeeEstimatePaise',
] as const

const ptx     = () => adminDb.collection('platformTransactions')
const reg     = () => adminDb.collection('registrations')

/** P1 / P2 — the ledger money query. `entityId` present ⇒ P2, absent ⇒ P1. */
function ledgerQuery(scope: FinanceScope): Query {
  const q = ptx().where('organizerUid', '==', scope.organizerUid)
  return scope.eventSlug ? q.where('entityId', '==', scope.eventSlug) : q
}

// ─── Ledger money ────────────────────────────────────────────────────────────

export interface LedgerTotals {
  transactions:     number | null
  grossPaise:       MaybeMoney   // ticket value the platform fee was charged on
  /** RD-FIN-02 · the settlement basis: Σ net of every row LESS in-place-reversed (refunded / disputed registration) rows — what the wallet still holds. Not a payout. */
  organizerPayable: MaybeMoney
  /** Σ netSettlementPaise over EVERY row, refunded included (the pre-RD-FIN-02 "payable"). */
  ledgerNetAllRows: MaybeMoney
  /** Σ net of rows reversed in place (registration refunds / disputes) — debited from the wallet. */
  reversedInPlace:  MaybeMoney
  platformFeeBase:  MaybeMoney
  platformFeeGst:   MaybeMoney
  /** RegisterDesk's own fee: base + GST. Contains nothing the GATEWAY charged. */
  platformFeeTotal: MaybeMoney
  /** The recorded estimate, kept beside the resolution and never overwritten by it. */
  gatewayEstimate:  MaybeMoney
  /** Gateway money actually charged, for the rows that carry it. Never inferred. */
  gatewayActual:    MaybeMoney
  /** What the product should read: actual where known, estimate elsewhere, basis stated. */
  gateway:          GatewayResolution
  /**
   * platformFeeTotal + gateway.fee — an AGGREGATE, published alongside its components and
   * never in place of them. Two different companies charged these two fees; a surface that
   * shows only the total tells an organizer nothing it can act on.
   */
  totalFees:        MaybeMoney
}

/**
 * ═══ WHY THE COVERED-ROW QUERY ORDERS BY A SPARSE FIELD ══════════════════════
 * `orderBy` IS the filter. Firestore's index omits every document lacking the field, so
 * ordering by `gatewayFeeActualPaise` selects exactly the reconciled rows — with no
 * inequality filter, and no way for "absent" to be read as "zero".
 *
 * That query needs a composite index (see firestore.indexes.json). Until one is deployed
 * it fails, `countAndSumsOf` returns null, and the resolver falls back to the estimate and
 * says so. It runs inside the same Promise.all as the reads that already happen, so it
 * costs no extra wall-clock, and it starts working the moment the index exists.
 */
export async function getLedgerTotals(scope: FinanceScope): Promise<LedgerTotals> {
  const q = ledgerQuery(scope)
  const [n, s, covered, reversedInPlace] = await Promise.all([
    countOf(q),
    sumsOf(q, LEDGER_5),
    countAndSumsOf(q.orderBy('gatewayFeeActualPaise'), GATEWAY_ACTUAL_AGG),
    getInPlaceReversedNet(scope),
  ])
  const pick = (k: typeof LEDGER_5[number]): MaybeMoney => (s ? money(s[k]) : gone('query_failed'))

  const platformFeeTotal: MaybeMoney = s
    ? money(s.platformFeeBasePaise + s.platformFeeGstPaise)
    : gone('query_failed')

  const gateway = resolveGatewayFee({
    total:       n,
    estimateAll: s ? s.gatewayFeeEstimatePaise : null,
    covered,
  })

  return {
    transactions:     n,
    grossPaise:       pick('grossAmountPaise'),
    // RD-FIN-02 · a refunded registration's net was debited from the wallet when the refund was
    // issued; it is no longer payable. Approved-but-unissued refunds never touch the ledger.
    organizerPayable: !s ? gone('query_failed')
      : !reversedInPlace.ok ? reversedInPlace
      : money(s.netSettlementPaise - reversedInPlace.paise),
    ledgerNetAllRows: pick('netSettlementPaise'),
    reversedInPlace,
    platformFeeBase:  pick('platformFeeBasePaise'),
    platformFeeGst:   pick('platformFeeGstPaise'),
    platformFeeTotal,
    gatewayEstimate:  pick('gatewayFeeEstimatePaise'),
    gatewayActual:    covered === null
      ? gone('requires_index')
      : covered.count === 0
        ? gone('no_authoritative_field')
        : money(covered.sums.gatewayFeeActualPaise),
    gateway,
    totalFees: platformFeeTotal.ok && gateway.fee.ok
      ? money(platformFeeTotal.paise + gateway.fee.paise)
      : gone('query_failed'),
  }
}

export const IN_PLACE_REVERSAL_READ_CAP = 2000

/**
 * RD-FIN-02 · Σ net of rows reversed IN PLACE (lib/finance/ledgerReversal.ts). Same query shape as
 * /finance/transactions?filter=refunds ⇒ the existing (organizerUid, status, paidAt DESC) index; event
 * scope applied in memory. Over the cap it reports out_of_budget rather than a partial sum.
 */
export async function getInPlaceReversedNet(
  scope: Pick<FinanceScope, 'organizerUid' | 'eventSlug'>, cap = IN_PLACE_REVERSAL_READ_CAP,
): Promise<MaybeMoney> {
  const parts = await Promise.all(IN_PLACE_REVERSAL_STATUSES.map(async (status): Promise<MaybeMoney> => {
    try {
      const snap = await ptx().where('organizerUid', '==', scope.organizerUid).where('status', '==', status)
        .orderBy('paidAt', 'desc')
        .select('netSettlementPaise', 'sourceType', 'parentTransactionId', 'entityId', 'status')
        .limit(cap + 1).get()
      if (snap.size > cap) return gone('out_of_budget')
      let p = 0
      for (const d of snap.docs) {
        const x = d.data()
        if (!isInPlaceReversal(x)) continue
        if (scope.eventSlug && x.entityId !== scope.eventSlug) continue
        p += int(x.netSettlementPaise)
      }
      return money(p)
    } catch { return gone('query_failed') }
  }))
  const bad = parts.find(m => !m.ok)
  return bad ?? money(parts.reduce((sum, m) => sum + (m.ok ? m.paise : 0), 0))
}

// ─── Refunds — the gateway refund ledger ─────────────────────────────────────

export interface RefundTotals {
  count:  number | null
  amount: MaybeMoney
  /** Refunds carrying no registration linkage: real money out, no registration to show. */
  unlinked: number | null
  /**
   * Of `count`, how many were recovered from the UNATTRIBUTED pool — refunds stored with
   * no organizerUid, re-attributed here through their payment intent. Normally 0.
   */
  recovered: number | null
  /** False when the ledger exceeded the read cap and the amount was therefore not summed. */
  complete: boolean
}

/**
 * Money actually returned through the gateway.
 *
 * The query, the unattributed-refund recovery and the read cap all live in
 * `lib/refunds/registrationRefunds.ts`, which is also what the reports use. That is
 * deliberate: a refund that shows on this dashboard and not in an export — or the reverse —
 * is the exact class of inconsistency this module exists to prevent. Only the date window,
 * which is a finance-scope concept, is applied here.
 *
 * ═══ A REFUND IS NOT A CANCELLATION ══════════════════════════════════════════
 * Nothing in this path reads a registration status. A cancelled registration may never have
 * been refunded, and a refunded payment can leave its registration standing.
 */
export const REFUND_READ_CAP = ORGANIZER_REFUND_READ_CAP

/** Inside [from, to)? An absent bound does not exclude, and an undated row is kept. */
function withinRange(v: unknown, from: Date | null, to: Date | null): boolean {
  if (!from && !to) return true
  const ms = v instanceof Timestamp ? v.toMillis()
    : v instanceof Date ? v.getTime()
    : typeof v === 'number' ? v
    : null
  if (ms === null) return true
  if (from && ms <  from.getTime()) return false
  if (to   && ms >= to.getTime())   return false
  return true
}

export async function getRefundTotals(scope: FinanceScope): Promise<RefundTotals> {
  const read = await readRefundSource(scope)
  return refundTotalsFromRead(read, scope)
}

/**
 * RD-ANALYTICS-12-32 · the refund SOURCE for a scope, acquired once.
 *
 * `listOrganizerRefunds` reads every refund of the organizer (or event) and the date window
 * is applied afterwards, in memory — so a caller that wants lifetime, this-window and
 * last-window totals from the same ledger has no reason to acquire the ledger three times.
 * This is the one acquisition; `refundTotalsFromRead` is the per-window arithmetic over it.
 * Same query, same cap, same unattributed-refund recovery as before: nothing about WHAT is
 * read changes, only how many times.
 */
export function readRefundSource(scope: Pick<FinanceScope, 'organizerUid' | 'eventSlug'>): Promise<OrganizerRefundRead> {
  return listOrganizerRefunds(scope.organizerUid, { eventSlug: scope.eventSlug })
}

/**
 * The totals for ONE window, derived from an already-acquired read.
 *
 * Byte-for-byte the arithmetic `getRefundTotals` performed inline: the same cap check, the
 * same range test, the same recovered-slice, the same `gone` reasons. Pure — no read.
 */
export function refundTotalsFromRead(read: OrganizerRefundRead, scope: FinanceScope): RefundTotals {
  if (read.ownedCount === null) {
    return { count: null, amount: gone('query_failed'), unlinked: null, recovered: null, complete: false }
  }
  // Over the cap the rows were withheld: the count is still exact, but no amount may be
  // presented — a sum of the rows we happen to hold would read as a total.
  if (!read.complete && read.records.length === 0 && read.ownedCount > REFUND_READ_CAP) {
    return { count: read.ownedCount, amount: gone('out_of_budget'), unlinked: null, recovered: null, complete: false }
  }

  const inRange = read.records.filter(r => withinRange(r.createdAt, scope.from, scope.to))
  const recoveredInRange = read.records
    .slice(read.records.length - read.recovered)
    .filter(r => withinRange(r.createdAt, scope.from, scope.to)).length

  return {
    count:     inRange.length,
    amount:    money(inRange.reduce((sum, r) => sum + int(r.amountPaise), 0)),
    unlinked:  inRange.filter(r => !r.registrationId).length,
    recovered: recoveredInRange,
    complete:  read.complete,
  }
}

/**
 * RD-FIN-02 · the refunds that are subtracted from CONFIRMED revenue — exactly once.
 *
 * "Net after refunds" = Σ ticket basis over confirmed − refunds. A registration that was refunded
 * and then cancelled (or cancelled and then refunded) has ALREADY left confirmed revenue; subtracting
 * its refund too removed the same money twice. So a linked refund counts only while its registration
 * is still confirmed, capped at that registration's ticket basis (a refund of attendee-borne fees is
 * not organizer revenue). An UNLINKED refund is real money out with nothing to net against — kept,
 * as before. Bounded by the refund read's own cap (≤ ORGANIZER_REFUND_READ_CAP point reads).
 */
export async function refundsAgainstConfirmedPaise(read: OrganizerRefundRead): Promise<MaybeMoney> {
  if (read.ownedCount === null) return gone('query_failed')
  if (!read.complete) return gone('out_of_budget')
  const byReg = new Map<string, number>()
  let total = 0
  for (const r of read.records) {
    const a = int(r.amountPaise)
    if (r.registrationId) byReg.set(r.registrationId, (byReg.get(r.registrationId) ?? 0) + a)
    else total += a
  }
  const ids = [...byReg.keys()]
  for (let i = 0; i < ids.length; i += 300) {
    const snaps = await adminDb.getAll(...ids.slice(i, i + 300).map(id => reg().doc(id)),
      { fieldMask: ['status', 'amount', 'attendeeFeePaise'] })
    for (const s of snaps) {
      const refunded = byReg.get(s.id) ?? 0
      if (!s.exists) { total += refunded; continue }
      const d = s.data() as { status?: unknown; amount?: unknown; attendeeFeePaise?: unknown }
      if (d.status !== 'confirmed') continue            // its value already left confirmed revenue
      total += Math.min(refunded, registrationRevenueBasisPaise(d))
    }
  }
  return money(total)
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
  // ═══ RD-DASH-13 · THE SAME SUMS, NO LONGER ONE AT A TIME ═══════════════════
  // This was `for status { for slug { await } }` — statuses × slugs sequential round
  // trips. On the dashboard that was 2 × (events) links in the critical path and a
  // measured contributor to a ~13.7 s projected floor at 50 events.
  //
  // Nothing about the RESULT changes. Each sum is an independent aggregate over a
  // disjoint (eventSlug, status) partition; the accumulation is integer addition, which
  // is commutative and associative, and `anyFailed` is a logical OR. Running them
  // concurrently therefore produces the identical `byStatus`, the identical `total` and
  // the identical failure flag, for any ordering. `byStatus` is still emitted in the
  // caller's status order, because the surfaces read it positionally.
  //
  // Concurrency is CAPPED. An organizer with 50 events and two statuses would otherwise
  // open 100 aggregates at once; this keeps at most 12 outstanding and still collapses
  // the chain from (statuses × slugs) links to ceil(statuses × slugs / 12).
  const CONCURRENCY = 12
  const work = statuses.flatMap(status => eventSlugs.map(slug => ({ status, slug })))
  const results = new Map<string, number>()   // `${status}\u0000${slug}` → paise
  let anyFailed = false

  let next = 0
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, work.length) }, async () => {
    for (;;) {
      const i = next++
      if (i >= work.length) return
      const { status, slug } = work[i]
      const s = await sumsOf(
        reg().where('eventSlug', '==', slug).where('status', '==', status),
        ['amount'] as const,
      )
      // A failed sum contributes NOTHING and raises the flag — exactly as the serial
      // version did with `continue`.
      if (!s) { anyFailed = true; continue }
      results.set(`${status}\u0000${slug}`, s.amount)
    }
  }))

  const byStatus: Array<{ status: string; paise: number }> = []
  let total = 0
  for (const status of statuses) {
    const subtotal = eventSlugs.reduce(
      (n, slug) => n + (results.get(`${status}\u0000${slug}`) ?? 0), 0)
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

  // RD-FIN-02 · "Paid" = charged (PAID_PAYMENT_STATUSES), counted from the stored payment status when
  // all three were requested — the same population Analytics shows. Fallback (legacy callers): total − free.
  const byPs = new Map(paymentStatuses.map((ps, i) => [ps, counts[i]] as const))
  const charged = PAID_PAYMENT_STATUSES.every(ps => byPs.has(ps) && byPs.get(ps) !== null)
    ? PAID_PAYMENT_STATUSES.reduce((s, ps) => s + (byPs.get(ps) as number), 0)
    : null
  return {
    total,
    free,
    paid: charged ?? (total !== null && free !== null ? total - free : null),
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
  refunds: RefundTotals
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

  // Gateway basis is stated, never implied. An organizer reading a fee figure is told
  // whether it is a fact from the gateway or this platform’s own estimate of one.
  const gw = input.ledger.gateway
  if (gw.basis === 'actual') {
    ok('gateway_actual', 'Gateway fee reconciled',
      'Every transaction in scope carries the fee the gateway actually charged.')
  } else if (gw.basis === 'mixed') {
    warn('gateway_actual', 'Gateway fee partly reconciled',
      `${gw.coverage.withActual ?? 0} of ${gw.coverage.total ?? 0} transactions carry an actual gateway fee. The remainder are shown at their recorded ESTIMATE, and the total blends the two.`)
  } else {
    warn('gateway_actual', 'Gateway fee is an estimate',
      'No transaction in scope carries an actual gateway fee, so every gateway figure here is the ' +
      'recorded ESTIMATE. Either no transaction has been reconciled, or the composite index backing the ' +
      'coverage query is missing — see the platformTransactions gateway indexes in firestore.indexes.json.')
  }

  if (gw.tax.ok) {
    ok('gateway_tax', 'Gateway tax available',
      'Reported as the component contained WITHIN the gateway fee — the two are never added together.')
  } else {
    warn('gateway_tax', 'Gateway tax unavailable',
      'No transaction in scope records the tax component of the gateway fee.')
  }

  if (input.refunds.amount.ok) {
    ok('refunds', 'Refund ledger available',
      'Refund count and amount come from the refund ledger itself, independently of registration status.')
    if (input.refunds.recovered) {
      warn('refund_attribution', 'Some refunds carry no stored attribution',
        `${input.refunds.recovered} refund(s) have no organizerUid on the record and were attributed here ` +
        'through their payment intent. They are included in the totals above. Writing the attribution onto ' +
        'those records would make this recovery unnecessary.')
    }
  } else {
    warn('refunds', 'Refund total unavailable',
      input.refunds.complete === false && input.refunds.count !== null
        ? `${input.refunds.count} refunds exceed the bounded read cap, so the amount was not summed.`
        : 'The refund ledger could not be read.')
  }

  warn('refund_fee', 'Refund-adjusted platform earnings unavailable',
    'Refunded AMOUNTS are recorded, but no reversal records how much platform fee was returned with them, ' +
    'so platform earnings net of refunds cannot be derived.')
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
