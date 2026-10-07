// Durable reconciliation for wallet top-ups whose credit failed transiently
// AFTER the Razorpay payment was captured + verified. Server-only.
//
// A captured top-up must never lose funds: if atomicTopupCredit throws (transient
// Firestore error) in the verify route or the webhook, we persist a record here
// and a cron retries the (idempotent) credit until it succeeds. atomicTopupCredit
// is keyed on the topup status + a deterministic ledger id, so retries can never
// double-credit.
//
// RD-WALLET-W1:
//   • the recorder reports whether it persisted (a caller that cannot rely on this record
//     must not acknowledge the payment as handled — the webhook answers non-2xx instead);
//   • the retry re-verifies the payment with Razorpay BEFORE crediting: only a CAPTURED
//     payment for this order, amount and currency is credited. An `authorized` payment stays
//     pending; anything else is held for review (never credited);
//   • records that must not be retried use their own statuses — 'needs_review' (a refusal a
//     retry cannot fix) and 'duplicate_payment' (a second captured payment on an order that
//     was already credited). Only 'pending' is ever replayed.
//
// RD-WALLET-W2.a — retry hygiene (bounded, ordered, observable):
//   • `attempts` counts FAILED credit attempts, the original one included (a record is created
//     with attempts = 1). `nextAttemptAt` is when the cron may try again: 10 min after the
//     first failure, doubling per failure, capped at 6 h (RETRY_POLICY).
//   • At RETRY_POLICY.maxAttempts the record becomes 'exhausted' — never deleted, never retried
//     again, and still UNRESOLVED (the top-up guard keeps blocking new top-ups) until a Super
//     Admin resolves it.
//   • Transient outcomes (gateway lookup failed, payment still `authorized`, a credit
//     transaction error) are rescheduled; permanent ones (mismatch, not captured, a credit
//     refusal) still go straight to 'needs_review'.
//   • The cron processes DUE records in a deterministic order (nextAttemptAt, then document
//     id), a bounded batch per run. Every processed record either leaves 'pending' or moves its
//     nextAttemptAt forward, so records beyond the batch are reached on later runs.
//   • Every state change is a transaction on the record: a recorder call can never reset the
//     retry counters, and a 'needs_review' / 'exhausted' / 'duplicate_payment' record is never
//     downgraded back to 'pending'. `firstSeenAt` is written only when the record is created.
//   • Records written before W2.a have no `nextAttemptAt` and are invisible to the ordered
//     query; a bounded, cursor-paged LEGACY pass gives each one a schedule (due now) first.

import { FieldValue, FieldPath, Timestamp } from 'firebase-admin/firestore'
import { adminDb }    from '@/lib/firebase/admin'
import { captureFinancialError } from '@/lib/monitoring/sentry'
import { atomicTopupCredit, TopupCreditError } from '@/lib/firebase/firestore/wallet'
import { flagSuspiciousPayment } from '@/lib/payments/flagSuspicious'
import { readCursor, writeCursor } from '@/lib/reconciliation/cursor'

const COLLECTION = 'walletTopupReconciliation'

/** RD-WALLET-W2.a — the approved retry settings. */
export const RETRY_POLICY = {
  initialDelayMs: 10 * 60 * 1000,        // 10 minutes
  factor:         2,
  maxDelayMs:     6 * 60 * 60 * 1000,    // 6 hours
  maxAttempts:    12,
} as const

/** Records the cron handles per run, and legacy records normalized per run. */
export const RETRY_BATCH_SIZE  = 100
export const LEGACY_BATCH_SIZE = 100
const LEGACY_CURSOR_KEY = 'walletTopupReconciliation.legacy'

/**
 * Pure. Delay before the next try after `attempts` failed attempts (1-based):
 * 10 min, 20, 40, 80, 160, 320, then capped at 6 h.
 */
export function retryDelayMs(attempts: number): number {
  const n = Math.max(1, Math.floor(attempts))
  const raw = RETRY_POLICY.initialDelayMs * Math.pow(RETRY_POLICY.factor, n - 1)
  return Math.min(raw, RETRY_POLICY.maxDelayMs)
}

export type WalletReconciliationStatus = 'pending' | 'needs_review'

/** Statuses that are final for the retry loop — never downgraded back to 'pending'. */
const HELD_STATUSES = new Set(['needs_review', 'exhausted', 'duplicate_payment'])

export interface RecordWalletReconciliationInput {
  orderId:     string
  uid:         string
  amountPaise: number
  paymentId:   string
  error:       string
  /** Default 'pending' (retried by the cron). 'needs_review' is never retried. */
  status?:     WalletReconciliationStatus
  /** RD-WALLET-W2.c — other payment ids on the order to keep with the record (evidence only). */
  relatedPaymentIds?: string[]
  /**
   * RD-WALLET-W2.c — the refusal code when this write records a credit REFUSAL. Kept on the record
   * as `refusalKeys` ("<code>:<paymentId>") so a caller can tell a redelivery of the same refusal
   * (nothing new — no second flag) from a new payment or a different reason (new evidence).
   */
  refusal?: string
}

/** RD-WALLET-W2.c — what persistWalletTopupReconciliation actually wrote. */
export interface ReconciliationWriteResult {
  persisted:   boolean
  /** The record's status AFTER the write (a held record keeps its own), or null if not persisted. */
  status:      string | null
  /** False only when the record already held this exact refusal (or, without one, this payment). */
  newEvidence: boolean
}

/** RD-WALLET-W2.c — statuses under which the order waits for review (never downgraded, never auto-credited). */
export function isHeldReconciliationStatus(status: unknown): boolean {
  return typeof status === 'string' && HELD_STATUSES.has(status)
}

/**
 * Idempotent by orderId. Never throws. Returns whether the record was PERSISTED — a caller
 * that has nothing else durable (the webhook) must not acknowledge the payment when false.
 *
 * W2.a — create-or-update in a transaction:
 *   • new record → attempts 1, firstSeenAt now, nextAttemptAt now + 10 min (pending only);
 *   • existing 'pending' → only lastError/updatedAt change (the cron owns the schedule), or it
 *     is escalated to 'needs_review' when the caller says so;
 *   • existing held record (needs_review / exhausted / duplicate_payment) → never downgraded;
 *   • existing 'resolved'/'skipped' → a NEW failure on that order re-opens it as pending with a
 *     fresh schedule, keeping the original firstSeenAt.
 */
export async function recordWalletTopupReconciliation(input: RecordWalletReconciliationInput): Promise<boolean> {
  return (await persistWalletTopupReconciliation(input)).persisted
}

/** Same write as recordWalletTopupReconciliation, reporting the resulting status and whether it added evidence. */
export async function persistWalletTopupReconciliation(input: RecordWalletReconciliationInput): Promise<ReconciliationWriteResult> {
  const status = input.status ?? 'pending'
  const ref = adminDb.collection(COLLECTION).doc(input.orderId)
  try {
    const written = await adminDb.runTransaction(async (tx): Promise<{ status: string; newEvidence: boolean }> => {
      const snap = await tx.get(ref)
      const now  = Date.now()
      const base = {
        orderId:     input.orderId,
        uid:         input.uid,
        amountPaise: input.amountPaise,
        paymentId:   input.paymentId,
        lastError:   input.error.slice(0, 500),
        updatedAt:   FieldValue.serverTimestamp(),
      }
      // RD-WALLET-W2.c — every payment seen for this order is kept (additive evidence): a second
      // late payment on an abandoned / held order must not survive only as a best-effort flag.
      const paymentIds = FieldValue.arrayUnion(input.paymentId, ...(input.relatedPaymentIds ?? []).filter(id => id && id !== input.paymentId))
      const refusalKey = input.refusal ? `${input.refusal}:${input.paymentId}` : null
      const evidence = refusalKey ? { refusalKeys: FieldValue.arrayUnion(refusalKey) } : {}
      if (!snap.exists) {
        tx.create(ref, {
          ...base,
          paymentIds,
          ...evidence,
          status,
          attempts:      1,
          firstSeenAt:   FieldValue.serverTimestamp(),
          lastAttemptAt: FieldValue.serverTimestamp(),
          ...(status === 'pending' ? { nextAttemptAt: Timestamp.fromMillis(now + retryDelayMs(1)) } : {}),
        })
        return { status, newEvidence: true }
      }
      const cur = snap.data() as { status?: unknown; paymentId?: unknown; paymentIds?: unknown; refusalKeys?: unknown }
      const known = (v: unknown, x: string) => Array.isArray(v) && v.includes(x)
      const newEvidence = refusalKey
        ? !known(cur.refusalKeys, refusalKey)
        : !(cur.paymentId === input.paymentId || known(cur.paymentIds, input.paymentId))
      if (typeof cur.status === 'string' && HELD_STATUSES.has(cur.status)) {
        tx.update(ref, { lastError: base.lastError, updatedAt: base.updatedAt, paymentIds, ...evidence })   // never downgraded
        return { status: cur.status, newEvidence }
      }
      if (cur.status === 'pending') {
        tx.update(ref, status === 'needs_review'
          ? { ...base, paymentIds, ...evidence, status: 'needs_review', reviewAt: FieldValue.serverTimestamp() }
          : { lastError: base.lastError, updatedAt: base.updatedAt, paymentIds, ...evidence })
        return { status: status === 'needs_review' ? 'needs_review' : 'pending', newEvidence }
      }
      // 'resolved' / 'skipped' / unknown → a new failure re-opens the record (firstSeenAt kept).
      tx.update(ref, {
        ...base,
        paymentIds,
        ...evidence,
        status,
        attempts:      1,
        lastAttemptAt: FieldValue.serverTimestamp(),
        nextAttemptAt: status === 'pending' ? Timestamp.fromMillis(now + retryDelayMs(1)) : FieldValue.delete(),
      })
      return { status, newEvidence }
    })
    captureFinancialError(input.error, { scope: 'walletTopupReconciliation.recorded', detail: 'wallet credit deferred for retry', orderId: input.orderId, status })
    return { persisted: true, status: written.status, newEvidence: written.newEvidence }
  } catch (e) {
    captureFinancialError(e, { scope: 'walletTopupReconciliation.persist_failed', detail: 'CRITICAL: failed to persist reconciliation record', orderId: input.orderId })
    return { persisted: false, status: null, newEvidence: true }
  }
}

