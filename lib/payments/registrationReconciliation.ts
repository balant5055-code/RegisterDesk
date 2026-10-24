// Durable reconciliation for a registration's POST-COMMIT financial side effects.
// Server-only.
//
// When a registration transaction has already committed (registration + counters
// + claims durable, payment captured), the wallet credit + platform-ledger write
// must NOT be allowed to fail the request or trigger a refund — the attendee is
// validly registered. If recordPlatformTransactionAndCredit throws (transient
// Firestore error), we persist a `registrationFinancialReconciliation` record so
// the credit can be retried out of band. Retry is idempotent because
// recordPlatformTransactionAndCredit is keyed on the ledger doc id.

import { FieldValue, FieldPath, Timestamp } from 'firebase-admin/firestore'
import type { Query, QueryDocumentSnapshot, DocumentData } from 'firebase-admin/firestore'
import { adminDb }    from '@/lib/firebase/admin'
import { captureFinancialError } from '@/lib/monitoring/sentry'
import {
  recordPlatformTransactionAndCredit,
  reversePlatformTransactionAndDebit,
  type PlatformTransactionData,
  type RevenueCreditInput,
} from '@/lib/firebase/firestore/platformTransactions'
import { buildRegistrationLedgerAndCredit } from '@/lib/payments/registrationLedger'
import type { PaymentIntentRecord } from '@/lib/firebase/firestore/paymentIntents'
// RD-PAY-P0-3 — orphaned-capture recovery. The SAME settlement the webhook uses.
import { settleCapturedRegistration } from '@/lib/payments/settleCapturedRegistration'
import { closeRefundHoldAfterFullRefund } from '@/lib/refunds/registrationRefunds'
import { upsertReconciliationCase, type CasePaymentState, type CaseStatus } from '@/lib/payments/reconciliationCases'
import { resolvePaymentProvider, readProvider } from '@/lib/payments/providers'

const COLLECTION = 'registrationFinancialReconciliation'
const REFUND_REVERSAL_COLLECTION = 'refundLedgerReconciliation'

/**
 * A payment intent materialized from a RAW Firestore snapshot.
 *
 * ═══ WHY THIS EXISTS, AND WHY THE CAST ALONE WAS A BUG ═══════════════════════
 * `doc.data() as PaymentIntentRecord` is accurate for every field except one. `provider` is
 * NON-OPTIONAL on the type — every write site must name its gateway — but it is ABSENT on
 * every document written before the discriminator existed. The cast made the compiler
 * believe the field was there, so nothing flagged the gap.
 *
 * `getPaymentIntent` normalizes it on read (paymentIntents.ts: absent → 'razorpay', a
 * statement of fact about history). These sweeps query the collection directly and so bypass
 * that reader — which means they have to do the same normalization themselves.
 *
 * Without it, `resolvePaymentProvider(undefined)` THROWS for every legacy intent, and the
 * captured-payment sweep files the failure as `razorpay_unreachable` — a reason that is not
 * true, because Razorpay was never called. The effect was that RD-PAY-P0-3 recovery, the
 * safety net for an attendee who paid and whose browser then vanished, silently recovered
 * nothing at all.
 */
function intentFromSnapshot(d: QueryDocumentSnapshot<DocumentData>): PaymentIntentRecord {
  const data = d.data()
  return { ...data, provider: readProvider(data.provider) } as PaymentIntentRecord
}

export interface RecordReconciliationInput {
  registrationId: string
  orderId:        string
  paymentId:      string
  ledger:         PlatformTransactionData
  credit:         RevenueCreditInput
  error:          string
}

/**
 * Persists (idempotently, keyed by registrationId) that a registration's
 * post-commit financial side effects failed. Never throws into the caller — the
 * registration must succeed regardless. `ledger` + `credit` are stored verbatim
 * (pure primitives) so the retry can replay them exactly.
 */
export async function recordRegistrationFinancialReconciliation(
  input: RecordReconciliationInput,
): Promise<void> {
  try {
    await adminDb.collection(COLLECTION).doc(input.registrationId).set(
      {
        registrationId: input.registrationId,
        orderId:        input.orderId,
        paymentId:      input.paymentId,
        organizerUid:   input.credit.organizerUid,
        ledger:         input.ledger,
        credit:         input.credit,
        status:         'pending',
        attempts:       FieldValue.increment(1),
        lastError:      input.error.slice(0, 500),
        updatedAt:      FieldValue.serverTimestamp(),
        firstSeenAt:    FieldValue.serverTimestamp(),   // merge keeps re-stamping; harmless
      },
      { merge: true },
    )
    captureFinancialError(input.error, {
      scope: 'registrationReconciliation.recorded',
      detail: 'wallet/ledger credit deferred for retry',
      registrationId: input.registrationId, orderId: input.orderId,
    })
  } catch (e) {
    // Last-resort: even the reconciliation write failed. Alert loudly; the
    // registration still stands and the daily reconciliation sweep can re-derive
    // uncredited registrations from successful payment intents if needed.
    captureFinancialError(e, {
      scope: 'registrationReconciliation.persist_failed',
      detail: 'CRITICAL: failed to persist reconciliation record',
      registrationId: input.registrationId,
    })
  }
}

