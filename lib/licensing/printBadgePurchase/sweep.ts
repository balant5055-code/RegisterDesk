// RD-PRINT-BILL-P4 · The badge order sweep (cron: /api/cron/badge-orders-reconcile, every 10 min).
// Server-only. Idempotent: every write is a conditional transaction, every settlement is the shared
// settleBadgePayment (which activates once or holds once).
//
//   PENDING walk — created, past checkoutExpiresAt + BADGE_ORDER_GRACE_MS
//     no Razorpay order attached ............ expire (nothing could have been paid) + free the slot
//     Razorpay: captured .................... settle (activate, or durably hold)
//     Razorpay: authorised / unknown ........ leave it; counted; revisited next cycle (never assumed unpaid)
//     Razorpay: nothing ..................... expire + free the slot (conditional on unchanged state)
//   EXPIRED walk — expired and still watched (lateCaptureWatch === true) — RD-PRINT-BILL-P4.2
//     Razorpay: captured .................... settle ⇒ HELD for review (an expired order never activates)
//     past LATE_CAPTURE_WATCH_MS + Razorpay confirms nothing captured or authorised
//                                            ⇒ retire the watch (lateCaptureWatch=false; conditional)
//     authorised / unknown .................. keep watching (never assumed unpaid)
//
// ═══ PROGRESS (RD-PRINT-BILL-P4.4) ═════════════════════════════════════════════
// Each walk visits its set in DOCUMENT-ID order from its OWN cursor in system/printBadgeOrderSweep
// ({ pending: { cursor, version }, expired: { cursor, version } }) — the two never share progress.
//   • time budget: each walk stops starting new orders at its deadline (pending: half the budget,
//     expired: the whole budget; default 40 s of the route's 60 s), leaving time to save progress;
//   • checkpoints: progress is saved every CHECKPOINT_EVERY orders and when the walk stops, ALWAYS at the
//     last order actually processed — an order is never recorded as visited before it was. A run killed
//     between checkpoints loses only the un-checkpointed tail, which the next run re-visits (idempotent);
//   • compare-and-set: a checkpoint commits only if the walk's `version` is still the one this run
//     read (then version + 1). A run whose version changed — another run checkpointed first — stops
//     at once and writes nothing, so a stale run can never move a newer cursor;
//   • wrap: a page that ended because the set ran out (fewer than `limit`, none skipped by the
//     deadline) resets the cursor to the start. Every order in the set is therefore reached within
//     ⌈set ÷ processed-per-run⌉ runs; orders added behind the cursor are reached on the next cycle,
//     and orders that leave the set (expired, paid, retired, held) simply stop appearing;
//   • a query failure throws before anything is processed — nothing is checkpointed;
//   • one order's error is counted and the walk moves on (it is revisited next cycle) — a single
//     failing order can never stall the walk for every order behind it.
// Equality filters + document-id order only (no composite index is declared for them — see
// docs: Firestore index merging; unverifiable on the emulator).
//
// ═══ RAZORPAY LOOKUPS (RD-PRINT-BILL-P4.6) ═════════════════════════════════════
// The Razorpay SDK sets no HTTP timeout, so each sweep lookup is raced against LOOKUP_TIMEOUT_MS
// (8 s): a timeout is an UNKNOWN outcome — never "unpaid", never a settlement — and the order is
// revisited next cycle. Only the READ is raced: settlement / expiry run only after a lookup that
// finished in time, so a lookup that times out has no continuation and can never mutate an order or
// a checkpoint when it eventually settles (its late result is discarded). JavaScript cannot cancel
// the SDK's request, so a circuit breaker bounds the dangling ones: after
// MAX_CONSECUTIVE_LOOKUP_TIMEOUTS consecutive timeouts the run stops looking up (the pending walk
// halts at that order; the expired walk is skipped for this run) — at most that many requests can be
// left in flight per invocation, and they end with the function instance.
// Time: the pending walk stops starting orders at budget/2 − LOOKUP_TIMEOUT_MS (12 s), so even a slow
// last lookup ends by ~20 s and the expired walk keeps the rest of the 40 s budget; the expired walk's
// last lookup can end by ~48 s, inside the route's 60 s.
// It never refunds, never edits a snapshot and never touches a paid order.

