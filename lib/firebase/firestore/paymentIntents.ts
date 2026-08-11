// Server-only: Firebase Admin SDK.
// Stores payment intents for paid registrations.
// Written before Razorpay checkout opens; updated atomically with registration creation.

import { FieldValue } from 'firebase-admin/firestore'
import { adminDb }    from '@/lib/firebase/admin'
import type { FeeBreakdownRecord } from '@/lib/fees/types'

export type PaymentIntentStatus = 'created' | 'paid' | 'failed' | 'registration_failed'
export type RefundStatus        = 'pending' | 'processed' | 'failed'

export interface PaymentIntentRecord {
  orderId:      string           // Razorpay order ID
  eventSlug:    string
  passId:       string
  passName:     string
  passCapacity: number | null    // null = unlimited — used in verify-payment capacity check
  eventName:    string
  organizerUid: string
  amount:       number           // paise — authoritative server amount, never from client
  currency:     'INR'
  attendee: {
    name:           string
    email:          string
    phone?:         string
    formResponses?: Record<string, unknown>
  }
  uid?:           string         // Firebase Auth uid if signed in
  status:         PaymentIntentStatus
  registrationId?: string        // set atomically when registration is created
  paymentId?:      string        // Razorpay payment ID, set after verification
  // M2: refund tracking — populated when automatic refund is triggered
  refundId?:       string        // Razorpay refund ID
  refundStatus?:   RefundStatus
  refundAmount?:   number        // paise — should equal amount for full refunds
  failureReason?:  string        // why registration creation failed
  // Invite code — stored by create-order after server-side validation so that
  // verify-payment can re-validate against the live event state (P0-1 defence-in-depth).
  // Undefined for events that do not require an invite code.
  inviteCode?:     string
  // RD-PAY-P0-2 — the client's per-attempt idempotency key. Written so an intent can be
  // matched back to the attempt that created it. Absent on every intent written before
  // this feature, and absent whenever the client sends no (or a malformed) key.
  idempotencyKey?: string
  // Coupon fields — populated when a promo code was applied at order creation
  couponCode?:     string        // normalized uppercase code
  couponDocId?:    string        // Firestore doc ID in events/{slug}/coupons/{id}
  discountAmount?: number        // paise discount; amount already reflects the discount
  originalAmount?: number        // paise before discount
  // RD-PAYMENT-02 Phase 1 — canonical fee breakdown for this order (incl. the ticket
  // base, the attendee charge, and who bore each fee). ADDITIVE + OPTIONAL: absent on
  // every prior intent; `amount` above remains the authoritative charged value and is
  // untouched. Written from Phase 2 onward; nothing populates it yet.
  financials?:     FeeBreakdownRecord
  createdAt:       unknown       // Firestore Timestamp
  updatedAt:       unknown       // Firestore Timestamp
}

// ─── Document construction ────────────────────────────────────────────────────

/**
 * RD-PAY-P0-1 — build the persisted `paymentIntents/{orderId}` document, with every
 * `undefined`-valued key OMITTED.
 *
 * WHY THIS EXISTS. The Admin SDK rejects a document that carries an explicit `undefined`
 * ("Cannot use 'undefined' as a Firestore value"), and it rejects the WHOLE write, not the
 * offending field. Guest checkout has no `uid` and an attendee may give no `phone`, so the
 * intent write threw and create-order answered "Failed to persist payment record. Please
 * try again." — for every signed-out attendee, deterministically. No payment had been taken
 * at that point (this write happens before Razorpay Checkout opens), so the attendee was not
 * charged; they simply could not pay at all.
 *
 * WHY NOT `ignoreUndefinedProperties`. That is a global Firestore setting. It would silently
 * drop a mistyped key on EVERY write in the codebase, turning a loud, local failure into
 * quiet data loss everywhere — see the note in lib/marketing/enquiry.ts. This is scoped to
 * the one document that has the optional-field problem.
 *
 * OMIT vs. SUBSTITUTE. Absent and `undefined` read back identically (`data().uid === undefined`),
 * so every existing consumer — verify-payment, the webhook, the refund route, the receipt
 * route — is unaffected: they already handle intents with no uid, no phone and no coupon.
 * Nothing is invented to fill the gap; a guest gets NO `uid` field, never a fabricated one.
 *
 * REQUIRED fields are deliberately NOT protected. `orderId`, `eventSlug`, `passId`,
 * `organizerUid`, `amount` and `attendee.name`/`email` must exist for the intent to be
 * usable; silently omitting one would write a record that verify-payment cannot settle and
 * that credits nobody. If one of those is ever `undefined` the write SHOULD fail loudly —
 * which, unchanged, it still does.
 *
 * Pure and exported so the shape can be asserted directly in tests.
 */