export interface DuplicateTopupPaymentInput {
  orderId:           string
  uid:               string
  amountPaise:       number
  /** The captured payment that was NOT credited (the duplicate). */
  paymentId:         string
  /** The payment the order was credited with, when known. */
  creditedPaymentId: string | null
  source:            'verify' | 'webhook' | 'reconciliation' | 'sweep'
  paymentStatus?:    string
}

/**
 * RD-WALLET-W1 · W1.4 — a second payment on an order that was already credited. It is NOT
 * credited again and NOT refunded automatically (no refund policy exists for top-ups): it is
 * recorded durably for Super Admin review, keyed by the duplicate payment id so every path
 * that sees it (verify, webhook, cron) converges on ONE record, and flagged as a suspicious
 * payment. Never throws; returns whether the record persisted. W2.a — `firstSeenAt` is
 * written only when the record is created.
 */
export async function recordDuplicateTopupPayment(input: DuplicateTopupPaymentInput): Promise<boolean> {
  let persisted = false
  const ref = adminDb.collection(COLLECTION).doc(`dup_${input.paymentId}`)
  try {
    await adminDb.runTransaction(async tx => {
      const snap = await tx.get(ref)
      const fields = {
        orderId:           input.orderId,
        uid:               input.uid,
        amountPaise:       input.amountPaise,
        paymentId:         input.paymentId,
        creditedPaymentId: input.creditedPaymentId,
        paymentStatus:     input.paymentStatus ?? null,
        status:            'duplicate_payment',
        detectedBy:        FieldValue.arrayUnion(input.source),
        lastError:         'second payment on an already-credited top-up order — not credited',
        updatedAt:         FieldValue.serverTimestamp(),
      }
      if (snap.exists) tx.update(ref, fields)
      else tx.create(ref, { ...fields, firstSeenAt: FieldValue.serverTimestamp() })
    })
    persisted = true
  } catch (e) {
    captureFinancialError(e, { scope: 'walletTopupReconciliation.duplicate_persist_failed', detail: 'CRITICAL: duplicate top-up payment not recorded', orderId: input.orderId, paymentId: input.paymentId })
  }
  await flagSuspiciousPayment({
    source: 'wallet_topup', reason: 'duplicate_payment',
    paymentId: input.paymentId, orderId: input.orderId, entityId: input.uid,
    expectedAmountPaise: input.amountPaise, actualAmountPaise: input.amountPaise,
    expectedCurrency: 'INR', actualCurrency: 'INR',
  })
  return persisted
}

export type TopupMismatchReason = 'amount_mismatch' | 'currency_mismatch' | 'amount_and_currency_mismatch'

export interface TopupPaymentMismatchInput {
  orderId:             string
  uid:                 string
  /** The captured payment whose amount / currency does not match the top-up order. */
  paymentId:           string
  expectedAmountPaise: number
  observedAmountPaise: number | null
  expectedCurrency:    string
  observedCurrency:    string | null
  source:              'webhook' | 'verify' | 'sweep' | 'watch'
}

/** Pure — the machine-readable reason for a mismatch (the acceptance rule itself is the caller's). */
export function topupMismatchReason(i: Pick<TopupPaymentMismatchInput, 'expectedAmountPaise' | 'observedAmountPaise' | 'expectedCurrency' | 'observedCurrency'>): TopupMismatchReason {
  const amount   = i.observedAmountPaise !== i.expectedAmountPaise
  const currency = i.observedCurrency !== i.expectedCurrency
  return amount && currency ? 'amount_and_currency_mismatch' : currency ? 'currency_mismatch' : 'amount_mismatch'
}

/**
 * RD-WALLET-W2.b — a CAPTURED payment whose amount or currency does not match its top-up order.
 * Never credited. Recorded durably for Super Admin review in the EXISTING reconciliation
 * collection, keyed by the PAYMENT (`mismatch_{paymentId}`, like `dup_{paymentId}`) — never the
 * order's own record, which may be carrying a legitimate payment's credit retry that a mismatch
 * must not stop.
 *
 *   • created as 'needs_review' (no retry schedule — a mismatch is never a transient failure),
 *     with the expected and observed amount/currency and a machine-readable reason;
 *   • idempotent across deliveries (transaction): an existing record is only touched
 *     (deliveries +1, lastDeliveryAt) — its status, firstSeenAt and everything else are kept,
 *     so a redelivery can never reset or downgrade it;
 *   • flagged in suspiciousPayments ONCE, when the record is first created.
 *
 * Never throws; returns whether the record is durably present.
 */
export async function recordTopupPaymentMismatch(input: TopupPaymentMismatchInput): Promise<boolean> {
  const ref = adminDb.collection(COLLECTION).doc(`mismatch_${input.paymentId}`)
  const reason = topupMismatchReason(input)
  let created = false
  try {
    created = await adminDb.runTransaction(async tx => {
      const snap = await tx.get(ref)
      if (snap.exists) {
        tx.update(ref, { deliveries: FieldValue.increment(1), lastDeliveryAt: FieldValue.serverTimestamp() })
        return false
      }
      tx.create(ref, {
        orderId:             input.orderId,
        uid:                 input.uid,
        paymentId:           input.paymentId,
        amountPaise:         input.expectedAmountPaise,
        status:              'needs_review',
        reason,
        expectedAmountPaise: input.expectedAmountPaise,
        observedAmountPaise: input.observedAmountPaise,
        expectedCurrency:    input.expectedCurrency,
        observedCurrency:    input.observedCurrency,
        detectedBy:          input.source,
        lastError:           `captured payment does not match the top-up order (${reason}) — not credited`,
        deliveries:          1,
        firstSeenAt:         FieldValue.serverTimestamp(),
        lastDeliveryAt:      FieldValue.serverTimestamp(),
        reviewAt:            FieldValue.serverTimestamp(),
        updatedAt:           FieldValue.serverTimestamp(),
      })
      return true
    })
  } catch (e) {
    captureFinancialError(e, { scope: 'walletTopupReconciliation.mismatch_persist_failed', detail: 'CRITICAL: mismatched captured top-up payment not recorded', orderId: input.orderId, paymentId: input.paymentId })
    return false
  }
  if (created) {
    await flagSuspiciousPayment({
      source: 'wallet_topup', reason,
      paymentId: input.paymentId, orderId: input.orderId, entityId: input.uid,
      expectedAmountPaise: input.expectedAmountPaise, actualAmountPaise: input.observedAmountPaise ?? undefined,
      expectedCurrency: input.expectedCurrency, actualCurrency: input.observedCurrency ?? undefined,
    })
  }
  return true
}

export interface WalletRetryResult {
  scanned:          number
  resolved:         number
  stillPending:     number
  needsReview:      number
  duplicates:       number
  exhausted:        number
  legacyNormalized: number
}

interface RazorpayPaymentView { status?: string; amount?: number; currency?: string; order_id?: string }

/**
 * W2.a — bounded LEGACY pass: records written before W2.a have no `nextAttemptAt`, so the
 * ordered due-query cannot see them. Page through 'pending' records in document-id order from a
 * saved cursor and give each legacy record a schedule (due now, attempts kept). Bounded per run;
 * the cursor wraps to the start once the end is reached, so every legacy record is reached.
 */
async function normalizeLegacyRecords(limitN: number): Promise<number> {
  const after = await readCursor(LEGACY_CURSOR_KEY)
  let q = adminDb.collection(COLLECTION).where('status', '==', 'pending')
    .orderBy(FieldPath.documentId()).limit(limitN) as FirebaseFirestore.Query
  if (after) q = q.startAfter(after)
  const snap = await q.get()
  let normalized = 0
  for (const d of snap.docs) {
    const x = d.data() as { nextAttemptAt?: unknown; attempts?: unknown; firstSeenAt?: unknown; updatedAt?: unknown }
    if (x.nextAttemptAt) continue
    const done = await adminDb.runTransaction(async tx => {
      const fresh = await tx.get(d.ref)
      const f = fresh.data() as { status?: unknown; nextAttemptAt?: unknown; attempts?: unknown; firstSeenAt?: unknown; updatedAt?: unknown } | undefined
      if (!f || f.status !== 'pending' || f.nextAttemptAt) return false
      tx.update(d.ref, {
        nextAttemptAt: Timestamp.now(),                                           // due now
        attempts:      typeof f.attempts === 'number' && f.attempts > 0 ? f.attempts : 1,
        ...(f.firstSeenAt ? {} : { firstSeenAt: f.updatedAt ?? FieldValue.serverTimestamp() }),
      })
      return true
    }).catch(e => { captureFinancialError(e, { scope: 'walletTopupReconciliation.legacy_normalize_failed', recordId: d.id }); return false })
    if (done) normalized++
  }
  await writeCursor(LEGACY_CURSOR_KEY, snap.size < limitN ? null : snap.docs[snap.docs.length - 1].id)
  return normalized
}