import { FieldPath, FieldValue, type QueryDocumentSnapshot, type Query } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import { captureFinancialError } from '@/lib/monitoring/sentry'
import { LICENSE_ORDERS_COLLECTION } from '../schema'
import { findCapturedLicensePayment, type CaptureLookup } from '../activationSelfHeal'
import { BADGE_ORDER_PURPOSE, BADGE_ORDER_GRACE_MS } from './pricing'
import { expireBadgeOrder } from './orders'
import { settleBadgePayment } from './settle'
import { badgeOrderRef, type BadgeOrderDoc } from './orderDoc'

/** Both walks' cursors: { pending: WalkState, expired: WalkState }. */
export const BADGE_SWEEP_STATE_PATH = 'system/printBadgeOrderSweep'

/** How long an expired order keeps being checked for a late capture the webhook may have missed. */
export const LATE_CAPTURE_WATCH_MS = 7 * 24 * 3_600_000
/** Default execution budget: well inside the cron route's maxDuration of 60 s. */
export const SWEEP_BUDGET_MS = 40_000
/** Progress is saved at least this often (orders processed). */
export const CHECKPOINT_EVERY = 25
/** RD-PRINT-BILL-P4.6 — one Razorpay lookup may take at most this long (then: unknown). */
export const LOOKUP_TIMEOUT_MS = 8_000
/** After this many CONSECUTIVE lookup timeouts the run stops making lookups (bounded in-flight requests). */
export const MAX_CONSECUTIVE_LOOKUP_TIMEOUTS = 2

export type SweepLookup = CaptureLookup | { state: 'timeout' }

/**
 * Race one capture lookup against `ms`. A timeout resolves `{ state: 'timeout' }`; a rejection is
 * mapped to 'unknown' (findCapturedLicensePayment itself never throws). The losing promise is
 * detached: its eventual result or error is discarded, and nothing awaits it.
 */