// ─── Refund ledger reversal reconciliation ─────────────────────────────────────
//
// After a Razorpay refund succeeds, the registration is durably 'refunded' and
// the platform ledger reversal + wallet debit must NOT be allowed to leave the
// two inconsistent. If reversePlatformTransactionAndDebit throws (transient
// Firestore error), we persist a `refundLedgerReconciliation` record so the
// reversal can be retried out of band. Retry is idempotent because the reversal
// is keyed on the ledger doc id and no-ops once already reversed.

export interface RecordRefundReversalInput {
  registrationId: string
  ptxId:          string   // platform transaction id, e.g. `ptx_<registrationId>`
  organizerUid?:  string
  error:          string
}

/**
 * Persists (idempotently, keyed by registrationId) that a refund's ledger
 * reversal + wallet debit failed. Never throws into the caller — the Razorpay
 * refund already succeeded and the registration is validly 'refunded'.
 */
export async function recordRefundLedgerReconciliation(
  input: RecordRefundReversalInput,
): Promise<void> {
  try {
    await adminDb.collection(REFUND_REVERSAL_COLLECTION).doc(input.registrationId).set(
      {
        registrationId: input.registrationId,
        ptxId:          input.ptxId,
        ...(input.organizerUid ? { organizerUid: input.organizerUid } : {}),
        status:         'pending',
        attempts:       FieldValue.increment(1),
        lastError:      input.error.slice(0, 500),
        updatedAt:      FieldValue.serverTimestamp(),
        firstSeenAt:    FieldValue.serverTimestamp(),   // merge keeps re-stamping; harmless
      },
      { merge: true },
    )
    captureFinancialError(input.error, {
      scope: 'refundReversalReconciliation.recorded',
      detail: 'ledger reversal + wallet debit deferred for retry',
      registrationId: input.registrationId,
    })
  } catch (e) {
    captureFinancialError(e, {
      scope: 'refundReversalReconciliation.persist_failed',
      detail: 'CRITICAL: failed to persist refund reversal reconciliation record',
      registrationId: input.registrationId,
    })
  }
}

export interface RetryResult { scanned: number; resolved: number; stillPending: number; deferred?: number; needsReview?: number }

/**
 * Drains pending reconciliation records by replaying the atomic, idempotent
 * ledger+credit. Safe to run repeatedly and concurrently: a record already
 * credited (ledger doc exists) is a no-op credit and is marked resolved.
 */