/** Drains DUE pending records by replaying the idempotent credit. Safe to run repeatedly. */
export async function retryPendingWalletTopups(limitN = RETRY_BATCH_SIZE): Promise<WalletRetryResult> {
  const legacyNormalized = await normalizeLegacyRecords(LEGACY_BATCH_SIZE)

  // Deterministic, bounded: due records by nextAttemptAt, then document id.
  // Requires the composite index walletTopupReconciliation (status ASC, nextAttemptAt ASC).
  const snap = await adminDb.collection(COLLECTION)
    .where('status', '==', 'pending')
    .where('nextAttemptAt', '<=', Timestamp.now())
    .orderBy('nextAttemptAt', 'asc')
    .orderBy(FieldPath.documentId(), 'asc')
    .limit(limitN)
    .get()

  let resolved = 0, stillPending = 0, needsReview = 0, duplicates = 0, exhausted = 0

  /** Transient: one more failed attempt → reschedule with backoff, or 'exhausted' at the cap. */
  const reschedule = async (ref: FirebaseFirestore.DocumentReference, why: string) => {
    const outcome = await adminDb.runTransaction(async tx => {
      const fresh = await tx.get(ref)
      const f = fresh.data() as { status?: unknown; attempts?: unknown } | undefined
      if (!f || f.status !== 'pending') return 'moved' as const             // changed underneath — leave it
      const attempts = (typeof f.attempts === 'number' && f.attempts > 0 ? f.attempts : 1) + 1
      const common = {
        attempts,
        lastError:     why.slice(0, 500),
        lastAttemptAt: FieldValue.serverTimestamp(),
        updatedAt:     FieldValue.serverTimestamp(),
      }
      if (attempts >= RETRY_POLICY.maxAttempts) {
        tx.update(ref, { ...common, status: 'exhausted', exhaustedAt: FieldValue.serverTimestamp(), nextAttemptAt: FieldValue.delete() })
        return 'exhausted' as const
      }
      tx.update(ref, { ...common, nextAttemptAt: Timestamp.fromMillis(Date.now() + retryDelayMs(attempts)) })
      return 'rescheduled' as const
    }).catch(e => {
      captureFinancialError(e, { scope: 'walletTopupReconciliation.reschedule_failed', recordId: ref.id })
      return 'rescheduled' as const                                              // stays due; retried next run
    })
    if (outcome === 'exhausted') {
      exhausted++
      captureFinancialError('wallet_topup_reconciliation_exhausted', { scope: 'walletTopupReconciliation.exhausted', detail: 'retry limit reached — Super Admin review required', recordId: ref.id, lastError: why.slice(0, 200) })
    } else stillPending++
  }
  /** Permanent: held for review (only while still pending). */
  const holdForReview = async (ref: FirebaseFirestore.DocumentReference, why: string) => {
    await adminDb.runTransaction(async tx => {
      const fresh = await tx.get(ref)
      if ((fresh.data() as { status?: unknown } | undefined)?.status !== 'pending') return
      tx.update(ref, {
        status: 'needs_review', lastError: why.slice(0, 500), reviewAt: FieldValue.serverTimestamp(),
        lastAttemptAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(), nextAttemptAt: FieldValue.delete(),
      })
    }).catch(() => {})
    needsReview++
  }
  const finish = async (ref: FirebaseFirestore.DocumentReference, status: 'resolved' | 'duplicate_payment') => {
    await ref.update({
      status, lastAttemptAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(), nextAttemptAt: FieldValue.delete(),
      ...(status === 'resolved' ? { resolvedAt: FieldValue.serverTimestamp() } : {}),
    }).catch(() => {})
  }

  for (const doc of snap.docs) {
    const d = doc.data() as { orderId?: string; uid?: string; amountPaise?: number; paymentId?: string }
    if (!d.orderId || !d.uid || typeof d.amountPaise !== 'number' || !d.paymentId) {
      await doc.ref.update({ status: 'skipped', updatedAt: FieldValue.serverTimestamp(), nextAttemptAt: FieldValue.delete() }).catch(() => {})
      continue
    }

    // RD-WALLET-W1 · W1.1 — re-verify with the gateway: credit ONLY a captured payment for this
    // exact order, amount and currency.
    let payment: RazorpayPaymentView
    try {
      const { razorpay } = await import('@/lib/razorpay/client')
      payment = await razorpay.payments.fetch(d.paymentId) as RazorpayPaymentView
    } catch (e) {
      await reschedule(doc.ref, `gateway_fetch_failed: ${e instanceof Error ? e.message : 'unknown'}`)
      continue
    }
    if (payment.order_id !== d.orderId || payment.currency !== 'INR' || payment.amount !== d.amountPaise) {
      await flagSuspiciousPayment({
        source: 'wallet_topup', reason: 'reconciliation_mismatch',
        paymentId: d.paymentId, orderId: d.orderId, entityId: d.uid,
        expectedAmountPaise: d.amountPaise, actualAmountPaise: payment.amount,
        expectedCurrency: 'INR', actualCurrency: payment.currency,
        expectedOrderId: d.orderId, actualOrderId: payment.order_id,
      })
      await holdForReview(doc.ref, 'payment does not match the top-up order')
      continue
    }
    if (payment.status === 'authorized') {
      await reschedule(doc.ref, 'payment authorized but not captured yet')
      continue
    }
    if (payment.status !== 'captured') {
      await holdForReview(doc.ref, `payment status is '${payment.status ?? 'unknown'}', not captured`)
      continue
    }

    try {
      const topupRef = adminDb.collection('walletTopups').doc(d.orderId)
      const result = await atomicTopupCredit(d.uid, d.amountPaise, topupRef, d.paymentId)   // idempotent
      if (!result.credited && result.creditedPaymentId && result.creditedPaymentId !== d.paymentId) {
        await recordDuplicateTopupPayment({
          orderId: d.orderId, uid: d.uid, amountPaise: d.amountPaise, paymentId: d.paymentId,
          creditedPaymentId: result.creditedPaymentId, source: 'reconciliation', paymentStatus: payment.status,
        })
        await finish(doc.ref, 'duplicate_payment')
        duplicates++
        continue
      }
      await finish(doc.ref, 'resolved')
      resolved++
    } catch (e) {
      if (e instanceof TopupCreditError) {
        // A refusal a retry cannot fix (unknown order, wrong owner/amount, ledger conflict).
        captureFinancialError(e, { scope: 'walletTopupReconciliation.refused', orderId: d.orderId, code: e.code })
        await holdForReview(doc.ref, e.code)
        continue
      }
      await reschedule(doc.ref, e instanceof Error ? e.message : 'retry_failed')
    }
  }

  return { scanned: snap.size, resolved, stillPending, needsReview, duplicates, exhausted, legacyNormalized }
}

// ═══ RD-WALLET-W2.c — stale top-up sweep ═════════════════════════════════════════════════════════
//
// A captured top-up whose verify call AND payment.captured webhook both failed (or never ran) has
// no reconciliation record, so the retry above never sees it: the order just stays 'pending'. This
// sweep walks the PENDING orders themselves and asks Razorpay what happened to each stale one.
//
//   • Discovery — `walletTopups` where status == 'pending', ordered by DOCUMENT ID from a saved
//     cursor (the W2.a legacy-pass pattern: no composite index), one page of 200 per run, wrapping
//     to the start when the end is reached. Orders without a usable `createdAt` are included
//     (they may be old) but are never abandoned.
//   • Only one payment may be credited, only through atomicTopupCredit, and only when exactly ONE
//     captured payment matches the order's amount and INR — re-confirmed with a raw payment fetch,
//     because the adapter defaults a missing currency to INR and a missing amount to 0.
//   • Two or more matching captured payments (D1): NONE is credited. The order leaves 'pending'
//     (→ 'needs_review', so no later webhook / verify can credit one of them — atomicTopupCredit
//     refuses anything not pending) and every captured payment gets a durable per-payment review
//     record, in ONE transaction.
//   • Captured but mismatched → the W2.b mismatch record. Authorized → left alone.
//   • No money (no payment / created / failed / refunded): after 7 days, 'pending' → 'abandoned'
//     in a transaction that re-reads the order. atomicTopupCredit refuses 'abandoned', so a late
//     payment is held for review by the existing refusal paths (D3) — never credited.
//   • An unreachable gateway is UNCERTAIN, never "unpaid": nothing changes; three consecutive
//     lookup failures stop the run (circuit breaker).
//   • Mode (D5): WALLET_TOPUP_SWEEP_MODE = 'enforce' applies the above; anything else — missing,
//     empty, misspelled — is 'report': classify, count and log only. In report mode the sweep
//     writes NOTHING except its own cursor.

/** RD-WALLET-W2.c — the approved thresholds and budgets. */
export const STALE_SWEEP = {
  staleAfterMs:           30 * 60 * 1000,             // D2a — 30 minutes
  abandonAfterMs:         7 * 24 * 60 * 60 * 1000,    // D2b — 7 days
  pageSize:               200,
  maxGatewayCalls:        50,
  concurrency:            5,
  timeBudgetMs:           25_000,
  /** Never start new gateway work later than this into the cron request (maxDuration is 60 s). */
  routeCutoffMs:          35_000,
  gatewayCallTimeoutMs:   8_000,
  circuitBreakerFailures: 3,
} as const
const STALE_SWEEP_CURSOR_KEY = 'walletTopups.staleSweep'

export type WalletTopupSweepMode = 'report' | 'enforce'

/** D5 — only the exact value 'enforce' (case / whitespace-insensitive) enforces; everything else reports. */
export function resolveWalletTopupSweepMode(raw: string | undefined = process.env.WALLET_TOPUP_SWEEP_MODE): WalletTopupSweepMode {
  return (raw ?? '').trim().toLowerCase() === 'enforce' ? 'enforce' : 'report'
}

/** The adapter's normalized payment, as the sweep reads it (NormalizedPayment, minus provider/time). */
export interface SweepPaymentView {
  providerPaymentId: unknown
  providerOrderId:   unknown
  status:            unknown
  amountPaise:       unknown
  currency:          unknown
}

export interface StaleTopupClassification {
  verdict:            'malformed' | 'credit_one' | 'multiple_captured' | 'authorized' | 'mismatch_only' | 'unpaid'
  /** Captured payments that match the order's amount and INR. */
  matchingCaptured:   string[]
  /** Captured payments that do NOT match (amount / currency). */
  mismatchedCaptured: Array<{ paymentId: string; amountPaise: number; currency: string }>
  /** Why the gateway data could not be trusted (verdict 'malformed' only). */
  malformed?:         string
}

