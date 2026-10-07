// RD-FIN-01 · Firestore I/O for registration refunds. Decisions live in `refundPolicy.ts`.

import { FieldValue } from 'firebase-admin/firestore'
import { adminDb }    from '@/lib/firebase/admin'
import { pendingRefundMatches } from '@/lib/refunds/refundPolicy'
import {
  initialStatusFor,
  validateRefundInput,
  buildLinkagePatch,
  canApplySideEffects,
} from './refundPolicy'
import type {
  RegistrationRefundDocument,
  RecordRefundInput,
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
): Promise<{ claimed: boolean; record: RegistrationRefundDocument | null }> {
  const ref = refundsCol().doc(razorpayRefundId)
  return adminDb.runTransaction(async tx => {
    const snap = await tx.get(ref)
    if (!snap.exists) return { claimed: false, record: null }
    const record = snap.data() as RegistrationRefundDocument
    if (!canApplySideEffects(record.status)) return { claimed: false, record }
    tx.update(ref, { status: 'processed', processedAt: FieldValue.serverTimestamp() })
    return { claimed: true, record }
  })
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

  const [owned, recovered] = await Promise.all([
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
  ])

  // The pools are disjoint by construction (organizerUid equals a uid vs equals null), but the
  // ids are de-duplicated anyway rather than trusting that to stay true.
  const seen  = new Set(owned.records.map(r => r.razorpayRefundId || r.id))
  const extra = recovered.records.filter(r => !seen.has(r.razorpayRefundId || r.id))

  return {
    records:    [...owned.records, ...extra],
    recovered:  extra.length,
    ownedCount: owned.count,
    complete:   owned.complete && recovered.complete,
  }
}

export type FinalizeRefundOutcome = 'won' | 'already_refunded' | 'not_pending' | 'mismatch'

/**
 * RD-FIN-02 · refund_pending → refunded, ONLY with gateway evidence (refund id + the claimed payment +
 * the claimed amount). The ONE transition the Super Admin refund route and the refund.processed webhook
 * both contend on, so whichever arrives first finishes the refund and its side effects run exactly
 * once. It used to be the route's unconditional update: a route that died after the gateway refund
 * left the registration `refund_pending` forever (the webhook skips that state by design).
 */
export async function finalizePendingRegistrationRefund(
  registrationId: string,
  refund: { refundId: string; amountPaise: number; gatewayPaymentId: string | null },
): Promise<FinalizeRefundOutcome> {
  const regRef = adminDb.collection('registrations').doc(registrationId)
  return adminDb.runTransaction(async tx => {
    const reg = (await tx.get(regRef)).data() as Parameters<typeof pendingRefundMatches>[0] | undefined
    if (!reg) return 'not_pending'
    if (reg.paymentStatus === 'refunded') return 'already_refunded'
    if (reg.paymentStatus !== 'refund_pending') return 'not_pending'
    if (!pendingRefundMatches(reg, refund)) return 'mismatch'
    tx.update(regRef, {
      paymentStatus: 'refunded', refundId: refund.refundId, refundAmount: refund.amountPaise,
      refundedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
    })
    return 'won'
  })
}
