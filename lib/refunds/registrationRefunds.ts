// RD-FIN-01 · Firestore I/O for registration refunds. Decisions live in `refundPolicy.ts`.

import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { adminDb }    from '@/lib/firebase/admin'
import { stageAdminAudit } from '@/lib/admin/audit'
import { pendingRefundMatches, accumulateRefund, isCountedRefund, type RefundAccumulation } from '@/lib/refunds/refundPolicy'
import {
  initialStatusFor,
  validateRefundInput,
  buildLinkagePatch,
  canApplySideEffects,
} from './refundPolicy'

import { MANUAL_REFUNDS_COLLECTION, type ManualRefundDocument } from '@/lib/refunds/manualRefundRules'
import type {
  RegistrationRefundDocument,
  RecordRefundInput,
  RefundReviewReason,
} from './types'

export const REGISTRATION_REFUNDS_COLLECTION = 'registrationRefunds'

function refundsCol() {
  return adminDb.collection(REGISTRATION_REFUNDS_COLLECTION)
}

/**
 * Persist the gateway refund, keyed by the Razorpay refund id.
 *
 * Create-if-absent inside a transaction, so concurrent deliveries of the same refund
 * serialize and exactly one wins. The loser gets `{ created: false }` and the record it
 * lost to — never an error, because a duplicate delivery is normal, not exceptional.
 *
 * Called BEFORE any attempt to resolve a registration. That ordering is the entire point:
 * the old code claimed the event first and returned empty-handed when attribution failed,
 * which is how two real refunds ceased to exist inside RegisterDesk.
 */