const KNOWN_PAYMENT_STATUSES = new Set(['created', 'authorized', 'captured', 'refunded', 'failed'])

/**
 * Pure. What Razorpay's payments say about ONE stale pending order. Conservative: any payment
 * whose identifiers, status, amount or currency are unusable makes the whole order 'malformed' —
 * nothing is credited, recorded or abandoned on data that cannot be trusted.
 */
export function classifyStaleTopupPayments(
  order: { orderId: string; amountPaise: number },
  payments: SweepPaymentView[],
): StaleTopupClassification {
  const out: StaleTopupClassification = { verdict: 'unpaid', matchingCaptured: [], mismatchedCaptured: [] }
  for (const p of payments) {
    if (typeof p.providerPaymentId !== 'string' || !p.providerPaymentId) return { ...out, verdict: 'malformed', malformed: 'payment_id_missing' }
    if (p.providerOrderId !== order.orderId)                               return { ...out, verdict: 'malformed', malformed: 'order_id_mismatch' }
    if (typeof p.status !== 'string' || !KNOWN_PAYMENT_STATUSES.has(p.status)) return { ...out, verdict: 'malformed', malformed: 'status_unknown' }
    if (typeof p.amountPaise !== 'number' || !Number.isInteger(p.amountPaise) || p.amountPaise <= 0) {
      return { ...out, verdict: 'malformed', malformed: 'amount_invalid' }
    }
    if (typeof p.currency !== 'string' || !p.currency)                     return { ...out, verdict: 'malformed', malformed: 'currency_missing' }
  }
  const valid = payments as Array<{ providerPaymentId: string; status: string; amountPaise: number; currency: string }>
  for (const p of valid) {
    if (p.status !== 'captured') continue
    if (p.amountPaise === order.amountPaise && p.currency === 'INR') out.matchingCaptured.push(p.providerPaymentId)
    else out.mismatchedCaptured.push({ paymentId: p.providerPaymentId, amountPaise: p.amountPaise, currency: p.currency })
  }
  out.matchingCaptured.sort()
  if (out.matchingCaptured.length >= 2)                 out.verdict = 'multiple_captured'
  else if (out.matchingCaptured.length === 1)           out.verdict = 'credit_one'
  else if (valid.some(p => p.status === 'authorized'))  out.verdict = 'authorized'
  else if (out.mismatchedCaptured.length > 0)           out.verdict = 'mismatch_only'
  return out
}

export interface StaleSweepResult {
  mode:                      WalletTopupSweepMode
  /** Pending orders read this run (one page). */
  scanned:                   number
  tooRecent:                 number
  skippedProvider:           number
  skippedOpenReconciliation: number
  /** Orders whose own record is unusable (uid / amount / currency) — reported only. */
  malformedOrders:           number
  /** Stale orders checked with the gateway this run. */
  checked:                   number
  // ── classification (same in both modes) ──
  singleMatch:               number
  multipleCaptured:          number
  mismatchedPayments:        number
  authorized:                number
  unpaidRecent:              number
  unpaidAbandonable:         number
  /** Old enough to abandon, but the RAW gateway view is not provably "no money" — left pending (also counted as uncertain). */
  abandonBlocked:            number
  /** One captured match, but the RAW payments could hide another one — not credited (also counted as uncertain). */
  creditBlocked:             number
  /** Includes lookups that failed and gateway data that could not be trusted. */
  uncertain:                 number
  // ── actions (enforce only) ──
  credited:                  number
  alreadyCredited:           number
  duplicatesRecorded:        number
  creditDeferred:            number
  creditRefused:             number
  mismatchesRecorded:        number
  /** Order-level review records written for a withheld credit (enforce). */
  reviewsRecorded:           number
  held:                      number
  abandoned:                 number
  /** The order changed underneath the sweep (credited / abandoned elsewhere) — left to that path. */
  raced:                     number
  /** A durable record could not be written — the order stays pending and is revisited. */
  recordFailed:              number
  // ── budget ──
  gatewayCalls:              number
  /** Stale orders on this page not checked this run (budget, time or circuit) — the cursor stops before them. */
  deferredForNextRun:        number
  circuitOpen:               boolean
  timeBudgetReached:         boolean
  /** The page reached the end of the pending set and the cursor wrapped to the start. */
  wrapped:                   boolean
  /** True only when every stale order on the page was handled (nothing deferred, no circuit / time stop). */
  complete:                  boolean
}

const tsMillis = (v: unknown): number | null => {
  if (v && typeof (v as { toMillis?: () => number }).toMillis === 'function') {
    const ms = (v as { toMillis: () => number }).toMillis()
    return Number.isFinite(ms) && ms > 0 ? ms : null
  }
  return null
}

const OPEN_ORDER_RECONCILIATION = new Set(['pending', 'needs_review', 'exhausted', 'duplicate_payment'])

/** Rejects after `ms`; the underlying call is not cancelled — the sweep just stops waiting for it. */
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    p,
    new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms) }),
  ]).finally(() => { if (timer) clearTimeout(timer) })
}

/**
 * One shared lazy import of the Razorpay client for the sweep and the watch, which look up several
 * orders concurrently. Lazy for the same reason as the adapter (the client demands its keys at
 * import); shared so concurrent callers use ONE import. A failed import is not cached.
 */
let razorpayClientPromise: Promise<typeof import('@/lib/razorpay/client')> | null = null
function razorpayClient(): Promise<typeof import('@/lib/razorpay/client')> {
  if (!razorpayClientPromise) {
    const p = import('@/lib/razorpay/client')
    razorpayClientPromise = p
    p.catch(() => { if (razorpayClientPromise === p) razorpayClientPromise = null })
  }
  return razorpayClientPromise
}

interface SweepOrder {
  id:          string
  ref:         FirebaseFirestore.DocumentReference
  uid:         string
  amountPaise: number
  createdAtMs: number | null
}

/**
 * RD-WALLET-W2.c · D1 — two or more captured payments match ONE pending order. Credit none; hold
 * the order and record every captured payment for Super Admin review, atomically:
 *   • the order moves 'pending' → 'needs_review' (so atomicTopupCredit — and therefore the
 *     webhook, verify and the retry — can no longer credit any of them);
 *   • each payment gets `dup_{paymentId}` with status 'needs_review' and the full list of
 *     captured payment ids. An existing record is never downgraded or reset (firstSeenAt kept).
 * Returns 'held', 'raced' (the order is no longer pending — nothing written) or throws.
 */
async function holdTopupForMultipleCaptures(
  order: SweepOrder, paymentIds: string[],
): Promise<{ outcome: 'held' | 'raced'; createdRecords: string[]; currentStatus?: string; creditedPaymentId?: string | null }> {
  const recordRefs = paymentIds.map(id => adminDb.collection(COLLECTION).doc(`dup_${id}`))
  return adminDb.runTransaction(async tx => {
    const [orderSnap, ...recordSnaps] = await Promise.all([tx.get(order.ref), ...recordRefs.map(r => tx.get(r))])
    const cur = orderSnap.data() as { status?: unknown; paymentId?: unknown } | undefined
    if (!cur || cur.status !== 'pending') {
      return {
        outcome: 'raced' as const, createdRecords: [],
        currentStatus: typeof cur?.status === 'string' ? cur.status : undefined,
        creditedPaymentId: typeof cur?.paymentId === 'string' ? cur.paymentId : null,
      }
    }
    tx.update(order.ref, {
      status:          'needs_review',
      holdReason:      'multiple_captured_payments',
      heldPaymentIds:  paymentIds,
      heldAt:          FieldValue.serverTimestamp(),
      updatedAt:       FieldValue.serverTimestamp(),
    })
    const created: string[] = []
    recordSnaps.forEach((snap, i) => {
      const common = {
        capturedPaymentIds: paymentIds,
        detectedBy:         FieldValue.arrayUnion('sweep'),
        updatedAt:          FieldValue.serverTimestamp(),
      }
      if (snap.exists) { tx.update(recordRefs[i], common); return }   // never downgraded / reset
      created.push(paymentIds[i])
      tx.create(recordRefs[i], {
        ...common,
        orderId:           order.id,
        uid:               order.uid,
        amountPaise:       order.amountPaise,
        paymentId:         paymentIds[i],
        creditedPaymentId: null,
        paymentStatus:     'captured',
        status:            'needs_review',
        reason:            'multiple_captured_payments',
        lastError:         `${paymentIds.length} captured payments match one pending top-up order — none credited automatically`,
        firstSeenAt:       FieldValue.serverTimestamp(),
        reviewAt:          FieldValue.serverTimestamp(),
      })
    })
    return { outcome: 'held' as const, createdRecords: created }
  })
}

/** D2b / D3 — 'pending' → 'abandoned', only if the order is STILL pending (re-read in the transaction). */
async function abandonStaleTopup(order: SweepOrder, paymentCount: number): Promise<'abandoned' | 'raced'> {
  return adminDb.runTransaction(async tx => {
    const snap = await tx.get(order.ref)
    if ((snap.data() as { status?: unknown } | undefined)?.status !== 'pending') return 'raced' as const
    tx.update(order.ref, {
      status:              'abandoned',
      abandonedAt:         FieldValue.serverTimestamp(),
      abandonReason:       'no_captured_or_authorized_payment_after_7_days',
      gatewayPaymentCount: paymentCount,
      updatedAt:           FieldValue.serverTimestamp(),
    })
    return 'abandoned' as const
  })
}

/**
 * RD-WALLET-W2.c — one bounded pass over stale pending top-up orders. Safe to run repeatedly and
 * concurrently with the webhook, verify, the retry and another sweep: every state change is a
 * transaction that re-reads the order, credit goes only through atomicTopupCredit (exactly-once),
 * and every record goes through a recorder that never resets or downgrades.
 */