export async function retryPendingRegistrationFinancials(limitN = 100): Promise<RetryResult> {
  // Single-equality filter → automatic single-field index (no composite needed).
  const snap = await adminDb.collection(COLLECTION)
    .where('status', '==', 'pending')
    .limit(limitN)
    .get()

  let resolved = 0
  let stillPending = 0

  for (const doc of snap.docs) {
    const d = doc.data() as { ledger?: PlatformTransactionData; credit?: RevenueCreditInput }
    if (!d.ledger || !d.credit) {
      // Malformed record — mark resolved-skipped so it stops being scanned.
      await doc.ref.set({ status: 'skipped', updatedAt: FieldValue.serverTimestamp() }, { merge: true }).catch(() => {})
      continue
    }
    try {
      await recordPlatformTransactionAndCredit(d.ledger, d.credit)   // idempotent
      await doc.ref.set(
        { status: 'resolved', resolvedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() },
        { merge: true },
      )
      resolved++
    } catch (e) {
      await doc.ref.set(
        {
          attempts:  FieldValue.increment(1),
          lastError: (e instanceof Error ? e.message : 'retry_failed').slice(0, 500),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      ).catch(() => {})
      stillPending++
    }
  }

  return { scanned: snap.size, resolved, stillPending }
}

// ─── Post-commit ledger self-heal (RD-PAY-GA-01A) ──────────────────────────────
//
// The retry drainer above handles the case where the post-commit credit failed with a
// TRANSIENT error (a reconciliation record was written). It does NOT cover the residual
// hard-kill window: if the process dies between the registration commit and the credit —
// AND before the catch writes the reconciliation record — there is no record to drain, so
// a paid registration is left uncredited and invisible (wallet reconciliation compares the
// wallet against Σ platformTransactions, and BOTH are absent, so it detects no mismatch).
//
// This forward, cursor-bounded sweep is the promised re-derivation (see the header note
// above): it walks paymentIntents in createdAt order and repairs ONLY a `paid` intent whose
// deterministic ptx_<registrationId> is missing, reusing the SAME shared ledger build and
// the SAME idempotent recordPlatformTransactionAndCredit. It writes NOTHING else — no
// ticket, registration, receipt, counter, or duplicate ledger/credit is ever created.

// Sweep window: re-scan intents created in the last LOOKBACK, skipping the most recent
// GRACE so an in-flight post-commit credit is never mistaken for a gap. A recency-window
// RE-SCAN (NOT a forward cursor) is deliberate: a forward cursor advancing over a
// still-`created` intent would permanently skip it if it settled AND gapped later. Re-
// scanning re-examines every intent while it stays in the window, so a late-settled gap is
// always caught. Cost stays bounded by the window + limit; the daily global-reconciliation
// wallet audit is the final backstop for anything beyond the window at extreme volume.
const LEDGER_SWEEP_LOOKBACK_MS = 48 * 60 * 60 * 1000
const LEDGER_SWEEP_GRACE_MS    = 5 * 60 * 1000

export interface LedgerSweepResult {
  scanned:    number   // intents read this page
  candidates: number   // paid, positive-amount registrations examined
  recovered:  number   // missing ledgers credited directly
  enqueued:   number   // credit deferred to the retry drainer on transient failure
  alreadyOk:  number   // candidates whose ptx_ already existed
}

/**
 * Detects & repairs paid registrations missing their platform-transaction ledger.
 * Idempotent and safe to run repeatedly/concurrently: the existence pre-check + the
 * idempotent recordPlatformTransactionAndCredit (ptx_<registrationId> gate) guarantee no
 * double credit; a transient failure is handed to the existing reconciliation drainer.
 */
export async function recoverUncreditedRegistrations(limitN = 500): Promise<LedgerSweepResult> {
  const now = Date.now()
  // Newest-first range on the single (auto-indexed) createdAt field — no composite index,
  // no persisted cursor. Re-examined every run so a gap on a late-settled intent is caught.
  const snap = await adminDb.collection('paymentIntents')
    .where('createdAt', '>=', Timestamp.fromMillis(now - LEDGER_SWEEP_LOOKBACK_MS))
    .where('createdAt', '<=', Timestamp.fromMillis(now - LEDGER_SWEEP_GRACE_MS))
    .orderBy('createdAt', 'desc')
    .limit(limitN)
    .get()
  if (snap.empty) return { scanned: 0, candidates: 0, recovered: 0, enqueued: 0, alreadyOk: 0 }

  // Only PAID registrations with a positive amount post a ledger (free events do not).
  const candidates = snap.docs
    .map(intentFromSnapshot)
    .filter(i => i.status === 'paid' && typeof i.registrationId === 'string' && !!i.registrationId && (i.amount ?? 0) > 0)

  let recovered = 0, enqueued = 0, alreadyOk = 0

  if (candidates.length > 0) {
    // Cheap batch existence check — only the missing ones are recovered.
    const ptxRefs  = candidates.map(i => adminDb.collection('platformTransactions').doc(`ptx_${i.registrationId}`))
    const ptxSnaps = await adminDb.getAll(...ptxRefs)
    const missing  = candidates.filter((_, idx) => !ptxSnaps[idx].exists)
    alreadyOk = candidates.length - missing.length

    for (const intent of missing) {
      const registrationId = intent.registrationId as string
      let bundle
      try {
        bundle = await buildRegistrationLedgerAndCredit({
          registrationId,
          organizerUid:     intent.organizerUid,
          eventSlug:        intent.eventSlug,
          attendeeName:     intent.attendee?.name ?? '',
          attendeeEmail:    intent.attendee?.email ?? '',
          grossAmountPaise: intent.amount,
          paymentId:        intent.paymentId ?? '',
          orderId:          intent.orderId,
          // RD-EVENT-COMMERCE-05E — the intent's OWN fee snapshot, exactly as settlement passes it
          // (settleCapturedRegistration). Without it a recovered ledger was re-derived and could
          // disagree with what the attendee was charged; the event's current fee model is never read.
          financials:       intent.financials,
          // RD-PHASE4-S2 — and its checkout-time fee inputs, exactly as settlement passes them.
          feeInputs:        intent.feeInputs,
        })
      } catch (buildErr) {
        captureFinancialError(buildErr, { scope: 'ledgerSweep.build_failed', registrationId, orderId: intent.orderId })
        continue   // daily global-reconciliation wallet audit remains the final backstop
      }
      try {
        await recordPlatformTransactionAndCredit(bundle.ledger, bundle.credit)   // idempotent
        recovered++
        captureFinancialError('registration_ledger_self_healed', {
          scope:  'ledgerSweep.recovered',
          detail: 'paid registration was missing its ptx_ ledger + credit — recovered',
          registrationId, orderId: intent.orderId,
        })
      } catch (recordErr) {
        // Transient — hand off to the existing idempotent drainer (retryPendingRegistrationFinancials).
        await recordRegistrationFinancialReconciliation({
          registrationId,
          orderId:   intent.orderId,
          paymentId: intent.paymentId ?? '',
          ledger:    bundle.ledger,
          credit:    bundle.credit,
          error:     recordErr instanceof Error ? recordErr.message : 'ledger_sweep_credit_failed',
        })
        enqueued++
      }
    }
  }

  return { scanned: snap.size, candidates: candidates.length, recovered, enqueued, alreadyOk }
}

// ─── Orphaned-capture recovery (RD-PAY-P0-3) ───────────────────────────────────
//
// THE GAP THIS CLOSES. A payment is captured the moment Razorpay's checkout handler fires.
// Everything after that — the verify-payment request, its response, the browser staying
// alive — is best effort. Until now the `payment.captured` webhook was the ONLY thing that
// could notice an orphaned capture, which made a single point of failure out of a
// third-party delivery to an endpoint whose dashboard registration nobody can verify from
// inside the app (LAUNCH_CHECKLIST 2.5/2.6). If that webhook is unregistered, misconfigured,
// or simply dropped, the attendee's money is taken and no registration ever exists.
//
// This sweep is the second, independent observer. It asks Razorpay directly about intents
// that are still `created`, and settles anything Razorpay says was paid — through the SAME
// settleCapturedRegistration the webhook uses, so the two can never diverge.
//
// WHAT IT WILL NOT DO. It never marks an intent failed and never refunds on its own
// initiative. An unpaid order is left exactly as it is: `created` is not evidence of
// failure, only of silence, and a late payment against a still-open order must remain
// settleable. Razorpay being unreachable is likewise never read as "unpaid" — the intent
// stays untouched and the next run looks again.

// Recovery window. The GRACE keeps the sweep away from in-flight checkouts: an attendee
// staring at the Razorpay modal has a `created` intent and no payment yet, and asking about
// them would be pure noise. The LOOKBACK bounds cost; anything older is a manual/finance
// concern, not an automated one.
const CAPTURE_SWEEP_LOOKBACK_MS = 24 * 60 * 60 * 1000
const CAPTURE_SWEEP_GRACE_MS    = 10 * 60 * 1000

export interface CaptureSweepResult {
  scanned:    number   // intents read in the window — now the WHOLE window, not one page
  candidates: number   // eligible: `created`, or terminal with no registration
  recovered:  number   // captured at Razorpay → registration created by this sweep
  alreadyOk:  number   // raced to settled by the webhook / browser between read and settle
  /** RD-PAYMENT-REFUND-AUTHORITY-02 — captured but refused, and PARKED for review. Was
   *  `refunded`; the sweep never refunded and now nothing in settlement does either. */
  held:       number
  unpaid:     number   // Razorpay holds nothing — left untouched, still open
  uncertain:  number   // Razorpay unreachable or settlement deferred — left recoverable
  /**
   * Eligible candidates this run did NOT contact Razorpay about, because the per-run
   * gateway-call budget was reached.
   *
   * Reported rather than silent. A sweep that quietly stops short reads as "all clear",
   * which is exactly how six captures went unnoticed for four days. Non-zero here means
   * the next tick (10 min later) picks them up — candidates are processed OLDEST FIRST,
   * so nothing can be starved indefinitely.
   */
  deferredForNextRun: number
  /** True when the window held more pages than `MAX_SCAN_PAGES` allowed. Should be false. */
  scanTruncated: boolean
}

/**
 * Finds payment intents stuck in `created`, asks Razorpay whether money was actually taken,
 * and settles the ones that were.
 *
 * Idempotent and safe to run repeatedly and concurrently with the webhook: settlement reads
 * the intent INSIDE its transaction, so whichever caller commits first wins and every other
 * observes `paid` and no-ops. No duplicate registration, ticket, email, counter increment or
 * wallet credit is possible.
 */
/**
 * Adapts one swept intent + its verdict into a durable case row.
 *
 * Every organizer-visible field comes from the INTENT — server data written at order
 * creation — never from Razorpay's payload and never from a request. The paymentId is the
 * only Razorpay-derived value, and it is stored for the recovery path, not for display.
 */
async function recordCase(
  intent: PaymentIntentRecord,
  v: { paymentState: CasePaymentState; paymentId: string | null; status: CaseStatus; reason: string; registrationId?: string | null },
): Promise<void> {
  await upsertReconciliationCase({
    orderId:       intent.orderId,
    organizerUid:  intent.organizerUid ?? '',
    eventSlug:     intent.eventSlug ?? '',
    eventName:     intent.eventName ?? '',
    attendeeName:  intent.attendee?.name ?? '',
    attendeePhone: intent.attendee?.phone ?? '',
    amountPaise:   intent.amount ?? 0,
    currency:      intent.currency ?? 'INR',
    ...v,
  })
}

export async function recoverCapturedPaymentIntents(limitN = 200): Promise<CaptureSweepResult> {
  const now = Date.now()
  const out: CaptureSweepResult = {
    scanned: 0, candidates: 0, recovered: 0, alreadyOk: 0, held: 0, unpaid: 0, uncertain: 0,
    deferredForNextRun: 0, scanTruncated: false,
  }

  // ═══ RD-FIN-04A · WHY THIS PAGINATES, AND WHY IT IS OLDEST-FIRST ═══════════
  //
  // It used to be a single `.orderBy('createdAt','desc').limit(limitN)`. Two faults, and
  // together they lost six captures:
  //
  //   • ONE PAGE. The window is 24h; the limit was 200. This event created 209 intents on
  //     20 Aug and 411 on 21 Aug, so the window simply did not fit. Everything past the
  //     newest 200 was never read — no case row, no log, no signal.
  //   • NEWEST FIRST — backwards. The newest candidates have a full 24h of retries left;
  //     the oldest are minutes from ageing out of the window forever. Sorting `desc` gave
  //     the budget to exactly the records that needed it least. Five of the six had
  //     229–436 newer intents inside their own window and were pushed out on every tick
  //     until they expired.
  //
  // Now: page through the ENTIRE window with a cursor, ascending, so the candidates
  // closest to expiry are contacted first and the queue drains from the front.
  //
  // The Firestore scan is cheap and bounded by the window. The expensive resource is the
  // per-candidate Razorpay call, so `limitN` now bounds GATEWAY CALLS rather than
  // silently bounding coverage — and any surplus is reported in `deferredForNextRun`
  // instead of vanishing. At a 10-minute cadence the drain rate is 144 × limitN per day.
  const base = adminDb.collection('paymentIntents')
    .where('createdAt', '>=', Timestamp.fromMillis(now - CAPTURE_SWEEP_LOOKBACK_MS))
    .where('createdAt', '<=', Timestamp.fromMillis(now - CAPTURE_SWEEP_GRACE_MS))
    .orderBy('createdAt', 'asc')

  const SCAN_PAGE_SIZE = 500
  // A backstop against an unbounded loop, never against coverage: 200 pages × 500 = 100k
  // intents in a 24h window, far beyond any real volume. If it ever trips, `scanTruncated`
  // says so out loud rather than the sweep pretending it finished.
  const MAX_SCAN_PAGES = 200

  const eligible: PaymentIntentRecord[] = []
  let cursor: QueryDocumentSnapshot<DocumentData> | null = null

  for (let page = 0; page < MAX_SCAN_PAGES; page++) {
    const q: Query<DocumentData> = cursor
      ? base.startAfter(cursor).limit(SCAN_PAGE_SIZE)
      : base.limit(SCAN_PAGE_SIZE)
    const snap = await q.get()
    if (snap.empty) break
    out.scanned += snap.size
    eligible.push(...snap.docs.map(intentFromSnapshot))
    cursor = snap.docs[snap.docs.length - 1]
    if (snap.size < SCAN_PAGE_SIZE) break
    if (page === MAX_SCAN_PAGES - 1) out.scanTruncated = true
  }

  if (out.scanned === 0) return out

  // ═══ RD-PAY-RECON-01 · WHY `registration_failed` IS NOW A CANDIDATE ══════════
  //
  // A Razorpay ORDER accepts multiple payment ATTEMPTS. The trap that produced silent
  // orphans is four steps long, and every step is individually correct:
  //
  //   1. Attempt 1 fails → `payment.failed` → the webhook's failure handler writes
  //      `registration_failed` (a misnomer: registration was never attempted — the PAYMENT
  //      attempt failed).
  //   2. The attendee retries THE SAME ORDER and succeeds → `payment.captured`.
  //   3. The webhook sees a terminal intent and skips, returning 200 — so Razorpay treats
  //      delivery as successful and never retries it.
  //   4. This sweep only looked at `created`, so it could not see the case either.
  //
  // Money captured, no registration, no refund, no alert. Nothing in the system was left
  // watching, which is why the first one was found by hand.
  //
  // A terminal intent is included ONLY when it has no registrationId. One that already
  // carries one is settled by definition, and re-examining it would just spend a Razorpay
  // call to reach `already_settled`.
  const allCandidates = eligible
    .filter(i =>
      (i.status === 'created' || (i.status === 'registration_failed' && !i.registrationId))
      && (i.amount ?? 0) > 0 && typeof i.orderId === 'string' && !!i.orderId)
  out.candidates = allCandidates.length

  // `limitN` bounds Razorpay calls, not coverage. The list is already oldest-first, so the
  // slice keeps the records nearest to ageing out of the window and defers the youngest —
  // which still have hours of ticks ahead of them.
  const candidates = allCandidates.slice(0, limitN)
  out.deferredForNextRun = allCandidates.length - candidates.length
  if (out.deferredForNextRun > 0 || out.scanTruncated) {
    // Loud on purpose. A silently truncated sweep is indistinguishable from a clean one.
    console.warn('[captureSweep] budget reached — candidates deferred to the next run:', {
      candidates: out.candidates, processed: candidates.length,
      deferred: out.deferredForNextRun, scanned: out.scanned, scanTruncated: out.scanTruncated,
    })
  }

  for (const intent of candidates) {
    // Ask the authority. Only a payment matching the intent's OWN amount and currency
    // counts — the same defence-in-depth check the webhook applies to its payload, so a
    // mismatched or foreign payment can never settle this registration.
    let payment: { id?: string; status?: string } | undefined
    try {
      // RD-PAYMENT-PROVIDER-CONTRACT-04 — asked of the intent's OWN provider, so a sweep
      // over mixed-provider intents contacts the right gateway for each one. The predicate
      // is unchanged: same statuses, same amount, same currency.
      const payments = await resolvePaymentProvider(intent.provider).fetchOrderPayments(intent.orderId)
      const hit = payments.find(p =>
        (p.status === 'captured' || p.status === 'authorized') &&
        p.currency === 'INR' && p.amountPaise === intent.amount)
      payment = hit ? { id: hit.providerPaymentId, status: hit.status } : undefined
    } catch (err) {
      // FAIL-CLOSED: unreachable is NOT unpaid. Leave the intent alone and look again.
      captureFinancialError(err, { scope: 'captureSweep.fetch_payments_failed', detail: 'left recoverable', orderId: intent.orderId })
      out.uncertain++
      // RD-PAY-RECON-02 — indeterminate, and it must READ as indeterminate. Recording this
      // as `not_captured` would be the same mistake as treating an unreachable gateway as
      // "unpaid": it hides a possible orphan behind a network blip.
      await recordCase(intent, { paymentState: 'unverified', paymentId: null, status: 'requires_review', reason: 'razorpay_unreachable' })
      continue
    }

    if (!payment?.id) {
      out.unpaid++
      // RD-PAY-RECON-02 — Razorpay holds nothing matching this order. Recorded so a later
      // run can see it was checked, but `not_captured` is never surfaced to an organizer:
      // a declined card is not a payment issue, and listing it would bury the real ones.
      await recordCase(intent, { paymentState: 'not_captured', paymentId: null, status: 'requires_review', reason: 'no_matching_payment' })
      continue
    }

    // ═══ RD-FIN-02 · R2 — AUTHORIZED IS NOT MONEY YET ══════════════════════════
    // The same rule licensing (RD-F1) and top-ups (W1.1) already apply. Orders are created without a
    // capture instruction, so capture is Razorpay's ACCOUNT-LEVEL auto-capture (a production
    // prerequisite — docs/LAUNCH_CHECKLIST.md). After this sweep's 10-minute grace an auto-captured
    // payment reads `captured`; one still `authorized` means capture is not happening, and settling it
    // would confirm a registration (and credit a wallet) for money that may be released. Never settle
    // it, never mark it failed — record it for review and look again next run.
    if (payment.status === 'authorized') {
      out.uncertain++
      await recordCase(intent, { paymentState: 'unverified', paymentId: payment.id, status: 'requires_review', reason: 'authorized_not_captured' })
      continue
    }

    // ═══ RECOVERY AUTHORIZATION — TERMINAL INTENTS ONLY ════════════════════════
    //
    // `settleCapturedRegistration` refuses a terminal intent outright (`intent_terminal`).
    // That guard is correct and stays: it is what stops every skipped capture settling
    // itself unverified. The recovery option lifts it for exactly one caller — one that has
    // just proved, against Razorpay, that THIS payment on THIS order was accepted for THIS
    // amount and currency.
    //
    // The token is the paymentId itself, and the settlement re-checks
    // `recovery.verifiedCapturedPaymentId === paymentId`, so it cannot authorise a different
    // payment than the one verified here. It is attached ONLY for a terminal intent: a
    // `created` intent takes the byte-identical path it took before this change, refund
    // policy and all.
    //
    // What the recovery flag does NOT do is widen the gates. Timing-only refusals
    // (registration/pass window closed) proceed — the money was taken while the window was
    // open. Every SUBSTANTIVE refusal — capacity, cancelled event, inactive pass, duplicate —
    // still stops, and stops WITHOUT refunding: handing back a legitimate capture is an
    // operator decision, and Phase 2's reconciliation queue is where it belongs.
    const isTerminalRecovery = intent.status === 'registration_failed'

    const outcome = await settleCapturedRegistration({
      orderId:   intent.orderId,
      paymentId: payment.id,
      intent,
      source:    'sweep',
      ...(isTerminalRecovery ? { recovery: { verifiedCapturedPaymentId: payment.id } } : {}),
    })

    if (outcome.kind === 'settled') {
      out.recovered++
      captureFinancialError('orphaned_capture_recovered', {
        scope:  'captureSweep.recovered',
        detail: 'payment was captured at Razorpay but never settled by the browser or webhook',
        orderId: intent.orderId, paymentId: payment.id, registrationId: outcome.registrationId,
      })
    } else if (outcome.kind === 'already_settled') {
      out.alreadyOk++
    } else if (outcome.kind === 'held') {
      out.held++
    } else {
      out.uncertain++
    }

    // ═══ RD-PAY-RECON-02 · PERSIST THE VERDICT ═════════════════════════════════
    //
    // Written HERE because this is the only place that holds all three facts at once: the
    // intent, what Razorpay said, and what the settlement decided. Deriving any of them
    // again later would mean a second Razorpay call per row on page load.
    //
    // `settled`/`already_settled` ⇒ resolved: a registration exists, so there is nothing for
    // an organizer to do. Everything else keeps `captured` — money is real — and lands in
    // `requires_review` UNLESS the settlement said `deferred`, which is the one outcome that
    // means "nothing was written and it is safe to try again".
    const settledId =
      outcome.kind === 'settled' || outcome.kind === 'already_settled' ? outcome.registrationId : null

    await recordCase(intent, {
      paymentState:   'captured',
      paymentId:      payment.id,
      status:         settledId ? 'resolved' : (outcome.kind === 'deferred' ? 'actionable' : 'requires_review'),
      reason:         settledId ? 'recovered' : `${outcome.kind}:${'reason' in outcome ? outcome.reason : 'unknown'}`,
      registrationId: settledId,
    })
  }

  return out
}

// ─── Phase 3.3 · bounded retry for the registration refund queues ────────────────────────────────────────
// Both refund queues (refundLedgerReconciliation, refundHoldClosureReconciliation) used to retry every
// pending record on every run, forever, in no order — a few permanently failing records could fill every
// batch forever. Now:
//   • attempts are capped (REFUND_QUEUE_MAX_ATTEMPTS). A failed record is retried on the NEXT run, as before
//     (no time backoff — a fixed cause is picked up at once); at the cap it leaves the batch;
//   • a permanent failure, or the cap, ESCALATES the record to `needs_review` (attempts, lastError,
//     escalatedAt, escalationReason kept as evidence; alerted; counted in operations health). It is never
//     dropped and never forced — a human decides;
//   • the drain pages `pending` records in document-id order (equality + __name__: no composite index) and
//     takes up to limitN DUE ones, so records held by another drain's lease never consume the batch;
//   • each record is CLAIMED (a short lease on nextAttemptAt, in a transaction) before its work runs, so
//     concurrent drains run it once; a drain that dies mid-record leaves it due again when the lease ends.
// The work each record replays is unchanged and idempotent.

export const REFUND_QUEUE_MAX_ATTEMPTS = 8
const REFUND_QUEUE_PAGE = 100
const REFUND_QUEUE_SCAN_CAP = 2_000
const REFUND_QUEUE_LEASE_MS = 2 * 60_000
/** Failures no retry can fix (the reversal cannot tell which wallet bucket holds the funds). */
export function isPermanentRefundQueueError(message: string): boolean {
  return /^REVERSAL_BUCKET_UNKNOWN/.test(message)
}

const dueAt = (doc: { get(field: string): unknown }): number | null => {
  const next = doc.get('nextAttemptAt') as { toMillis?: () => number } | undefined
  return typeof next?.toMillis === 'function' ? next.toMillis() : null
}

/** Up to limitN DUE `pending` records of a queue, in document-id order (bounded scan). */
async function dueRefundQueueRecords(collection: string, limitN: number): Promise<{ due: QueryDocumentSnapshot<DocumentData>[]; scanned: number; deferred: number }> {
  const due: QueryDocumentSnapshot<DocumentData>[] = []
  let scanned = 0, deferred = 0
  let cursor: string | null = null
  const now = Date.now()
  while (due.length < limitN && scanned < REFUND_QUEUE_SCAN_CAP) {
    let q = adminDb.collection(collection).where('status', '==', 'pending').orderBy(FieldPath.documentId())
    if (cursor) q = q.startAfter(cursor)
    const page = await q.limit(REFUND_QUEUE_PAGE).get()
    for (const doc of page.docs) {
      scanned++
      const at = dueAt(doc)
      if (at !== null && at > now) deferred++
      else if (due.length < limitN) due.push(doc)
    }
    if (page.size < REFUND_QUEUE_PAGE) break
    cursor = page.docs[page.docs.length - 1].id
  }
  return { due, scanned, deferred }
}

/** Claims a due record for THIS drain (lease on nextAttemptAt). False ⇒ another drain has it, or it is no longer pending. */
async function claimRefundQueueRecord(ref: FirebaseFirestore.DocumentReference): Promise<boolean> {
  return adminDb.runTransaction(async tx => {
    const snap = await tx.get(ref)
    if (!snap.exists || snap.get('status') !== 'pending') return false
    const at = dueAt(snap)
    if (at !== null && at > Date.now()) return false
    tx.update(ref, { nextAttemptAt: Timestamp.fromMillis(Date.now() + REFUND_QUEUE_LEASE_MS), lastAttemptAt: FieldValue.serverTimestamp() })
    return true
  })
}

/** One failed run of a claimed record: count it (due again next run — the lease is released), or escalate to needs_review (alerted). */
async function recordRefundQueueFailure(ref: FirebaseFirestore.DocumentReference, error: string, scope: string): Promise<'retry' | 'needs_review' | 'gone'> {
  const out = await adminDb.runTransaction(async tx => {
    const snap = await tx.get(ref)
    if (!snap.exists || snap.get('status') !== 'pending') return 'gone' as const
    const prev = snap.get('attempts')
    const attempts = (typeof prev === 'number' && Number.isFinite(prev) ? prev : 0) + 1
    const permanent = isPermanentRefundQueueError(error)
    const escalate = permanent || attempts >= REFUND_QUEUE_MAX_ATTEMPTS
    tx.update(ref, {
      attempts, lastError: error.slice(0, 500), lastAttemptAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
      ...(escalate
        ? { status: 'needs_review', escalatedAt: FieldValue.serverTimestamp(), escalationReason: permanent ? 'permanent_error' : 'max_attempts', nextAttemptAt: FieldValue.delete() }
        : { nextAttemptAt: FieldValue.delete() }),
    })
    return escalate ? 'needs_review' as const : 'retry' as const
  })
  if (out === 'needs_review') {
    captureFinancialError(new Error(`refund queue record NEEDS REVIEW: ${error}`.slice(0, 500)), { scope: `${scope}.needs_review`, recordId: ref.id })
  }
  return out
}

/**
 * Drains pending refund-reversal records by replaying the atomic, idempotent
 * ledger reversal + wallet debit. Safe to run repeatedly and concurrently: a
 * ledger entry already reversed is a no-op and is marked resolved. Phase 3.3:
 * bounded (backoff, attempt cap → needs_review) and paged past backed-off records.
 */
export async function retryPendingRefundLedgerReversals(limitN = 100): Promise<RetryResult> {
  const { due, scanned, deferred } = await dueRefundQueueRecords(REFUND_REVERSAL_COLLECTION, limitN)

  let resolved = 0
  let stillPending = 0
  let needsReview = 0

  for (const doc of due) {
    const d = doc.data() as { ptxId?: string }
    if (!d.ptxId) {
      await doc.ref.set({ status: 'skipped', updatedAt: FieldValue.serverTimestamp() }, { merge: true }).catch(() => {})
      continue
    }
    if (!(await claimRefundQueueRecord(doc.ref).catch(() => false))) continue   // another drain has it
    try {
      await reversePlatformTransactionAndDebit(d.ptxId)   // idempotent
      await doc.ref.set(
        { status: 'resolved', resolvedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(), nextAttemptAt: FieldValue.delete() },
        { merge: true },
      )
      resolved++
    } catch (e) {
      const r = await recordRefundQueueFailure(doc.ref, e instanceof Error ? e.message : 'retry_failed', 'refundReversalReconciliation')
        .catch(() => 'retry' as const)
      if (r === 'needs_review') needsReview++
      else stillPending++
    }
  }

  return { scanned, resolved, stillPending, deferred, needsReview }
}

// ─── M1 follow-up · durable retry of a refund-hold CLOSURE ─────────────────────────────────────────

const HOLD_CLOSURE_COLLECTION = 'refundHoldClosureReconciliation'

/**
 * M1 — the closure of a settlement refund hold (closeRefundHoldAfterFullRefund) could not run or failed
 * (transaction / audit-write failure, or the ledger reversal it depends on was deferred). Persist a
 * durable, idempotent retry record keyed by registration — the hold itself stays in place and visible.
 * Returns whether the record was persisted: a caller that cannot persist it must fail loudly (non-2xx)
 * so the provider redelivers.
 */
export async function recordRefundHoldClosureRetry(input: {
  registrationId: string; orderId: string; refundId: string; error: string
}): Promise<boolean> {
  try {
    await adminDb.collection(HOLD_CLOSURE_COLLECTION).doc(input.registrationId).set({
      registrationId: input.registrationId,
      orderId:        input.orderId,
      ptxId:          `ptx_${input.registrationId}`,
      refundId:       input.refundId,
      status:         'pending',
      attempts:       FieldValue.increment(1),
      lastError:      input.error.slice(0, 500),
      updatedAt:      FieldValue.serverTimestamp(),
    }, { merge: true })
    captureFinancialError(new Error(`refund hold closure deferred for retry: ${input.error}`.slice(0, 500)), {
      scope: 'refundHoldClosureReconciliation.recorded', registrationId: input.registrationId, orderId: input.orderId,
    })
    return true
  } catch (e) {
    captureFinancialError(e, {
      scope: 'refundHoldClosureReconciliation.persist_failed',
      detail: 'CRITICAL: failed to persist refund hold closure retry record', registrationId: input.registrationId,
    })
    return false
  }
}

/** Closure outcomes that end a retry record: the hold is closed (or was already closed / never held). */
const CLOSURE_DONE = new Set(['no_hold'])
/** Outcomes that must WAIT: the ledger reversal is itself still pending reconciliation. */
const CLOSURE_WAIT = new Set(['not_reversed'])

export interface HoldClosureRetryResult { scanned: number; closed: number; refused: number; stillPending: number; deferred: number; needsReview: number }

/**
 * Drains pending closure records by re-running closeRefundHoldAfterFullRefund — one transaction that
 * re-checks ALL evidence and writes its audit row in the same commit; it moves no money and is safe to
 * repeat or run concurrently (a second run finds no hold). A closure the evidence refuses (an open
 * contradiction) is NOT forced: the record becomes `refused` with the reason, alerted, and the hold
 * stays for the Super Admin review. Run after the refund-ledger reversal retry (a deferred reversal
 * must land first). Phase 3.3: waiting on the reversal and failures both count bounded attempts (backoff;
 * the cap escalates to needs_review), and the drain pages past backed-off records.
 */
export async function retryPendingRefundHoldClosures(limitN = 100): Promise<HoldClosureRetryResult> {
  const { due, scanned, deferred } = await dueRefundQueueRecords(HOLD_CLOSURE_COLLECTION, limitN)
  const out: HoldClosureRetryResult = { scanned, closed: 0, refused: 0, stillPending: 0, deferred, needsReview: 0 }
  const failed = async (ref: FirebaseFirestore.DocumentReference, error: string) => {
    const r = await recordRefundQueueFailure(ref, error, 'refundHoldClosureReconciliation').catch(() => 'retry' as const)
    if (r === 'needs_review') out.needsReview++
    else out.stillPending++
  }
  for (const doc of due) {
    const d = doc.data() as { registrationId?: unknown; orderId?: unknown }
    if (typeof d.registrationId !== 'string' || typeof d.orderId !== 'string') {
      await doc.ref.set({ status: 'skipped', updatedAt: FieldValue.serverTimestamp() }, { merge: true }).catch(() => {})
      continue
    }
    if (!(await claimRefundQueueRecord(doc.ref).catch(() => false))) continue   // another drain has it
    try {
      const r = await closeRefundHoldAfterFullRefund({ orderId: d.orderId, registrationId: d.registrationId })
      if (r.closed || CLOSURE_DONE.has(r.why)) {
        await doc.ref.set({ status: 'resolved', outcome: r.closed ? 'closed' : r.why, resolvedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(), nextAttemptAt: FieldValue.delete() }, { merge: true })
        out.closed++
      } else if (CLOSURE_WAIT.has(r.why)) {
        await failed(doc.ref, `waiting: ${r.why}`)
      } else {
        await doc.ref.set({ status: 'refused', outcome: r.why, updatedAt: FieldValue.serverTimestamp(), nextAttemptAt: FieldValue.delete() }, { merge: true })
        captureFinancialError(new Error(`refund hold not closed on retry: ${r.why}`), {
          scope: 'refundHoldClosureReconciliation.refused', why: r.why, registrationId: d.registrationId, orderId: d.orderId,
        })
        out.refused++
      }
    } catch (e) {
      captureFinancialError(e, { scope: 'refundHoldClosureReconciliation.retry_failed', registrationId: d.registrationId })
      await failed(doc.ref, e instanceof Error ? e.message : 'retry_failed')
    }
  }
  return out
}