export async function ensureRegistrationRefundRecord(
  input: RecordRefundInput,
): Promise<{ created: boolean; record: RegistrationRefundDocument }> {
  const valid = validateRefundInput(input)
  if (!valid.ok) throw new Error(`refund_record_invalid:${valid.reason}`)

  const ref = refundsCol().doc(input.razorpayRefundId)

  return adminDb.runTransaction(async tx => {
    const snap = await tx.get(ref)
    if (snap.exists) {
      return { created: false, record: snap.data() as RegistrationRefundDocument }
    }

    const doc: RegistrationRefundDocument = {
      id:               input.razorpayRefundId,
      razorpayRefundId: input.razorpayRefundId,
      gatewayPaymentId: input.gatewayPaymentId ?? null,
      gatewayOrderId:   input.gatewayOrderId ?? null,
      registrationId:   input.registrationId ?? null,
      eventSlug:        input.eventSlug ?? null,
      organizerUid:     input.organizerUid ?? null,
      amountPaise:      input.amountPaise,
      // Derived from attribution unless the caller states otherwise — see `status` on
      // RecordRefundInput. A refund that is already complete must not be left claimable.
      status:           input.status ?? initialStatusFor(input.registrationId),
      origin:           input.origin,
      initiatedBy:      input.initiatedBy,
      reason:           input.reason,
      createdAt:        FieldValue.serverTimestamp(),
      ...(input.registrationId ? { linkedAt: FieldValue.serverTimestamp() } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
    }
    tx.set(ref, doc)
    return { created: true, record: doc }
  })
}

/**
 * Fill in the registration linkage on a refund that was recorded without one.
 *
 * Only ever writes over NULL — see `buildLinkagePatch`. A refund already attributed to a
 * registration is never re-pointed, because the only way that happens is a bug upstream
 * and silently moving money between attendees is the worst possible response to it.
 */
export async function linkRefundToRegistration(
  razorpayRefundId: string,
  resolved: { registrationId: string; eventSlug: string | null; organizerUid: string | null },
): Promise<{ linked: boolean }> {
  const ref = refundsCol().doc(razorpayRefundId)
  return adminDb.runTransaction(async tx => {
    const snap = await tx.get(ref)
    if (!snap.exists) return { linked: false }
    const patch = buildLinkagePatch(snap.data() as RegistrationRefundDocument, resolved)
    if (!patch) return { linked: false }
    tx.update(ref, { ...patch, linkedAt: FieldValue.serverTimestamp() })
    return { linked: true }
  })
}

/**
 * Claim the right to run this refund's side effects, exactly once.
 *
 * Transitions the record to `processed` inside a transaction and reports whether THIS
 * caller made the transition. Only the winner may update the registration, reverse the
 * ledger and debit the wallet.
 *
 * This replaces the old `refundWebhookEvents` claim marker — same guarantee, except the
 * claim now lives on the record that holds the money rather than in a parallel collection
 * that could be claimed for a refund nobody had stored.
 */
export async function claimRefundSideEffects(
  razorpayRefundId: string,
  /**
   * RD-REFUND-RECOVER-01 — when given, the registration is marked refunded and the ledger reversal
   * is made RECOVERABLE in the SAME transaction as the claim (see stageReversalOwed). Without it a
   * crash after the claim left the registration `paid` with the ledger unreversed, and every
   * redelivery found the claim taken and returned. Refused (claimed:false) unless the registration
   * is still `paid` inside the transaction.
   */
  opts: { markRegistration?: { registrationId: string; refundAmountPaise: number } } = {},
): Promise<{ claimed: boolean; record: RegistrationRefundDocument | null }> {
  const ref = refundsCol().doc(razorpayRefundId)
  const mark = opts.markRegistration
  return adminDb.runTransaction(async tx => {
    const regRef = mark ? adminDb.collection('registrations').doc(mark.registrationId) : null
    const ptxRef = mark ? adminDb.collection('platformTransactions').doc(`ptx_${mark.registrationId}`) : null
    const [snap, regSnap, ptxSnap] = await Promise.all([
      tx.get(ref), regRef ? tx.get(regRef) : Promise.resolve(null), ptxRef ? tx.get(ptxRef) : Promise.resolve(null),
    ])
    if (!snap.exists) return { claimed: false, record: null }
    const record = snap.data() as RegistrationRefundDocument
    if (!canApplySideEffects(record.status)) return { claimed: false, record }
    // Re-checked HERE: a registration that became refund_pending / refunded since the caller read it
    // belongs to the finalize path (or is done) — never re-marked from this one.
    const regStatus = regSnap?.get('paymentStatus')
    if (mark && (!regSnap?.exists || regStatus === 'refund_pending' || regStatus === 'refunded')) return { claimed: false, record }
    tx.update(ref, { status: 'processed', processedAt: FieldValue.serverTimestamp() })
    if (mark && regRef && ptxSnap) {
      tx.update(regRef, {
        paymentStatus: 'refunded', refundId: razorpayRefundId, refundAmount: mark.refundAmountPaise,
        refundedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
      })
      stageReversalOwed(tx, mark.registrationId, razorpayRefundId, ptxSnap, regSnap?.get('organizerUid'))
    }
    return { claimed: true, record }
  })
}

// ─── RD-REFUND-RECOVER-01 · a refund's ledger reversal is OWED from the moment it is recorded ──────

/** Drained by lib/payments/registrationReconciliation.ts retryPendingRefundLedgerReversals (same doc shape). */
export const REFUND_REVERSAL_QUEUE = 'refundLedgerReconciliation'
/** The inline reversal normally runs within seconds; the drain waits this long before replaying it. */
export const REVERSAL_QUEUE_GRACE_MS = 5 * 60 * 1000

/**
 * WRITES, inside the transaction that marks a registration refunded (after every read). Two things,
 * atomic with that transition, so no crash between "refunded" and "ledger reversed" can lose either:
 *   • an UNRELEASED settlement is held (`releaseStatus: 'held'`, reason `refund_reversal_pending`): the
 *     release job only takes pending, unheld rows, so money the attendee got back is never released to
 *     the organizer while its reversal is outstanding. An existing hold (a refund review) is kept as is.
 *   • the reversal is queued (`refundLedgerReconciliation/{registrationId}`, due after a grace period):
 *     the drain replays the idempotent reversal, so it happens even if this process dies right after.
 * A row already reversed (not `completed`) or absent needs neither.
 */
function stageReversalOwed(
  tx: FirebaseFirestore.Transaction, registrationId: string, refundId: string,
  ptxSnap: FirebaseFirestore.DocumentSnapshot, organizerUid: unknown,
): void {
  const ptx = ptxSnap.exists ? ptxSnap.data() as { status?: unknown; releaseStatus?: unknown; releaseHold?: unknown } : null
  if (!ptx || ptx.status !== 'completed') return
  if (ptx.releaseStatus === 'pending' && !ptx.releaseHold) {
    tx.update(ptxSnap.ref, {
      releaseStatus: 'held',
      releaseHold:   { reason: 'refund_reversal_pending', refundIds: [refundId], heldAt: FieldValue.serverTimestamp() },
      updatedAt:     FieldValue.serverTimestamp(),
    })
  }
  tx.set(adminDb.collection(REFUND_REVERSAL_QUEUE).doc(registrationId), {
    registrationId,
    ptxId:         ptxSnap.id,
    ...(typeof organizerUid === 'string' && organizerUid ? { organizerUid } : {}),
    status:        'pending',
    lastError:     'queued with the refund — the inline reversal normally resolves it',
    nextAttemptAt: Timestamp.fromMillis(Date.now() + REVERSAL_QUEUE_GRACE_MS),
    updatedAt:     FieldValue.serverTimestamp(),
    firstSeenAt:   FieldValue.serverTimestamp(),
  }, { merge: true })
}

/**
 * RD-REFUND-STATUS-01 — a refund Razorpay ACCEPTED but has not yet processed: hold the UNRELEASED
 * settlement so the release job cannot pay the organizer money that is on its way back to the
 * attendee. Nothing is reversed or queued (the refund may still fail). The hold is the existing
 * refund-review hold, so it is visible in the Super Admin refund-holds review: refund.processed then
 * finalizes (the hold is kept, the reversal runs, the full-refund closure lifts it); refund.failed
 * leaves it for review, where it can be lifted once the gateway shows no refund. Idempotent; an
 * existing hold, a released or a reversed row is left as it is. Returns whether it placed the hold.
 */
export async function holdSettlementForPendingRefund(registrationId: string, refundId: string): Promise<boolean> {
  const ref = adminDb.collection('platformTransactions').doc(`ptx_${registrationId}`)
  return adminDb.runTransaction(async tx => {
    const snap = await tx.get(ref)
    const d = snap.exists ? snap.data() as { status?: unknown; releaseStatus?: unknown; releaseHold?: unknown } : null
    if (!d || d.status !== 'completed' || d.releaseStatus !== 'pending' || d.releaseHold) return false
    tx.update(ref, {
      releaseStatus: 'held',
      releaseHold:   { reason: 'refund_review', refundIds: [refundId], heldAt: FieldValue.serverTimestamp() },
      updatedAt:     FieldValue.serverTimestamp(),
    })
    return true
  })
}

/**
 * After the inline reversal SUCCEEDED: resolves the queued record (only while still `pending`, so a
 * drain that already took it is never overwritten). Best-effort — a record left pending is replayed
 * by the drain as an idempotent no-op and resolved there.
 */
export async function resolveQueuedRefundReversal(registrationId: string): Promise<void> {
  const ref = adminDb.collection(REFUND_REVERSAL_QUEUE).doc(registrationId)
  await adminDb.runTransaction(async tx => {
    const snap = await tx.get(ref)
    if (!snap.exists || snap.get('status') !== 'pending') return
    tx.update(ref, { status: 'resolved', resolvedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(), nextAttemptAt: FieldValue.delete() })
  }).catch(() => undefined)
}

/** Record the ledger outcome after the reversal ran. Best-effort, never blocks. */
export async function recordRefundLedgerOutcome(
  razorpayRefundId: string,
  outcome: { reversed: boolean; debitedPaise: number },
): Promise<void> {
  await refundsCol().doc(razorpayRefundId).update({
    ledgerReversed:      outcome.reversed,
    ledgerReversedPaise: outcome.debitedPaise,
  })
}

/**
 * Refunds the gateway told us about but that we could not attribute.
 *
 * Reporting surface for reconciliation. Returns records, not a repair — attribution needs
 * evidence this function does not have.
 */
export async function findUnlinkedRefunds(limit = 100): Promise<RegistrationRefundDocument[]> {
  const snap = await refundsCol().where('status', '==', 'unlinked').limit(limit).get()
  return snap.docs.map(d => d.data() as RegistrationRefundDocument)
}

/** Every refund recorded against one event. Read-only reporting. */
export async function listRefundsForEvent(eventSlug: string, limit = 500): Promise<RegistrationRefundDocument[]> {
  const snap = await refundsCol().where('eventSlug', '==', eventSlug).limit(limit).get()
  return snap.docs.map(d => d.data() as RegistrationRefundDocument)
}

// ─── The canonical organizer-scoped refund read ──────────────────────────────

/** Refunds are inherently low-cardinality; the cap exists so a read can never be unbounded. */
export const ORGANIZER_REFUND_READ_CAP = 1000

/** How many unattributed refunds one read will try to re-attribute. Should be near zero. */
export const UNATTRIBUTED_REFUND_SCAN_CAP = 50

export interface OrganizerRefundRead {
  records:    RegistrationRefundDocument[]
  /** Of `records`, how many came from the unattributed pool. Normally 0. */
  recovered:  number
  /** Exact count of ATTRIBUTED refunds in scope, even when `records` was truncated. */
  ownedCount: number | null
  /** False when a read failed or a cap was hit — the caller must not present a total as whole. */
  complete:   boolean
}

/**
 * Refunds stored with NO organizerUid, re-attributed through their payment intent.
 *
 * ═══ WHY THIS POOL EXISTS AT ALL ═════════════════════════════════════════════
 * `ensureRegistrationRefundRecord` deliberately persists a refund BEFORE it tries to resolve
 * one — a refund that cannot be attributed must still survive, because the alternative is the
 * failure mode that made two real refunds cease to exist inside RegisterDesk. The cost of that
 * design is refunds with a null organizerUid, and any reader that scopes strictly by
 * organizerUid drops every one of them. Real money leaves the account and nobody can see it.
 *
 * ═══ WHY THE PAYMENT INTENT IS THE RIGHT SOURCE ══════════════════════════════
 * The intent is keyed by the gateway ORDER id and records which organizer and event the order
 * was raised for. That is the payment's own attribution — not a registration status, not a
 * guess from an amount or a name. A refund with no intent stays unattributed rather than being
 * assigned to whoever happens to be looking.
 */
async function recoverUnattributed(
  organizerUid: string, eventSlug: string | null,
): Promise<{ records: RegistrationRefundDocument[]; complete: boolean }> {
  const pool = refundsCol().where('organizerUid', '==', null)

  let total: number
  try { total = (await pool.count().get()).data().count } catch { return { records: [], complete: false } }
  if (total === 0) return { records: [], complete: true }
  if (total > UNATTRIBUTED_REFUND_SCAN_CAP) return { records: [], complete: false }

  let candidates: RegistrationRefundDocument[]
  try {
    candidates = (await pool.limit(UNATTRIBUTED_REFUND_SCAN_CAP).get())
      .docs.map(d => d.data() as RegistrationRefundDocument)
  } catch { return { records: [], complete: false } }

  // ═══ RD-DASH-13 · THE ATTRIBUTION CHECK, UNCHANGED; THE READS, PARALLEL ════
  // Every candidate is still admitted ONLY if its own payment intent names this
  // organizer (and this event, when scoped). That filter is the security property and it
  // is byte-for-byte the same test as before — the loop that applied it one intent at a
  // time is what changed. Capped at UNATTRIBUTED_REFUND_SCAN_CAP candidates already, so
  // this opens at most that many reads, and normally zero to two.
  //
  // ONE behavioural difference, stated plainly: the serial version returned early on the
  // first unreadable intent, so it yielded the candidates found BEFORE that point. This
  // yields every candidate that resolved successfully. Both mark `complete: false`; the
  // new result is a superset of the old one and never a smaller or different set. It can
  // only be reached when a paymentIntents read fails, which has not been observed.
  const withOrder = candidates.filter(r => !!r.gatewayOrderId)
  let failed = false
  const checked = await Promise.all(withOrder.map(async r => {
    try {
      const snap = await adminDb.collection('paymentIntents').doc(r.gatewayOrderId!).get()
      if (!snap.exists) return null
      const intent = snap.data() as { organizerUid?: unknown; eventSlug?: unknown }
      if (intent.organizerUid !== organizerUid) return null
      if (eventSlug && intent.eventSlug !== eventSlug) return null
      return r
    } catch { failed = true; return null }
  }))
  const out = checked.filter((r): r is RegistrationRefundDocument => r !== null)
  return { records: out, complete: !failed }
}

/**
 * RD-REFUND-MANUAL-01 — COMPLETED manual refunds (money returned outside the gateway, lib/refunds/manualRefunds.ts),
 * projected into the refund-record shape so every finance surface and report counts them exactly like a gateway
 * refund: amount = the gross returned, date = when the transfer was recorded, origin 'manual'. Pending and
 * cancelled requests moved no money and are left out. Equality filters only (no composite index).
 */
async function readCompletedManualRefunds(
  organizerUid: string, eventSlug: string | null, cap: number,
): Promise<{ records: RegistrationRefundDocument[]; count: number | null; complete: boolean }> {
  try {
    const q = adminDb.collection(MANUAL_REFUNDS_COLLECTION).where('organizerUid', '==', organizerUid)
    const snap = await (eventSlug ? q.where('eventSlug', '==', eventSlug) : q).limit(cap + 1).get()
    if (snap.size > cap) return { records: [], count: null, complete: false }
    const records = snap.docs.map(d => d.data() as ManualRefundDocument).filter(m => m.status === 'completed').map((m): RegistrationRefundDocument => ({
      id: m.id, razorpayRefundId: '', gatewayPaymentId: m.paymentId, gatewayOrderId: m.orderId,
      registrationId: m.registrationId, eventSlug: m.eventSlug, organizerUid: m.organizerUid,
      amountPaise: m.amountPaise, status: 'processed', origin: 'manual', initiatedBy: m.completedBy ?? m.requestedBy,
      reason: m.reason, createdAt: m.completedAt ?? m.requestedAt, processedAt: m.completedAt,
      metadata: { method: m.method, reference: m.reference ?? null },
    }))
    return { records, count: records.length, complete: true }
  } catch { return { records: [], count: null, complete: false } }
}

/**
 * THE organizer-scoped refund read. Every finance surface and every report goes through this
 * one function, so a refund cannot be visible on the dashboard and missing from an export.
 *
 * Read-only: nothing here creates, updates or deletes a refund document.
 */
export async function listOrganizerRefunds(
  organizerUid: string,
  opts: { eventSlug?: string | null; cap?: number } = {},
): Promise<OrganizerRefundRead> {
  const eventSlug = opts.eventSlug ?? null
  const cap       = opts.cap ?? ORGANIZER_REFUND_READ_CAP

  const base = eventSlug
    ? refundsCol().where('organizerUid', '==', organizerUid).where('eventSlug', '==', eventSlug)
    : refundsCol().where('organizerUid', '==', organizerUid)

  const [owned, recovered, manual] = await Promise.all([
    (async (): Promise<{ records: RegistrationRefundDocument[]; count: number | null; complete: boolean }> => {
      let count: number
      try { count = (await base.count().get()).data().count } catch { return { records: [], count: null, complete: false } }
      if (count === 0) return { records: [], count: 0, complete: true }
      // Over the cap the COUNT is still exact — only the rows are withheld, and the caller is
      // told so rather than being handed a total silently computed from a partial set.
      if (count > cap) return { records: [], count, complete: false }
      try {
        return {
          records: (await base.limit(cap).get()).docs.map(d => d.data() as RegistrationRefundDocument),
          count, complete: true,
        }
      } catch { return { records: [], count, complete: false } }
    })(),
    recoverUnattributed(organizerUid, eventSlug),
    readCompletedManualRefunds(organizerUid, eventSlug, cap),
  ])

  // The pools are disjoint by construction (organizerUid equals a uid vs equals null), but the
  // ids are de-duplicated anyway rather than trusting that to stay true.
  const seen  = new Set(owned.records.map(r => r.razorpayRefundId || r.id))
  const extra = recovered.records.filter(r => !seen.has(r.razorpayRefundId || r.id))

  // W1 — a FAILED refund moved no money: it is never part of a refund total. (`ownedCount` stays the
  // raw count — it only decides whether the read was capped.)
  // F5 — `recovered` must count the recovered records that are RETURNED (callers slice by it).
  const ownedCounted = owned.records.filter(r => isCountedRefund(r.status))
  const extraCounted = extra.filter(r => isCountedRefund(r.status))
  // RD-REFUND-MANUAL-01 — manual refunds sit BEFORE the recovered slice (callers slice it from the end). They are
  // left out while the gateway rows are withheld (over the cap), so that state still reads as 'rows withheld'.
  return {
    records:    [...ownedCounted, ...(owned.complete ? manual.records : []), ...extraCounted],
    recovered:  extraCounted.length,
    ownedCount: owned.count === null ? null : owned.count + (manual.count ?? 0),
    complete:   owned.complete && recovered.complete && manual.complete,
  }
}

export type FinalizeRefundOutcome = 'won' | 'already_refunded' | 'not_pending' | 'mismatch' | 'refund_failed'

/**
 * RD-FIN-02 · refund_pending → refunded, ONLY with gateway evidence (refund id + the claimed payment +
 * the claimed amount). The ONE transition the Super Admin refund route and the refund.processed webhook
 * both contend on, so whichever arrives first finishes the refund and its side effects run exactly
 * once. It used to be the route's unconditional update: a route that died after the gateway refund
 * left the registration `refund_pending` forever (the webhook skips that state by design).
 *
 * F3 — the refund RECORD is read in the same transaction: a refund the gateway reported FAILED never
 * finishes the registration (`refund_failed`). With `claimRecord` (the webhook), the record's
 * side-effect claim (→ `processed`) commits atomically with the registration transition, so a
 * concurrent `refund.failed` can no longer land between "registration refunded" and "claim refused" —
 * it either commits first (and this returns `refund_failed`) or finds the refund processed (and is
 * flagged, never overwriting it).
 */
export async function finalizePendingRegistrationRefund(
  registrationId: string,
  refund: { refundId: string; amountPaise: number; gatewayPaymentId: string | null },
  opts: { claimRecord?: boolean } = {},
): Promise<FinalizeRefundOutcome> {
  const regRef = adminDb.collection('registrations').doc(registrationId)
  const recRef = refundsCol().doc(refund.refundId)
  const ptxRef = adminDb.collection('platformTransactions').doc(`ptx_${registrationId}`)
  return adminDb.runTransaction(async tx => {
    const [regSnap, recSnap, ptxSnap] = await Promise.all([tx.get(regRef), tx.get(recRef), tx.get(ptxRef)])
    const reg = regSnap.data() as Parameters<typeof pendingRefundMatches>[0] | undefined
    const rec = recSnap.exists ? recSnap.data() as RegistrationRefundDocument : null
    if (rec?.status === 'failed') return 'refund_failed'
    if (!reg) return 'not_pending'
    if (reg.paymentStatus === 'refunded') return 'already_refunded'
    if (reg.paymentStatus !== 'refund_pending') return 'not_pending'
    if (!pendingRefundMatches(reg, refund)) return 'mismatch'
    if (opts.claimRecord) {
      if (!rec || !canApplySideEffects(rec.status)) return 'mismatch'   // already processed / unrecorded
      tx.update(recRef, { status: 'processed', processedAt: FieldValue.serverTimestamp() })
    }
    tx.update(regRef, {
      paymentStatus: 'refunded', refundId: refund.refundId, refundAmount: refund.amountPaise,
      refundedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
    })
    // RD-REFUND-RECOVER-01 — atomic with "refunded": hold the unreleased settlement and queue the
    // reversal, so a route / webhook dying before its reversal call can neither lose the reversal
    // nor let the release job pay the organizer the refunded money meanwhile.
    stageReversalOwed(tx, registrationId, refund.refundId, ptxSnap, (regSnap.data() as { organizerUid?: unknown }).organizerUid)
    return 'won'
  })
}

// ─── W1 / F1–F3 · cumulative accounting, settlement holds, failures and review flags ──────────────

/**
 * F2 — the review fields for one reason, as a merge patch. `reviewRequired` keeps the FIRST reason
 * (never overwritten); every reason accumulates in `reviewReasons`; evidence is kept per reason.
 * Always written inside the transaction that records the state it explains, so a review can never be
 * lost between two writes.
 */
function reviewPatch(existing: { reviewRequired?: unknown } | null | undefined, reason: RefundReviewReason, detail: Record<string, unknown>) {
  return {
    ...(existing?.reviewRequired ? {} : { reviewRequired: reason }),
    reviewReasons:   FieldValue.arrayUnion(reason),
    reviewDetails:   { [reason]: detail },
    reviewFlaggedAt: FieldValue.serverTimestamp(),
    // M1 — open until an explicit, evidenced closure; a NEW reason after a closure reopens it.
    reviewOpen:      true,
  }
}

export type PaymentRefundAccumulation =
  | (RefundAccumulation & { fullBy: string | null; settlementHeld?: boolean; settlementAlreadyReleased?: boolean })
  | { kind: 'manual_conflict'; priorPaise: number; totalPaise: number; fullBy: string | null; settlementHeld?: boolean; settlementAlreadyReleased?: boolean }
  | { kind: 'refund_failed'; fullBy: null }
  | { kind: 'no_intent'; fullBy: null }

/**
 * Count ONE gateway refund against its payment's charged amount, exactly once — in a transaction on
 * `paymentIntents/{orderId}` (the trusted server record of the charge), so concurrent refunds of the
 * same payment serialize and exactly one of them can be the one that completes the full amount.
 *   gatewayRefundsPaise.{refundId} = amount   (never rewritten; a redelivery is `duplicate`)
 *   gatewayRefundFullBy            = refundId (the refund that brought the total to the charge)
 * A refund already recorded as FAILED is never counted.
 *
 * F2 — a refund that cannot be applied in full (partial, exceeding the charge, or after a full refund)
 * gets its review reason IN THIS transaction, with the counting itself.
 *
 * F1 — and, in the same transaction, the payment's settlement transaction (ptx_{registrationId}) is
 * HELD (releaseStatus 'held' + releaseHold.refundIds): the release job only takes 'pending', so the
 * funds of THIS payment stay unreleased until an authorized operator resolves the refund. Other
 * settlements are untouched. A transaction already reversed (refunded/disputed) is not held; one
 * already RELEASED cannot be held — that is recorded on the hold and in the review evidence.
 */
export async function accumulatePaymentRefund(orderId: string, refundId: string, amountPaise: number): Promise<PaymentRefundAccumulation> {
  const intentRef = adminDb.collection('paymentIntents').doc(orderId)
  const recordRef = refundsCol().doc(refundId)
  return adminDb.runTransaction(async tx => {
    const [intentSnap, recSnap] = await Promise.all([tx.get(intentRef), tx.get(recordRef)])
    if (!intentSnap.exists) return { kind: 'no_intent', fullBy: null } as const
    const rec = recSnap.exists ? recSnap.data() as RegistrationRefundDocument : null
    if (rec?.status === 'failed') return { kind: 'refund_failed', fullBy: null } as const
    const intent = intentSnap.data() as { amount?: unknown; registrationId?: unknown; gatewayRefundsPaise?: Record<string, unknown>; gatewayRefundFullBy?: unknown; manualRefundsPaise?: Record<string, unknown> }
    const charged = typeof intent.amount === 'number' && Number.isInteger(intent.amount) ? intent.amount : 0
    const fullBy = typeof intent.gatewayRefundFullBy === 'string' ? intent.gatewayRefundFullBy : null
    const acc = accumulateRefund(intent.gatewayRefundsPaise, refundId, amountPaise, charged)
    // RD-REFUND-MANUAL-01 — a MANUAL refund (pending or completed) is recorded on this intent: the attendee is being
    // / was repaid outside the gateway, so ANY new gateway refund of the payment is a possible double refund. It is
    // counted (money did leave), the settlement is held and the refund flagged — its side effects are never applied
    // (no full-refund reversal of a net the manual refund already reversed).
    const manualConflict = acc.kind !== 'duplicate' && !!intent.manualRefundsPaise && Object.keys(intent.manualRefundsPaise).length > 0
    if (!manualConflict && (acc.kind === 'duplicate' || acc.kind === 'full')) {
      if (acc.kind === 'full') {
        tx.set(intentRef, { gatewayRefundsPaise: { [refundId]: amountPaise }, gatewayRefundFullBy: refundId, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
        return { ...acc, fullBy: refundId }
      }
      return { ...acc, fullBy }
    }
    // partial | exceeds | already_full — recorded money out that is NOT applied as a full refund.
    const ptxRef = typeof intent.registrationId === 'string' && intent.registrationId
      ? adminDb.collection('platformTransactions').doc(`ptx_${intent.registrationId}`) : null
    const ptxSnap = ptxRef ? await tx.get(ptxRef) : null
    const ptx = ptxSnap?.exists ? ptxSnap.data() as { status?: unknown; releaseStatus?: unknown } : null
    const reversed = ptx?.status === 'refunded' || ptx?.status === 'disputed'
    const alreadyReleased = ptx?.releaseStatus === 'released'
    let settlementHeld = false
    if (ptxRef && ptx && !reversed) {
      tx.set(ptxRef, {
        releaseHold: {
          reason: 'refund_review', refundIds: FieldValue.arrayUnion(refundId),
          heldAt: FieldValue.serverTimestamp(), ...(alreadyReleased ? { alreadyReleased: true } : {}),
        },
        ...(ptx.releaseStatus === 'pending' || ptx.releaseStatus === undefined ? { releaseStatus: 'held' } : {}),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true })
      settlementHeld = !alreadyReleased
    }
    const counts = acc.kind === 'partial' || (manualConflict && acc.kind === 'full')
    if (counts) {
      tx.set(intentRef, { gatewayRefundsPaise: { [refundId]: amountPaise }, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
    }
    const reason: RefundReviewReason = manualConflict ? 'manual_refund_conflict'
      : acc.kind === 'partial' ? 'partial_refund' : acc.kind === 'exceeds' ? 'refund_exceeds_charge' : 'refund_after_full'
    tx.set(recordRef, reviewPatch(rec, reason, {
      priorPaise: acc.priorPaise, refundPaise: amountPaise, cumulativePaise: counts ? acc.totalPaise : acc.priorPaise,
      chargedPaise: charged, settlementHeld, settlementAlreadyReleased: alreadyReleased,
      ...(manualConflict ? { manualRefundIds: Object.keys(intent.manualRefundsPaise ?? {}) } : {}),
    }), { merge: true })
    if (manualConflict) return { kind: 'manual_conflict', priorPaise: acc.priorPaise, totalPaise: acc.totalPaise, fullBy, settlementHeld, settlementAlreadyReleased: alreadyReleased }
    return { ...acc, fullBy, settlementHeld, settlementAlreadyReleased: alreadyReleased }
  })
}

/** W1 / F2 — flag a recorded refund for a human (no side effect was applied because of it). Transactional:
 *  the first reason is kept, every reason accumulates. Idempotent (a redelivery re-asserts it). */
export async function flagRefundForReview(refundId: string, reason: RefundReviewReason, detail: Record<string, unknown> = {}): Promise<void> {
  const ref = refundsCol().doc(refundId)
  await adminDb.runTransaction(async tx => {
    const snap = await tx.get(ref)
    if (!snap.exists) return
    tx.set(ref, reviewPatch(snap.data() as RegistrationRefundDocument, reason, detail), { merge: true })
  })
}

export type RefundFailureOutcome = 'created' | 'marked_failed' | 'duplicate' | 'conflict_processed'

/**
 * W1 / F2 / F3 · refund.failed — record that the gateway refund FAILED (no money left), in ONE transaction
 * that also reads the payment intent and the registration (never a stale snapshot) and writes every
 * consequence with it:
 *   absent      → a `failed` record is created (the gateway fact, never counted as money out)
 *   processed   → NOT overwritten: flagged `failed_after_processed` for review
 *   failed      → duplicate delivery, nothing changes
 *   otherwise   → `failed`, with the failure time and reason, and:
 *       • counted toward the payment's refunds → UN-counted (and, if it was the refund that completed the
 *         charge, that marker is cleared), flagged `failed_after_counted` — a failed refund never stays
 *         counted as money refunded. A settlement hold it caused is KEPT (contradictory events need review);
 *       • the registration already refunded on it / ledger reversed → flagged `failed_after_side_effects`;
 *       • the registration refund_pending on its payment → flagged `failed_while_pending`.
 * Never touches a ledger or a wallet, never reverses or re-credits, and never initiates anything.
 */
export async function recordRefundFailure(input: RecordRefundInput & { failureReason: string | null }): Promise<{ outcome: RefundFailureOutcome; record: RegistrationRefundDocument; reasons: RefundReviewReason[] }> {
  const ref = refundsCol().doc(input.razorpayRefundId)
  const intentRef = input.gatewayOrderId ? adminDb.collection('paymentIntents').doc(input.gatewayOrderId) : null
  const regRef = input.registrationId ? adminDb.collection('registrations').doc(input.registrationId) : null
  return adminDb.runTransaction(async tx => {
    const [snap, intentSnap, regSnap] = await Promise.all([
      tx.get(ref), intentRef ? tx.get(intentRef) : Promise.resolve(null), regRef ? tx.get(regRef) : Promise.resolve(null),
    ])
    const reasons: RefundReviewReason[] = []
    if (snap.exists) {
      const record = snap.data() as RegistrationRefundDocument
      if (record.status === 'failed') return { outcome: 'duplicate' as const, record, reasons }
      if (record.status === 'processed') {
        tx.set(ref, reviewPatch(record, 'failed_after_processed', { failureReason: input.failureReason }), { merge: true })
        return { outcome: 'conflict_processed' as const, record, reasons: ['failed_after_processed'] as RefundReviewReason[] }
      }
    }
    const existing = snap.exists ? snap.data() as RegistrationRefundDocument : null
    // ── consequences, all decided from THIS transaction's reads ──
    const intent = intentSnap?.exists ? intentSnap.data() as { gatewayRefundsPaise?: Record<string, unknown>; gatewayRefundFullBy?: unknown } : null
    const counted = !!intent?.gatewayRefundsPaise && Object.prototype.hasOwnProperty.call(intent.gatewayRefundsPaise, input.razorpayRefundId)
    const reg = regSnap?.exists ? regSnap.data() as { paymentStatus?: string; refundId?: string; refundClaim?: { paymentId?: string } } : null
    const details: Record<string, Record<string, unknown>> = {}
    if (counted && intentRef) {
      tx.update(intentRef, {
        [`gatewayRefundsPaise.${input.razorpayRefundId}`]: FieldValue.delete(),
        ...(intent?.gatewayRefundFullBy === input.razorpayRefundId ? { gatewayRefundFullBy: FieldValue.delete() } : {}),
        updatedAt: FieldValue.serverTimestamp(),
      })
      reasons.push('failed_after_counted'); details.failed_after_counted = { uncountedPaise: input.amountPaise, wasFullBy: intent?.gatewayRefundFullBy === input.razorpayRefundId }
    }
    if (reg && ((reg.paymentStatus === 'refunded' && reg.refundId === input.razorpayRefundId) || existing?.ledgerReversed === true)) {
      reasons.push('failed_after_side_effects'); details.failed_after_side_effects = { paymentStatus: reg.paymentStatus ?? null, ledgerReversed: existing?.ledgerReversed === true }
    } else if (reg && reg.paymentStatus === 'refund_pending' && (reg.refundClaim?.paymentId ?? null) === input.gatewayPaymentId) {
      reasons.push('failed_while_pending'); details.failed_while_pending = { paymentStatus: 'refund_pending' }
    }
    const review = reasons.length ? {
      ...(existing?.reviewRequired ? {} : { reviewRequired: reasons[0] }),
      reviewReasons: FieldValue.arrayUnion(...reasons), reviewDetails: details, reviewFlaggedAt: FieldValue.serverTimestamp(), reviewOpen: true,
    } : {}
    if (!snap.exists) {
      const doc: RegistrationRefundDocument = {
        id: input.razorpayRefundId, razorpayRefundId: input.razorpayRefundId,
        gatewayPaymentId: input.gatewayPaymentId ?? null, gatewayOrderId: input.gatewayOrderId ?? null,
        registrationId: input.registrationId ?? null, eventSlug: input.eventSlug ?? null, organizerUid: input.organizerUid ?? null,
        amountPaise: input.amountPaise, status: 'failed', origin: input.origin, initiatedBy: input.initiatedBy, reason: input.reason,
        createdAt: FieldValue.serverTimestamp(), failedAt: FieldValue.serverTimestamp(), failureReason: input.failureReason,
        ...(input.metadata ? { metadata: input.metadata } : {}),
      }
      tx.set(ref, { ...doc, ...review })
      return { outcome: 'created' as const, record: doc, reasons }
    }
    tx.set(ref, { status: 'failed', failedAt: FieldValue.serverTimestamp(), failureReason: input.failureReason, ...review }, { merge: true })
    return { outcome: 'marked_failed' as const, record: existing!, reasons }
  })
}

// ─── M1 · closing a settlement hold once the payment is FULLY refunded and reversed ──────────────

/** Review reasons that a completed full refund explains (a partial that became part of the full refund). */
const CLOSABLE_REVIEW_REASONS: ReadonlySet<string> = new Set(['partial_refund'])

export type CloseHoldOutcome =
  | { closed: true; closedRefundIds: string[] }
  | { closed: false; why: 'no_hold' | 'not_reversed' | 'not_fully_refunded' | 'counted_mismatch' | 'contradictory_review' | 'refund_not_counted' | 'not_found' }

/**
 * M1 — the payment that a refund hold was protecting is now FULLY refunded (cumulative refunds equal the
 * charge, gatewayRefundFullBy set) and its settlement transaction has been REVERSED by the full-refund
 * path. The hold has nothing left to protect, so it is closed — in ONE transaction that re-reads the
 * ledger transaction, the intent and every refund record of the payment, and writes:
 *   • ptx: releaseHold removed, releaseStatus back from 'held' to 'pending' (the normal state of a
 *     reversed transaction — the release job only takes status 'completed', and refuses a non-completed
 *     one in its transaction too, so a reversed transaction is never released); the hold's evidence is
 *     kept in releaseHoldHistory together with the closure evidence;
 *   • each refund record of the payment with a review: reviewOpen false + reviewClosed {at, by, reason,
 *     closedReasons, evidence} (the reasons and their details are kept);
 *   • an audit row (actor: system), staged in the same transaction.
 * NOT closed — the hold and every review stay open — when the transaction is not reversed, the intent
 * does not show a full refund, the counted refunds do not equal the charge, a counted refund has no live
 * record, or any refund of the payment carries a reason the full refund does NOT explain (a failure, a
 * mismatch, an exceeding refund, a refund after full, a pending conflict…). Moves no money.
 */
export async function closeRefundHoldAfterFullRefund(args: { orderId: string; registrationId: string }): Promise<CloseHoldOutcome> {
  const ptxRef = adminDb.collection('platformTransactions').doc(`ptx_${args.registrationId}`)
  const intentRef = adminDb.collection('paymentIntents').doc(args.orderId)
  return adminDb.runTransaction<CloseHoldOutcome>(async tx => {
    const [ptxSnap, intentSnap] = await Promise.all([tx.get(ptxRef), tx.get(intentRef)])
    if (!ptxSnap.exists || !intentSnap.exists) return { closed: false, why: 'not_found' }
    const ptx = ptxSnap.data() as {
      status?: unknown; releaseStatus?: unknown; gatewayPaymentId?: unknown; organizerUid?: unknown; entityId?: unknown
      releaseHold?: { refundIds?: unknown; heldAt?: unknown; reason?: unknown; alreadyReleased?: unknown }
    }
    if (!ptx.releaseHold) return { closed: false, why: 'no_hold' }
    if (ptx.status !== 'refunded') return { closed: false, why: 'not_reversed' }
    const intent = intentSnap.data() as { amount?: unknown; gatewayRefundsPaise?: Record<string, unknown>; gatewayRefundFullBy?: unknown; paymentId?: unknown }
    const charged = typeof intent.amount === 'number' ? intent.amount : -1
    const counted = Object.entries(intent.gatewayRefundsPaise ?? {})
    const countedTotal = counted.reduce((s, [, v]) => s + (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : 0), 0)
    if (typeof intent.gatewayRefundFullBy !== 'string' || !intent.gatewayRefundFullBy) return { closed: false, why: 'not_fully_refunded' }
    if (countedTotal !== charged || charged <= 0) return { closed: false, why: 'counted_mismatch' }
    const paymentId = typeof ptx.gatewayPaymentId === 'string' ? ptx.gatewayPaymentId : (typeof intent.paymentId === 'string' ? intent.paymentId : null)
    if (!paymentId) return { closed: false, why: 'not_found' }
    const recs = (await tx.get(refundsCol().where('gatewayPaymentId', '==', paymentId).limit(50))).docs
    const byId = new Map(recs.map(d => [d.id, d.data() as RegistrationRefundDocument]))
    for (const [id] of counted) {
      const r = byId.get(id)
      if (!r || r.status === 'failed') return { closed: false, why: 'refund_not_counted' }
    }
    for (const r of byId.values()) {
      const reasons = Array.isArray(r.reviewReasons) ? r.reviewReasons : (r.reviewRequired ? [r.reviewRequired] : [])
      if (reasons.some(x => !CLOSABLE_REVIEW_REASONS.has(String(x)))) return { closed: false, why: 'contradictory_review' }
    }
    // ── writes (all or nothing, with the audit row) ──
    const now = FieldValue.serverTimestamp()
    const closeId = `full_refund_${String(intent.gatewayRefundFullBy)}`
    const hold = ptx.releaseHold
    const evidence = { gatewayRefundFullBy: intent.gatewayRefundFullBy, countedRefundsPaise: countedTotal, chargedPaise: charged, ledgerStatus: 'refunded' }
    tx.set(ptxRef, {
      releaseHold: FieldValue.delete(),
      ...(ptx.releaseStatus === 'held' ? { releaseStatus: 'pending' } : {}),
      releaseHoldHistory: { [closeId]: {
        hold: { reason: hold.reason ?? 'refund_review', refundIds: Array.isArray(hold.refundIds) ? hold.refundIds : [], heldAt: hold.heldAt ?? null, alreadyReleased: hold.alreadyReleased === true },
        outcome: 'closed_full_refund', by: 'system:full_refund', at: now, evidence,
      } },
      updatedAt: now,
    }, { merge: true })
    const closedRefundIds: string[] = []
    for (const [id, r] of byId) {
      if (!r.reviewOpen && !r.reviewRequired) continue
      closedRefundIds.push(id)
      tx.set(refundsCol().doc(id), {
        reviewOpen: false,
        reviewClosed: {
          at: now, by: 'system:full_refund', reason: 'payment fully refunded and settlement reversed',
          closedReasons: Array.isArray(r.reviewReasons) ? r.reviewReasons : [r.reviewRequired], evidence,
        },
      }, { merge: true })
    }
    stageAdminAudit(tx, {
      adminUid: 'system:razorpay_webhook', actorRole: 'system', action: 'settlement.refund_hold_closed',
      entityType: 'settlement', entityId: ptxRef.id, reason: 'payment fully refunded and settlement reversed',
      changedFields: ['releaseHold', 'releaseStatus', 'releaseHoldHistory'],
      before: { releaseStatus: ptx.releaseStatus ?? null, refundIds: hold.refundIds ?? [] },
      after: { releaseStatus: ptx.releaseStatus === 'held' ? 'pending' : (ptx.releaseStatus ?? null), ledgerStatus: 'refunded' },
      metadata: { outcome: 'closed_full_refund', closedRefundIds, ...evidence },
      correlation: {
        registrationId: args.registrationId, orderId: args.orderId, paymentId,
        organizerUid: typeof ptx.organizerUid === 'string' ? ptx.organizerUid : undefined,
        eventId: typeof ptx.entityId === 'string' ? ptx.entityId : undefined,
      },
    }, `settlement_hold_${ptxRef.id}_${closeId}`)
    return { closed: true, closedRefundIds }
  })
}