export async function sweepStaleWalletTopups(opts: { mode?: WalletTopupSweepMode; deadlineAtMs?: number } = {}): Promise<StaleSweepResult> {
  const mode = opts.mode ?? resolveWalletTopupSweepMode()
  const startedAt = Date.now()
  const deadline = Math.min(opts.deadlineAtMs ?? Infinity, startedAt + STALE_SWEEP.timeBudgetMs)
  const r: StaleSweepResult = {
    mode, scanned: 0, tooRecent: 0, skippedProvider: 0, skippedOpenReconciliation: 0, malformedOrders: 0, checked: 0,
    singleMatch: 0, multipleCaptured: 0, mismatchedPayments: 0, authorized: 0, unpaidRecent: 0, unpaidAbandonable: 0, abandonBlocked: 0, creditBlocked: 0, uncertain: 0,
    credited: 0, alreadyCredited: 0, duplicatesRecorded: 0, creditDeferred: 0, creditRefused: 0, mismatchesRecorded: 0, reviewsRecorded: 0,
    held: 0, abandoned: 0, raced: 0, recordFailed: 0,
    gatewayCalls: 0, deferredForNextRun: 0, circuitOpen: false, timeBudgetReached: false, wrapped: false, complete: false,
  }
  const enforce = mode === 'enforce'
  const alerts: SweepAlert[] = []

  // ── 1 · one page of pending orders, by document id, from the saved cursor ──
  const after = await readCursor(STALE_SWEEP_CURSOR_KEY)
  let q = adminDb.collection('walletTopups').where('status', '==', 'pending')
    .orderBy(FieldPath.documentId()).limit(STALE_SWEEP.pageSize) as FirebaseFirestore.Query
  if (after) q = q.startAfter(after)
  const page = await q.get()
  r.scanned = page.size

  // ── 2 · decide per order, in document order, whether it needs the gateway ──
  type Item = { id: string; order?: SweepOrder }
  const items: Item[] = []
  const now = Date.now()
  for (const d of page.docs) {
    const x = d.data() as { uid?: unknown; amountPaise?: unknown; currency?: unknown; provider?: unknown; createdAt?: unknown }
    if (x.provider !== undefined && x.provider !== null && x.provider !== 'razorpay') { r.skippedProvider++; items.push({ id: d.id }); continue }
    const createdAtMs = tsMillis(x.createdAt)
    if (createdAtMs !== null && now - createdAtMs < STALE_SWEEP.staleAfterMs) { r.tooRecent++; items.push({ id: d.id }); continue }
    const currencyOk = x.currency === undefined || x.currency === null || x.currency === 'INR'
    if (typeof x.uid !== 'string' || !x.uid || typeof x.amountPaise !== 'number' || !Number.isInteger(x.amountPaise) || x.amountPaise <= 0 || !currencyOk) {
      r.malformedOrders++
      console.warn('[walletTopupSweep] malformed pending top-up — reported, never credited or abandoned:', { orderId: d.id })
      items.push({ id: d.id })
      continue
    }
    items.push({ id: d.id, order: { id: d.id, ref: d.ref, uid: x.uid, amountPaise: x.amountPaise, createdAtMs } })
  }

  // Orders already owned by an open order-level reconciliation record are the retry's (W2.a).
  const candidates = items.filter(i => i.order)
  if (candidates.length > 0) {
    const recs = await adminDb.getAll(...candidates.map(i => adminDb.collection(COLLECTION).doc(i.id)))
    recs.forEach((s, k) => {
      const st = s.exists ? (s.data() as { status?: unknown }).status : undefined
      if (typeof st === 'string' && OPEN_ORDER_RECONCILIATION.has(st)) { r.skippedOpenReconciliation++; candidates[k].order = undefined }
    })
  }

  // ── 3 · the gateway work: bounded calls, bounded concurrency, time budget, circuit breaker ──
  const gateway = (await import('@/lib/payments/providers')).resolvePaymentProvider('razorpay')
  const call = async <T>(fn: () => Promise<T>, what: string): Promise<T> => {
    r.gatewayCalls++
    return withTimeout(fn(), STALE_SWEEP.gatewayCallTimeoutMs, what)
  }

  /** Process one stale order. Returns whether its gateway LOOKUP failed (for the circuit breaker). */
  const processOrder = async (o: SweepOrder): Promise<boolean> => {
    let payments: SweepPaymentView[]
    try {
      payments = await call(() => gateway.fetchOrderPayments(o.id), 'fetchOrderPayments')
    } catch (e) {
      r.uncertain++
      captureFinancialError(e, { scope: 'walletTopupSweep.lookup_failed', detail: 'left pending — never treated as unpaid', orderId: o.id })
      return true
    }
    r.checked++
    const c = classifyStaleTopupPayments({ orderId: o.id, amountPaise: o.amountPaise }, payments)
    if (c.verdict === 'malformed') {
      r.uncertain++
      console.warn('[walletTopupSweep] gateway data unusable — no action:', { orderId: o.id, why: c.malformed })
      return false
    }

    // Captured but mismatched payments → the W2.b record (never credited).
    r.mismatchedPayments += c.mismatchedCaptured.length
    for (const m of c.mismatchedCaptured) {
      alerts.push({
        key: `mismatch:${m.paymentId}`, fingerprint: `${m.amountPaise}|${m.currency}`,
        fire: () => captureFinancialError('wallet_topup_sweep_mismatch', { scope: 'walletTopupSweep.mismatch', orderId: o.id, paymentId: m.paymentId, mode }),
      })
      if (!enforce) continue
      const ok = await recordTopupPaymentMismatch({
        orderId: o.id, uid: o.uid, paymentId: m.paymentId,
        expectedAmountPaise: o.amountPaise, observedAmountPaise: m.amountPaise,
        expectedCurrency: 'INR', observedCurrency: m.currency, source: 'sweep',
      })
      if (ok) r.mismatchesRecorded++; else r.recordFailed++
    }

    const age = o.createdAtMs === null ? null : Date.now() - o.createdAtMs
    switch (c.verdict) {
      case 'authorized':    r.authorized++; return false
      case 'mismatch_only': return false
      case 'unpaid': {
        if (age === null || age < STALE_SWEEP.abandonAfterMs) { r.unpaidRecent++; return false }
        // Fix 1 — the adapter reads an unknown or MISSING raw status as 'failed'. Before anything
        // is abandoned (or reported as abandonable), the RAW payments must prove "no money": every
        // raw status exactly created / failed / refunded, every field valid, same payments as the
        // adapter reported. Anything else is uncertain — left pending, never abandoned.
        let rawPayments: unknown
        try {
          const { razorpay } = await razorpayClient()
          rawPayments = await call(() => razorpay.orders.fetchPayments(o.id) as Promise<unknown>, 'orders.fetchPayments')
        } catch (e) {
          r.uncertain++; r.abandonBlocked++
          captureFinancialError(e, { scope: 'walletTopupSweep.raw_lookup_failed', detail: 'left pending — never abandoned on a failed lookup', orderId: o.id })
          return true
        }
        const proof = assessRawPaymentsForAbandon(o.id, rawPayments, payments.map(p => String(p.providerPaymentId)))
        if (!proof.ok) {
          r.uncertain++; r.abandonBlocked++
          alerts.push({
            key: `abandon_blocked:${o.id}`, fingerprint: proof.reason,
            fire: () => captureFinancialError('wallet_topup_sweep_abandon_blocked', { scope: 'walletTopupSweep.abandon_blocked', detail: 'raw gateway data is not provably unpaid — left pending', orderId: o.id, reason: proof.reason, mode }),
          })
          return false
        }
        r.unpaidAbandonable++
        if (!enforce) return false
        try {
          if ((await abandonStaleTopup(o, payments.length)) === 'abandoned') r.abandoned++; else r.raced++
        } catch (e) {
          captureFinancialError(e, { scope: 'walletTopupSweep.abandon_failed', orderId: o.id })
        }
        return false
      }
      case 'multiple_captured': {
        r.multipleCaptured++
        alerts.push({
          key: `multi:${o.id}`, fingerprint: c.matchingCaptured.join(','),
          fire: () => captureFinancialError('wallet_topup_multiple_captured', { scope: 'walletTopupSweep.multiple_captured', detail: 'none credited — held for Super Admin review', orderId: o.id, payments: c.matchingCaptured.length, mode }),
        })
        if (!enforce) return false
        try {
          const held = await holdTopupForMultipleCaptures(o, c.matchingCaptured)
          if (held.outcome === 'held') {
            r.held++
            for (const pid of held.createdRecords) {
              await flagSuspiciousPayment({
                source: 'wallet_topup', reason: 'multiple_captured_payments',
                paymentId: pid, orderId: o.id, entityId: o.uid,
                expectedAmountPaise: o.amountPaise, actualAmountPaise: o.amountPaise,
                expectedCurrency: 'INR', actualCurrency: 'INR',
              })
            }
          } else {
            // Credited (or otherwise moved) between the lookup and the hold: the other captured
            // payments are then duplicates of a CREDITED order — recorded as such, never credited.
            r.raced++
            if (held.currentStatus === 'credited') {
              for (const pid of c.matchingCaptured.filter(p => p !== held.creditedPaymentId)) {
                const ok = await recordDuplicateTopupPayment({
                  orderId: o.id, uid: o.uid, amountPaise: o.amountPaise, paymentId: pid,
                  creditedPaymentId: held.creditedPaymentId ?? null, source: 'sweep', paymentStatus: 'captured',
                })
                if (ok) r.duplicatesRecorded++; else r.recordFailed++
              }
            }
          }
        } catch (e) {
          r.recordFailed++
          captureFinancialError(e, { scope: 'walletTopupSweep.hold_failed', detail: 'CRITICAL: multiple captures not held — order left pending, revisited next pass', orderId: o.id })
        }
        return false
      }
      case 'credit_one': {
        r.singleMatch++
        const paymentId = c.matchingCaptured[0]
        // Raw-status fix — "exactly one captured payment" was decided on the ADAPTER's view, which
        // reads an unknown or missing raw status as 'failed' (and a missing currency as INR). Before
        // any credit, the order's RAW payments are re-read (the same call the abandonment proof
        // uses; it replaces the single-payment re-fetch, so the 2-calls-per-order budget holds) and
        // must show: every payment well-formed with a KNOWN status, the same payments the adapter
        // reported, this payment captured for the order's amount in INR, and NO other matching
        // capture. Done in report mode too (read-only), so report runs show withheld credits.
        let rawPayments: unknown
        try {
          const { razorpay } = await razorpayClient()
          rawPayments = await call(() => razorpay.orders.fetchPayments(o.id) as Promise<unknown>, 'orders.fetchPayments')
        } catch (e) {
          r.uncertain++
          captureFinancialError(e, { scope: 'walletTopupSweep.confirm_failed', detail: 'left pending — not credited on a failed lookup', orderId: o.id, paymentId })
          return true
        }
        const check = assessRawPaymentsForCredit(
          { orderId: o.id, amountPaise: o.amountPaise }, rawPayments, paymentId, payments.map(p => String(p.providerPaymentId)),
        )
        if (!check.ok && check.action === 'review') {
          // Could hide another payment (or cannot be trusted): NOT credited, NOT abandoned. Held
          // for review on the order's own record with every payment id seen; the order then
          // belongs to that record (the sweep skips it, the guard blocks new top-ups).
          r.uncertain++; r.creditBlocked++
          alerts.push({
            key: `credit_blocked:${o.id}`, fingerprint: `${check.reason}|${check.paymentIds.join(',')}`,
            fire: () => captureFinancialError('wallet_topup_sweep_credit_blocked', { scope: 'walletTopupSweep.credit_blocked', detail: 'raw payments could hide another payment — credit withheld for review', orderId: o.id, reason: check.reason, payments: check.paymentIds.length, mode }),
          })
          if (!enforce) return false
          const ok = await recordWalletTopupReconciliation({
            orderId: o.id, uid: o.uid, amountPaise: o.amountPaise, paymentId,
            error: `stale sweep withheld the credit (${check.reason}) — raw payments on the order: ${check.paymentIds.join(', ')}`,
            status: 'needs_review', relatedPaymentIds: check.paymentIds,
          })
          if (ok) r.reviewsRecorded++; else r.recordFailed++
          return false
        }
        if (!check.ok) {
          // This payment's own raw amount / currency does not match (e.g. currency missing): W2.b record.
          r.mismatchedPayments++
          if (!enforce) return false
          const ok = await recordTopupPaymentMismatch({
            orderId: o.id, uid: o.uid, paymentId,
            expectedAmountPaise: o.amountPaise, observedAmountPaise: check.observedAmountPaise,
            expectedCurrency: 'INR', observedCurrency: check.observedCurrency, source: 'sweep',
          })
          if (ok) r.mismatchesRecorded++; else r.recordFailed++
          return false
        }
        if (!enforce) return false
        try {
          const result = await atomicTopupCredit(o.uid, o.amountPaise, o.ref, paymentId)   // exactly-once
          if (result.credited) {
            r.credited++
            // Every sweep credit means verify AND the webhook both missed a captured payment.
            captureFinancialError('wallet_topup_sweep_credited', { scope: 'walletTopupSweep.credited', detail: 'captured top-up credited by the stale sweep', orderId: o.id, paymentId })
          } else if (result.creditedPaymentId && result.creditedPaymentId !== paymentId) {
            const ok = await recordDuplicateTopupPayment({
              orderId: o.id, uid: o.uid, amountPaise: o.amountPaise, paymentId,
              creditedPaymentId: result.creditedPaymentId, source: 'sweep', paymentStatus: 'captured',
            })
            if (ok) r.duplicatesRecorded++; else r.recordFailed++
          } else {
            r.alreadyCredited++
          }
        } catch (e) {
          const refused = e instanceof TopupCreditError
          if (refused) {
            captureFinancialError(e, { scope: 'walletTopupSweep.credit_refused', orderId: o.id, code: e.code })
            await flagSuspiciousPayment({
              source: 'wallet_topup', reason: `credit_refused:${e.code}`,
              paymentId, orderId: o.id, entityId: o.uid,
              expectedAmountPaise: o.amountPaise, actualAmountPaise: o.amountPaise,
              expectedCurrency: 'INR', actualCurrency: 'INR',
            })
          }
          // Transient → the W2.a schedule owns it from here; a refusal is held for review.
          const ok = await recordWalletTopupReconciliation({
            orderId: o.id, uid: o.uid, amountPaise: o.amountPaise, paymentId,
            error: e instanceof Error ? e.message : 'credit_failed',
            status: refused ? 'needs_review' : 'pending',
          })
          if (!ok) r.recordFailed++
          else if (refused) r.creditRefused++
          else r.creditDeferred++
        }
        return false
      }
    }
  }

  // Walk the page in order. `settledIdx` = the last index such that it and everything before it
  // was fully handled this run; the cursor never moves past an order that was not handled.
  let settledIdx = -1
  let failStreak = 0
  let streakStartIdx = -1
  let stopped = false
  let i = 0
  while (i < items.length) {
    if (!items[i].order) { settledIdx = i; i++; continue }
    if (Date.now() >= deadline) { r.timeBudgetReached = true; stopped = true; break }
    // Reserve 2 calls per order (lookup + raw confirm) so the cap of 50 can never be exceeded.
    const slots = Math.min(STALE_SWEEP.concurrency, Math.floor((STALE_SWEEP.maxGatewayCalls - r.gatewayCalls) / 2))
    if (slots <= 0) { stopped = true; break }
    const chunk: number[] = []
    let j = i
    while (j < items.length && chunk.length < slots) { if (items[j].order) chunk.push(j); j++ }
    const failed = await Promise.all(chunk.map(k => processOrder(items[k].order!)))
    let circuit = false
    for (let c = 0; c < chunk.length; c++) {
      if (failed[c]) {
        if (failStreak === 0) streakStartIdx = chunk[c]
        failStreak++
        if (failStreak >= STALE_SWEEP.circuitBreakerFailures) { circuit = true; break }
      } else failStreak = 0
    }
    if (circuit) {
      r.circuitOpen = true
      settledIdx = streakStartIdx - 1                         // look at the failing orders again next run
      stopped = true
      captureFinancialError('wallet_topup_sweep_circuit_open', { scope: 'walletTopupSweep.circuit_open', detail: `${STALE_SWEEP.circuitBreakerFailures} consecutive gateway lookup failures — sweep stopped`, gatewayCalls: r.gatewayCalls })
      break
    }
    settledIdx = j - 1
    i = j
  }

  // Everything after the settled point that is still a stale candidate is deferred, not lost.
  r.deferredForNextRun = items.slice(settledIdx + 1).filter(x => x.order).length
  const pageDone = !stopped || settledIdx >= items.length - 1
  if (pageDone && page.size < STALE_SWEEP.pageSize) {
    r.wrapped = true
    await writeCursor(STALE_SWEEP_CURSOR_KEY, null)
  } else if (settledIdx >= 0) {
    await writeCursor(STALE_SWEEP_CURSOR_KEY, items[settledIdx].id)
  }
  r.complete = !r.circuitOpen && !r.timeBudgetReached && r.deferredForNextRun === 0 && r.recordFailed === 0
  await emitDedupedAlerts(alerts)

  if (!r.complete || r.credited > 0 || r.multipleCaptured > 0) {
    console.warn('[walletTopupSweep] run summary:', r)
  }
  return r
}