export async function lookupWithTimeout(lookup: () => Promise<CaptureLookup>, ms: number): Promise<SweepLookup> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const work = lookup().catch((): CaptureLookup => ({ state: 'unknown' }))
  const timeout = new Promise<SweepLookup>(resolve => { timer = setTimeout(() => resolve({ state: 'timeout' }), ms) })
  try {
    return await Promise.race([work, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export type SweepWalkName = 'pending' | 'expired'
export interface WalkState { cursor: string | null; version: number }

export interface WalkReport {
  /** Orders processed this run (each one attempted, in order). */
  processed: number
  /** The cursor this run left committed (null ⇒ the next run starts from the beginning). */
  cursor: string | null
  wrapped: boolean
  /** 'gateway' — RD-PRINT-BILL-P4.6: stopped after consecutive Razorpay lookup timeouts. */
  stoppedBy: 'deadline' | 'stale' | 'gateway' | null
}

export interface BadgeSweepResult {
  scanned: number; expired: number; settled: number; held: number
  waitingAuthorized: number; unknown: number; lateChecked: number; errors: number
  /** RD-PRINT-BILL-P4.2 — late-capture walk: watches retired this run, and where the next run resumes. */
  watchRetired: number; lateCursor: string | null; lateWrapped: boolean
  /** RD-PRINT-BILL-P4.4 — per-walk progress. */
  pending: WalkReport; late: WalkReport
  /** RD-PRINT-BILL-P4.6 — lookups that timed out (treated as unknown), and whether the breaker tripped. */
  lookupTimeouts: number; gatewayHalted: boolean
}

const stateRef = () => adminDb.doc(BADGE_SWEEP_STATE_PATH)
const readWalk = (data: unknown, walk: SweepWalkName): WalkState => {
  const w = (data && typeof data === 'object' ? (data as Record<string, unknown>)[walk] : undefined) as Partial<WalkState> | undefined
  return {
    cursor: typeof w?.cursor === 'string' ? w.cursor : null,
    version: typeof w?.version === 'number' && Number.isInteger(w.version) && w.version >= 0 ? w.version : 0,
  }
}

export async function readSweepWalk(walk: SweepWalkName): Promise<WalkState> {
  const snap = await stateRef().get()
  return readWalk(snap.exists ? snap.data() : undefined, walk)
}

/**
 * Compare-and-set: commit `cursor` for `walk` ONLY if its stored version is still `expectedVersion`.
 * Returns the new version, or null when another run checkpointed first (nothing written).
 */
export async function commitSweepCheckpoint(walk: SweepWalkName, expectedVersion: number, cursor: string | null): Promise<number | null> {
  return adminDb.runTransaction(async txn => {
    const snap = await txn.get(stateRef())
    const cur = readWalk(snap.exists ? snap.data() : undefined, walk)
    if (cur.version !== expectedVersion) return null
    const version = expectedVersion + 1
    txn.set(stateRef(), { [walk]: { cursor, version, updatedAt: FieldValue.serverTimestamp() } }, { merge: true })
    return version
  })
}

/** Walk one page of `base` from the walk's cursor, checkpointing as described in the header. */
async function walkPage(walk: SweepWalkName, base: Query, o: {
  limit: number; deadline: number; clock: () => number; checkpointEvery: number
}, processOne: (d: QueryDocumentSnapshot) => Promise<void | 'halt'>): Promise<WalkReport> {
  const start = await readSweepWalk(walk)
  let q = base.orderBy(FieldPath.documentId())
  if (start.cursor) q = q.startAfter(start.cursor)
  const page = await q.limit(o.limit).get()                // a failure throws: nothing processed, nothing saved
  let version = start.version
  let committed = start.cursor
  let last: string | null = null
  let since = 0
  let processed = 0
  let stoppedBy: WalkReport['stoppedBy'] = null
  for (const d of page.docs) {
    if (o.clock() >= o.deadline) { stoppedBy = 'deadline'; break }
    const signal = await processOne(d)
    last = d.id; processed++; since++
    if (signal === 'halt') { stoppedBy = 'gateway'; break }                // this order WAS processed (unknown)
    if (since >= o.checkpointEvery) {
      const v = await commitSweepCheckpoint(walk, version, last)
      if (v === null) return { processed, cursor: committed, wrapped: false, stoppedBy: 'stale' }
      version = v; committed = last; since = 0
    }
  }
  const wrapped = stoppedBy === null && page.size < o.limit
  const final = wrapped ? null : (last ?? committed)
  if (final !== committed) {
    const v = await commitSweepCheckpoint(walk, version, final)
    if (v === null) return { processed, cursor: committed, wrapped: false, stoppedBy: 'stale' }
    committed = final
  }
  return { processed, cursor: committed, wrapped, stoppedBy }
}

/** Retire a late-capture watch — only while the order is still exactly an unheld, expired, watched badge order. */
async function retireLateCaptureWatch(orderId: string, razorpayOrderId: string): Promise<boolean> {
  const ref = badgeOrderRef(orderId)
  return adminDb.runTransaction(async txn => {
    const cur = await txn.get(ref)
    const c = cur.exists ? cur.data() as BadgeOrderDoc : undefined
    if (!c || c.purpose !== BADGE_ORDER_PURPOSE || c.status !== 'expired' || c.lateCaptureWatch !== true
      || c.manualRefundHoldId != null || c.razorpayOrderId !== razorpayOrderId) return false
    txn.update(ref, { lateCaptureWatch: false, lateCaptureWatchEndedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() })
    return true
  })
}

const tsMs = (v: unknown): number | null =>
  v && typeof (v as { toMillis?: () => number }).toMillis === 'function' ? (v as { toMillis: () => number }).toMillis() : null

export async function sweepBadgeOrders(opts: {
  limit?: number; nowMs?: number
  /** RD-PRINT-BILL-P4.4 — execution budget (ms) and checkpoint interval; `clock` measures the budget. */
  budgetMs?: number; checkpointEvery?: number; clock?: () => number
  /** RD-PRINT-BILL-P4.6 — per-lookup timeout (ms); default LOOKUP_TIMEOUT_MS. */
  lookupTimeoutMs?: number
} = {}): Promise<BadgeSweepResult> {
  const nowMs = opts.nowMs ?? Date.now()
  const limit = Math.max(1, Math.min(opts.limit ?? 200, 500))
  const clock = opts.clock ?? Date.now
  const startedAt = clock()
  const budget = Math.max(0, opts.budgetMs ?? SWEEP_BUDGET_MS)
  const every = Math.max(1, Math.min(opts.checkpointEvery ?? CHECKPOINT_EVERY, limit))
  const r = { scanned: 0, expired: 0, settled: 0, held: 0, waitingAuthorized: 0, unknown: 0, lateChecked: 0, errors: 0, watchRetired: 0, lookupTimeouts: 0 }
  const col = adminDb.collection(LICENSE_ORDERS_COLLECTION)
  const lookupMs = Math.max(1, opts.lookupTimeoutMs ?? LOOKUP_TIMEOUT_MS)

  // RD-PRINT-BILL-P4.6 — every Razorpay lookup is time-boxed; consecutive timeouts trip a breaker for the run.
  let consecutiveTimeouts = 0
  let gatewayHalted = false
  const lookup = async (razorpayOrderId: string, amountPaise: number): Promise<SweepLookup> => {
    const res = await lookupWithTimeout(() => findCapturedLicensePayment(razorpayOrderId, amountPaise), lookupMs)
    if (res.state === 'timeout') {
      r.lookupTimeouts++
      if (++consecutiveTimeouts >= MAX_CONSECUTIVE_LOOKUP_TIMEOUTS) gatewayHalted = true
    } else consecutiveTimeouts = 0
    return res
  }

  // ── PENDING walk: stops STARTING orders at budget/2 − one lookup, so its last lookup ends by ~budget/2 ──
  const pending = await walkPage('pending', col.where('purpose', '==', BADGE_ORDER_PURPOSE).where('status', '==', 'created'),
    { limit, deadline: startedAt + Math.max(0, Math.floor(budget / 2) - lookupMs), clock, checkpointEvery: every }, async d => {
      const o = { ...(d.data() as BadgeOrderDoc), orderId: d.id }
      const exp = tsMs(o.checkoutExpiresAt)
      if (exp === null || exp + BADGE_ORDER_GRACE_MS > nowMs) return          // still inside its window
      r.scanned++
      try {
        if (!o.razorpayOrderId) { if (await expireBadgeOrder(o.orderId, null)) r.expired++; return }
        const found = await lookup(o.razorpayOrderId, o.razorpayAmountPaise)
        if (found.state === 'timeout') { r.unknown++; return gatewayHalted ? 'halt' : undefined }   // unknown — never unpaid
        if (found.state === 'unknown') { r.unknown++; return }
        if (found.state === 'captured' && found.paymentStatus !== 'captured') { r.waitingAuthorized++; return }
        if (found.state === 'none') { if (await expireBadgeOrder(o.orderId, o.razorpayOrderId)) r.expired++; return }
        const s = await settleBadgePayment({
          orderId: o.orderId, razorpayOrderId: o.razorpayOrderId, paymentId: found.paymentId,
          amountPaise: o.razorpayAmountPaise, currency: 'INR', via: 'sweep',
        })
        if (s.kind === 'activated' || s.kind === 'already') r.settled++
        else if (s.kind === 'held' || s.kind === 'duplicate_held') r.held++
      } catch (err) {
        r.errors++
        captureFinancialError(err, { scope: 'badge.sweep', orderId: o.orderId })
      }
    })

  // ── EXPIRED walk (the rest of the budget): late captures on watched expired orders. Skipped for this
  //    run when the breaker tripped (Razorpay is not answering) — its cursor is untouched. ──
  const late: WalkReport = gatewayHalted
    ? { processed: 0, cursor: (await readSweepWalk('expired')).cursor, wrapped: false, stoppedBy: 'gateway' }
    : await walkPage('expired',
    col.where('purpose', '==', BADGE_ORDER_PURPOSE).where('status', '==', 'expired').where('lateCaptureWatch', '==', true),
    { limit, deadline: startedAt + budget, clock, checkpointEvery: every }, async d => {
      const o = { ...(d.data() as BadgeOrderDoc), orderId: d.id }
      if (!o.razorpayOrderId) return
      const at = tsMs(o.expiredAt)
      const pastWindow = at === null || at + LATE_CAPTURE_WATCH_MS < nowMs
      r.lateChecked++
      try {
        const found = await lookup(o.razorpayOrderId, o.razorpayAmountPaise)
        if (found.state === 'timeout') { r.unknown++; return gatewayHalted ? 'halt' : undefined }   // never retired, never settled
        if (found.state === 'unknown') { r.unknown++; return }                // never assumed unpaid
        if (found.state === 'captured' && found.paymentStatus !== 'captured') { r.waitingAuthorized++; return }
        if (found.state === 'none') {
          if (pastWindow && await retireLateCaptureWatch(o.orderId, o.razorpayOrderId)) r.watchRetired++
          return
        }
        const s = await settleBadgePayment({
          orderId: o.orderId, razorpayOrderId: o.razorpayOrderId, paymentId: found.paymentId,
          amountPaise: o.razorpayAmountPaise, currency: 'INR', via: 'sweep',
        })
        if (s.kind === 'held' || s.kind === 'duplicate_held') r.held++
      } catch (err) {
        r.errors++
        captureFinancialError(err, { scope: 'badge.sweep_late', orderId: o.orderId })
      }
    })

  return { ...r, lateCursor: late.cursor, lateWrapped: late.wrapped, pending, late, gatewayHalted }
}