export function buildPaymentIntentDocument(
  data: Omit<PaymentIntentRecord, 'status' | 'createdAt' | 'updatedAt'>,
): Record<string, unknown> {
  return { ...omitUndefined(data as unknown as Record<string, unknown>), status: 'created' }
}

/**
 * Recursively drop `undefined`-valued keys from plain objects.
 *
 * Only PLAIN objects are descended into (`attendee`, `attendee.formResponses`, `financials`)
 * — anything with a different prototype (a Date, a Timestamp, a FieldValue sentinel, an
 * array) is passed through untouched, so this can never mangle a Firestore value type.
 * `null` is preserved: it is a legitimate stored value here (`passCapacity: null` means
 * "unlimited") and is NOT what Firestore rejects.
 */
function omitUndefined(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, v] of Object.entries(value)) {
    if (v === undefined) continue
    out[key] = isPlainObject(v) ? omitUndefined(v) : v
  }
  return out
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  const proto = Object.getPrototypeOf(v) as unknown
  return proto === Object.prototype || proto === null
}

export async function createPaymentIntent(
  data: Omit<PaymentIntentRecord, 'status' | 'createdAt' | 'updatedAt'>,
): Promise<void> {
  await adminDb.collection('paymentIntents').doc(data.orderId).set({
    ...buildPaymentIntentDocument(data),
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  })
}

export async function getPaymentIntent(orderId: string): Promise<PaymentIntentRecord | null> {
  const snap = await adminDb.collection('paymentIntents').doc(orderId).get()
  if (!snap.exists) return null
  return snap.data() as PaymentIntentRecord
}

// ─── RD-PAY-P0-2 · attempt claims ─────────────────────────────────────────────
//
// `paymentIntentClaims/{eventSlug}__{idempotencyKey}` → the order minted for that attempt.
//
// A CLAIM DOC, not a query. `paymentIntents` is keyed by the Razorpay order id — the id
// verify-payment, the webhook, the refund route and the receipt route all resolve against —
// so that key cannot change. Looking the attempt up needs a second address, and a claim doc
// gives it as a single `get()` with no composite index, matching how `registrationClaims`
// and `ticketCodeClaims` already work in this codebase.

const claims = () => adminDb.collection('paymentIntentClaims')

export interface PaymentAttemptClaim {
  orderId:   string
  eventSlug: string
  createdAt: unknown
}

/** The order previously minted for this attempt, or null if this attempt is new. */
export async function getAttemptClaim(claimId: string): Promise<PaymentAttemptClaim | null> {
  const snap = await claims().doc(claimId).get()
  return snap.exists ? (snap.data() as PaymentAttemptClaim) : null
}

/**
 * Point the attempt at an order. `create()` (not `set()`) on the FIRST write so two
 * concurrent identical requests cannot both believe they own the attempt: the loser gets
 * ALREADY_EXISTS and re-reads the winner's claim instead of handing out its own order.
 *
 * Returns the claim that is now authoritative — the caller's own on success, the winner's
 * on collision. A superseding write (the old order expired or drifted) passes
 * `replace: true`, which is a plain `set()` because the caller has already confirmed with
 * Razorpay that nothing was captured against the order being replaced.
 */
export async function claimPaymentAttempt(
  claimId:   string,
  data:      { orderId: string; eventSlug: string },
  opts:      { replace?: boolean } = {},
): Promise<PaymentAttemptClaim> {
  const ref  = claims().doc(claimId)
  const body = { ...data, createdAt: FieldValue.serverTimestamp() }

  if (opts.replace) {
    await ref.set(body)
    return body as PaymentAttemptClaim
  }

  try {
    await ref.create(body)
    return body as PaymentAttemptClaim
  } catch {
    // ALREADY_EXISTS — a concurrent request won. Defer to it. Our own Razorpay order is
    // left unpaid and expires; an orphaned unpaid order is strictly better than handing
    // this attendee a second payable order.
    const winner = await getAttemptClaim(claimId)
    return winner ?? (body as PaymentAttemptClaim)
  }
}

export async function markPaymentIntentFailed(
  orderId:       string,
  failureReason?: string,
): Promise<void> {
  await adminDb.collection('paymentIntents').doc(orderId).update({
    status: 'registration_failed',
    ...(failureReason ? { failureReason } : {}),
    updatedAt: FieldValue.serverTimestamp(),
  })
}

// M2: Called after a successful Razorpay refund API call.
export async function updatePaymentIntentRefund(
  orderId:      string,
  refundId:     string,
  refundStatus: RefundStatus,
  refundAmount: number,
): Promise<void> {
  await adminDb.collection('paymentIntents').doc(orderId).update({
    refundId,
    refundStatus,
    refundAmount,
    updatedAt: FieldValue.serverTimestamp(),
  })
}