// ═══ RD-WALLET-W2.c safety fixes ══════════════════════════════════════════════════════════════════

// ── Fix 3 · alert de-duplication ───────────────────────────────────────────────────────────────
// The durable reconciliation records are the source of truth; alerts are only the pager. A
// mismatch or a multiple capture on a still-pending order is seen again on every pass, so without
// this each one paged every ~10 minutes. Each alert carries a KEY (what it is about) and a
// FINGERPRINT (what was observed). It fires when the key is new or its fingerprint changed (a new
// payment id, a new amount, a new reason) — never merely because it was seen again. The last
// fingerprints live in ONE operational doc beside the sweep cursors
// (reconciliationCursors/walletTopups.sweepAlerts) — not a reconciliation record, not financial
// state — so report mode may keep it too. Entries not seen for 30 days are pruned; a read failure
// fails OPEN (the alerts fire).

interface SweepAlert { key: string; fingerprint: string; fire: () => void }
type AlertSeen = Record<string, { fp: string; at: number }>

export const ALERT_DEDUPE = {
  retentionMs: 30 * 24 * 60 * 60 * 1000,
  refreshMs:   24 * 60 * 60 * 1000,
  maxEntries:  2000,
} as const
const ALERT_STATE_KEY = 'walletTopups.sweepAlerts'

/** Pure. Which alert keys fire now, and the next stored state. */
export function planSweepAlerts(
  prev: unknown, observed: Array<{ key: string; fingerprint: string }>, now: number,
): { emitKeys: Set<string>; next: AlertSeen; changed: boolean } {
  const next: AlertSeen = {}
  let changed = false
  if (prev && typeof prev === 'object') {
    for (const [k, v] of Object.entries(prev as Record<string, unknown>)) {
      const e = v as { fp?: unknown; at?: unknown } | null
      if (e && typeof e.fp === 'string' && typeof e.at === 'number' && now - e.at <= ALERT_DEDUPE.retentionMs) next[k] = { fp: e.fp, at: e.at }
      else changed = true
    }
  }
  const emitKeys = new Set<string>()
  const seenThisRun = new Set<string>()
  for (const o of observed) {
    if (seenThisRun.has(o.key)) continue
    seenThisRun.add(o.key)
    const cur = next[o.key]
    if (!cur || cur.fp !== o.fingerprint) {
      emitKeys.add(o.key); next[o.key] = { fp: o.fingerprint, at: now }; changed = true
    } else if (now - cur.at > ALERT_DEDUPE.refreshMs) {
      next[o.key] = { fp: cur.fp, at: now }; changed = true                    // still present: keep it alive
    }
  }
  const keys = Object.keys(next)
  if (keys.length > ALERT_DEDUPE.maxEntries) {
    keys.sort((a, b) => next[a].at - next[b].at)
    for (const k of keys.slice(0, keys.length - ALERT_DEDUPE.maxEntries)) delete next[k]
    changed = true
  }
  return { emitKeys, next, changed }
}

async function emitDedupedAlerts(alerts: SweepAlert[]): Promise<void> {
  if (alerts.length === 0) return
  const ref = adminDb.collection('reconciliationCursors').doc(ALERT_STATE_KEY)
  let prev: unknown = {}
  try {
    const snap = await ref.get()
    prev = snap.exists ? (snap.data() as { seen?: unknown }).seen : {}
  } catch {
    for (const a of alerts) a.fire()                                           // fail open
    return
  }
  const plan = planSweepAlerts(prev, alerts, Date.now())
  for (const a of alerts) {
    if (!plan.emitKeys.has(a.key)) continue
    plan.emitKeys.delete(a.key)                                                // once per key per run
    a.fire()
  }
  if (plan.changed) {
    await ref.set({ seen: plan.next, updatedAt: FieldValue.serverTimestamp() })
      .catch(e => console.warn('[walletTopupSweep] alert state not saved (alerts may repeat next run):', e instanceof Error ? e.message : e))
  }
}

// ── Fix 1 · abandonment needs RAW proof of "no money" ───────────────────────────────────────────

const ABANDONABLE_RAW_STATUSES = new Set(['created', 'failed', 'refunded'])

interface RawPaymentLike { id?: unknown; order_id?: unknown; status?: unknown; amount?: unknown; currency?: unknown }

/**
 * Pure. Razorpay's RAW `orders.fetchPayments` response for one order — may it be abandoned? Only
 * when EVERY payment is well-formed, belongs to this order, has a raw status that is exactly
 * created / failed / refunded, and the raw payments are the same set the adapter reported.
 * Missing, unknown, `authorized`, `captured` or malformed ⇒ not provable ⇒ never abandoned.
 */
export function assessRawPaymentsForAbandon(
  orderId: string, raw: unknown, adapterPaymentIds: string[],
): { ok: true } | { ok: false; reason: string } {
  const items = (raw as { items?: unknown } | null | undefined)?.items
  if (!Array.isArray(items)) return { ok: false, reason: 'raw_response_malformed' }
  const ids: string[] = []
  for (const it of items) {
    if (!it || typeof it !== 'object') return { ok: false, reason: 'raw_payment_malformed' }
    const p = it as RawPaymentLike
    if (typeof p.id !== 'string' || !p.id)                        return { ok: false, reason: 'raw_payment_id_missing' }
    if (p.order_id !== orderId)                                   return { ok: false, reason: 'raw_order_id_mismatch' }
    if (typeof p.status !== 'string' || !p.status)                return { ok: false, reason: 'raw_status_missing' }
    if (!ABANDONABLE_RAW_STATUSES.has(p.status)) {
      return { ok: false, reason: p.status === 'authorized' || p.status === 'captured' ? `raw_status_${p.status}` : 'raw_status_unknown' }
    }
    if (typeof p.amount !== 'number' || !Number.isInteger(p.amount) || p.amount <= 0) return { ok: false, reason: 'raw_amount_invalid' }
    if (typeof p.currency !== 'string' || !p.currency)            return { ok: false, reason: 'raw_currency_missing' }
    ids.push(p.id)
  }
  const a = [...ids].sort(), b = [...adapterPaymentIds].sort()
  if (a.length !== b.length || a.some((id, i) => id !== b[i]))     return { ok: false, reason: 'raw_adapter_disagree' }
  return { ok: true }
}

const RAW_KNOWN_STATUSES = new Set(['created', 'authorized', 'captured', 'refunded', 'failed'])

export type RawCreditAssessment =
  | { ok: true }
  | { ok: false; action: 'mismatch'; observedAmountPaise: number | null; observedCurrency: string | null }
  | { ok: false; action: 'review'; reason: string; paymentIds: string[] }

/**
 * Pure. May the sweep credit `paymentId` on this order, given Razorpay's RAW
 * `orders.fetchPayments` response? Only when nothing in it could hide another payment:
 *   • every payment is an object with an id and THIS order id, and a KNOWN raw status
 *     (a missing or unknown status might be money — the adapter would have read it as 'failed');
 *   • the raw payments are exactly the set the adapter reported (nothing missing or extra);
 *   • this payment is raw 'captured' and no OTHER payment is a matching capture.
 * Other payments may be created / failed / refunded / authorized (an authorised one captured
 * later is a duplicate of a credited order — the existing W1.4 path) or a captured MISMATCH
 * (recorded by the sweep as such). If this payment's own amount / currency does not match →
 * 'mismatch' (the W2.b record). Everything else → 'review', with every payment id seen.
 */
export function assessRawPaymentsForCredit(
  order: { orderId: string; amountPaise: number }, raw: unknown, paymentId: string, adapterPaymentIds: string[],
): RawCreditAssessment {
  const items = (raw as { items?: unknown } | null | undefined)?.items
  const review = (reason: string, ids: string[] = []): RawCreditAssessment =>
    ({ ok: false, action: 'review', reason, paymentIds: [...new Set([paymentId, ...adapterPaymentIds, ...ids])].filter(Boolean).sort() })
  if (!Array.isArray(items)) return review('raw_response_malformed')
  const ids = items
    .map(it => (it && typeof it === 'object' && typeof (it as RawPaymentLike).id === 'string') ? (it as { id: string }).id : '')
    .filter(Boolean)
  for (const it of items) {
    if (!it || typeof it !== 'object')             return review('raw_payment_malformed', ids)
    const p = it as RawPaymentLike
    if (typeof p.id !== 'string' || !p.id)         return review('raw_payment_id_missing', ids)
    if (p.order_id !== order.orderId)              return review('raw_order_id_mismatch', ids)
    if (typeof p.status !== 'string' || !p.status) return review('raw_status_missing', ids)
    if (!RAW_KNOWN_STATUSES.has(p.status))         return review('raw_status_unknown', ids)
  }
  const a = [...ids].sort(), b = [...adapterPaymentIds].sort()
  if (a.length !== b.length || a.some((id, i) => id !== b[i])) return review('raw_adapter_disagree', ids)
  const list = items as RawPaymentLike[]
  const target = list.find(p => p.id === paymentId)
  if (!target || target.status !== 'captured')   return review('raw_target_not_captured', ids)
  if (list.some(p => p.id !== paymentId && p.status === 'captured' && p.amount === order.amountPaise && p.currency === 'INR')) {
    return review('raw_multiple_captured', ids)
  }
  if (target.currency !== 'INR' || target.amount !== order.amountPaise) {
    return {
      ok: false, action: 'mismatch',
      observedAmountPaise: typeof target.amount === 'number' ? target.amount : null,
      observedCurrency:    typeof target.currency === 'string' && target.currency ? target.currency : null,
    }
  }
  return { ok: true }
}

// ── Fix 2 · bounded late-payment watch over ABANDONED orders ────────────────────────────────────
//
// An abandoned order is refused by atomicTopupCredit, so a late payment on it is held for review by
// the webhook / verify refusal path — IF one of them runs. Nothing else looked again. This watch
// re-asks Razorpay (RAW payments — so unknown statuses stay visible) about orders abandoned in the
// last 30 days, and records anything that may be money for Super Admin review. It NEVER credits
// and never changes the order: the order stays 'abandoned' (not creditable).
//
//   • Own cursor (walletTopups.abandonedWatch), `status == 'abandoned'` by DOCUMENT ID, one page of
//     200 per run, wrapping — no index. Orders abandoned more than 30 days ago (or with no usable
//     `abandonedAt`) are read in the page but skipped: no gateway call, no write, no status change.
//     The per-run read cost is one bounded page whatever the size of the abandoned set; the cycle
//     length grows with it (an index on status + abandonedAt would remove that — not added).
//   • Own budget: ≤ 10 gateway calls per run (one per order), run by the cron AFTER the pending
//     sweep, with its own time budget and never after the route cutoff. It is skipped entirely
//     when the sweep's gateway circuit opened. It cannot take anything from the sweep's budget.
//   • captured (matching) / authorized / unknown or missing status → the ORDER-level record via
//     recordWalletTopupReconciliation('needs_review') — transactional, keeps every payment id,
//     never downgrades. A payment id already on that record is not written again (so a resolved
//     review is not re-opened by the same payment). captured with another amount / currency →
//     the W2.b mismatch record. created / failed / refunded → nothing.
//   • report mode: classify, count, log, cursor (and alert state) only.

export const ABANDONED_WATCH = {
  windowMs:               30 * 24 * 60 * 60 * 1000,   // 30 days after abandonedAt
  pageSize:               200,
  maxGatewayCalls:        10,
  timeBudgetMs:           10_000,
  circuitBreakerFailures: 3,
} as const
const ABANDONED_WATCH_CURSOR_KEY = 'walletTopups.abandonedWatch'

export interface LatePaymentFinding {
  paymentId:   string
  kind:        'captured' | 'authorized' | 'unknown_status' | 'mismatch'
  status:      string | null
  amountPaise: number | null
  currency:    string | null
}

/** Pure. What the RAW payments on an abandoned order say. Unusable data ⇒ { ok: false } (uncertain). */
export function classifyLatePayments(
  order: { orderId: string; amountPaise: number }, raw: unknown,
): { ok: true; findings: LatePaymentFinding[] } | { ok: false; reason: string } {
  const items = (raw as { items?: unknown } | null | undefined)?.items
  if (!Array.isArray(items)) return { ok: false, reason: 'raw_response_malformed' }
  const findings: LatePaymentFinding[] = []
  for (const it of items) {
    if (!it || typeof it !== 'object') return { ok: false, reason: 'raw_payment_malformed' }
    const p = it as RawPaymentLike
    if (typeof p.id !== 'string' || !p.id) return { ok: false, reason: 'raw_payment_id_missing' }
    if (p.order_id !== order.orderId)      return { ok: false, reason: 'raw_order_id_mismatch' }
    const status = typeof p.status === 'string' && p.status ? p.status : null
    const amountPaise = typeof p.amount === 'number' && Number.isInteger(p.amount) ? p.amount : null
    const currency = typeof p.currency === 'string' && p.currency ? p.currency : null
    if (status !== null && ABANDONABLE_RAW_STATUSES.has(status)) continue
    const base = { paymentId: p.id, status, amountPaise, currency }
    if (status === 'captured') {
      findings.push({ ...base, kind: amountPaise === order.amountPaise && currency === 'INR' ? 'captured' : 'mismatch' })
    } else if (status === 'authorized') {
      findings.push({ ...base, kind: 'authorized' })
    } else {
      findings.push({ ...base, kind: 'unknown_status' })
    }
  }
  return { ok: true, findings }
}

export interface AbandonedWatchResult {
  mode:               WalletTopupSweepMode
  /** Set when the watch did not run (e.g. the sweep's gateway circuit opened). */
  skipped:            string | null
  scanned:            number
  outsideWindow:      number
  missingAbandonedAt: number
  malformedOrders:    number
  checked:            number
  // ── classification (same in both modes) ──
  lateCaptured:       number
  lateAuthorized:     number
  unknownStatus:      number
  mismatched:         number
  /** Findings whose payment id is already recorded — nothing new. */
  alreadyRecorded:    number
  uncertain:          number
  // ── actions (enforce only) ──
  reviewsRecorded:    number
  mismatchesRecorded: number
  recordFailed:       number
  // ── budget ──
  gatewayCalls:       number
  deferredForNextRun: number
  circuitOpen:        boolean
  timeBudgetReached:  boolean
  wrapped:            boolean
  complete:           boolean
}

export async function watchAbandonedWalletTopups(
  opts: { mode?: WalletTopupSweepMode; deadlineAtMs?: number; skip?: string } = {},
): Promise<AbandonedWatchResult> {
  const mode = opts.mode ?? resolveWalletTopupSweepMode()
  const r: AbandonedWatchResult = {
    mode, skipped: opts.skip ?? null, scanned: 0, outsideWindow: 0, missingAbandonedAt: 0, malformedOrders: 0, checked: 0,
    lateCaptured: 0, lateAuthorized: 0, unknownStatus: 0, mismatched: 0, alreadyRecorded: 0, uncertain: 0,
    reviewsRecorded: 0, mismatchesRecorded: 0, recordFailed: 0,
    gatewayCalls: 0, deferredForNextRun: 0, circuitOpen: false, timeBudgetReached: false, wrapped: false, complete: false,
  }
  if (opts.skip) return r
  const enforce = mode === 'enforce'
  const deadline = Math.min(opts.deadlineAtMs ?? Infinity, Date.now() + ABANDONED_WATCH.timeBudgetMs)
  const alerts: SweepAlert[] = []

  const after = await readCursor(ABANDONED_WATCH_CURSOR_KEY)
  let q = adminDb.collection('walletTopups').where('status', '==', 'abandoned')
    .orderBy(FieldPath.documentId()).limit(ABANDONED_WATCH.pageSize) as FirebaseFirestore.Query
  if (after) q = q.startAfter(after)
  const page = await q.get()
  r.scanned = page.size

  type Item = { id: string; order?: { id: string; uid: string; amountPaise: number } }
  const items: Item[] = []
  const now = Date.now()
  for (const d of page.docs) {
    const x = d.data() as { uid?: unknown; amountPaise?: unknown; abandonedAt?: unknown }
    const abandonedAtMs = tsMillis(x.abandonedAt)
    if (abandonedAtMs === null) { r.missingAbandonedAt++; items.push({ id: d.id }); continue }
    if (now - abandonedAtMs > ABANDONED_WATCH.windowMs) { r.outsideWindow++; items.push({ id: d.id }); continue }
    if (typeof x.uid !== 'string' || !x.uid || typeof x.amountPaise !== 'number' || !Number.isInteger(x.amountPaise) || x.amountPaise <= 0) {
      r.malformedOrders++; items.push({ id: d.id }); continue
    }
    items.push({ id: d.id, order: { id: d.id, uid: x.uid, amountPaise: x.amountPaise } })
  }

  /** Returns whether the LOOKUP failed (circuit breaker). */
  const processOrder = async (o: { id: string; uid: string; amountPaise: number }): Promise<boolean> => {
    let raw: unknown
    try {
      r.gatewayCalls++
      const { razorpay } = await razorpayClient()
      raw = await withTimeout(razorpay.orders.fetchPayments(o.id) as Promise<unknown>, STALE_SWEEP.gatewayCallTimeoutMs, 'orders.fetchPayments')
    } catch (e) {
      r.uncertain++
      captureFinancialError(e, { scope: 'walletTopupWatch.lookup_failed', detail: 'abandoned order left as is — looked at again later', orderId: o.id })
      return true
    }
    r.checked++
    const c = classifyLatePayments({ orderId: o.id, amountPaise: o.amountPaise }, raw)
    if (!c.ok) {
      r.uncertain++
      alerts.push({
        key: `late_uncertain:${o.id}`, fingerprint: c.reason,
        fire: () => captureFinancialError('wallet_topup_late_payment_uncertain', { scope: 'walletTopupWatch.uncertain', detail: 'abandoned order: gateway data unusable — no action', orderId: o.id, reason: c.reason, mode }),
      })
      return false
    }
    if (c.findings.length === 0) return false

    // Payment ids already on the order's record (or already a mismatch record) are not new.
    const orderRec = await adminDb.collection(COLLECTION).doc(o.id).get()
    const od = orderRec.exists ? orderRec.data() as { paymentId?: unknown; paymentIds?: unknown } : {}
    const known = new Set<string>([
      ...(Array.isArray(od.paymentIds) ? od.paymentIds.filter((v): v is string => typeof v === 'string') : []),
      ...(typeof od.paymentId === 'string' ? [od.paymentId] : []),
    ])
    for (const f of c.findings) {
      if (f.kind === 'captured') r.lateCaptured++
      else if (f.kind === 'authorized') r.lateAuthorized++
      else if (f.kind === 'unknown_status') r.unknownStatus++
      else r.mismatched++
      const isKnown = f.kind === 'mismatch'
        ? (await adminDb.collection(COLLECTION).doc(`mismatch_${f.paymentId}`).get()).exists
        : known.has(f.paymentId)
      if (isKnown) { r.alreadyRecorded++; continue }
      alerts.push({
        key: `late:${f.paymentId}`, fingerprint: `${f.kind}|${f.status ?? 'none'}`,
        fire: () => captureFinancialError('wallet_topup_late_payment', { scope: 'walletTopupWatch.late_payment', detail: 'payment on an ABANDONED top-up order — never credited; Super Admin review', orderId: o.id, paymentId: f.paymentId, kind: f.kind, mode }),
      })
      if (!enforce) continue
      const ok = f.kind === 'mismatch'
        ? await recordTopupPaymentMismatch({
            orderId: o.id, uid: o.uid, paymentId: f.paymentId,
            expectedAmountPaise: o.amountPaise, observedAmountPaise: f.amountPaise,
            expectedCurrency: 'INR', observedCurrency: f.currency, source: 'watch',
          })
        : await recordWalletTopupReconciliation({
            orderId: o.id, uid: o.uid, amountPaise: o.amountPaise, paymentId: f.paymentId,
            error: `late ${f.kind === 'unknown_status' ? `payment with status '${f.status ?? 'missing'}'` : `${f.kind} payment`} on an abandoned top-up order — never credited automatically`,
            status: 'needs_review',
          })
      if (!ok) r.recordFailed++
      else if (f.kind === 'mismatch') r.mismatchesRecorded++
      else r.reviewsRecorded++
    }
    return false
  }

  // Sequential (≤ 10 calls): the cursor never moves past an order that was not handled.
  let settledIdx = -1
  let failStreak = 0
  let streakStartIdx = -1
  let stopped = false
  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    if (!it.order) { settledIdx = i; continue }
    if (Date.now() >= deadline) { r.timeBudgetReached = true; stopped = true; break }
    if (r.gatewayCalls >= ABANDONED_WATCH.maxGatewayCalls) { stopped = true; break }
    const failed = await processOrder(it.order)
    if (failed) {
      if (failStreak === 0) streakStartIdx = i
      failStreak++
      if (failStreak >= ABANDONED_WATCH.circuitBreakerFailures) {
        r.circuitOpen = true
        settledIdx = streakStartIdx - 1
        stopped = true
        captureFinancialError('wallet_topup_watch_circuit_open', { scope: 'walletTopupWatch.circuit_open', detail: 'consecutive gateway lookup failures — watch stopped', gatewayCalls: r.gatewayCalls })
        break
      }
    } else failStreak = 0
    settledIdx = i
  }

  r.deferredForNextRun = items.slice(settledIdx + 1).filter(x => x.order).length
  const pageDone = !stopped || settledIdx >= items.length - 1
  if (pageDone && page.size < ABANDONED_WATCH.pageSize) {
    r.wrapped = true
    await writeCursor(ABANDONED_WATCH_CURSOR_KEY, null)
  } else if (settledIdx >= 0) {
    await writeCursor(ABANDONED_WATCH_CURSOR_KEY, items[settledIdx].id)
  }
  r.complete = !r.circuitOpen && !r.timeBudgetReached && r.deferredForNextRun === 0 && r.recordFailed === 0
  await emitDedupedAlerts(alerts)
  if (!r.complete || r.lateCaptured + r.lateAuthorized + r.unknownStatus + r.mismatched > r.alreadyRecorded) {
    console.warn('[walletTopupWatch] run summary:', r)
  }
  return r
}
