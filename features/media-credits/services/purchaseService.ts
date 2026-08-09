// MC-04 · Purchase lifecycle — SERVER ONLY.
//
// Owns the purchase state machine and nothing else. Balance mutation stays with the ledger
// (`creditInTx`), pricing stays with `pricingService`, storage stays with `purchaseRepo`.
//
// ═══ THE STATE MACHINE ═══════════════════════════════════════════════════════
//
//        createPurchaseIntent          completePurchase
//   ∅ ─────────────────────► pending ──────────────────────► granted   (terminal)
//                               │
//                               ├── verification rejected ──► failed    (terminal)
//                               │
//                               └── paid, grant failed ─────► paid      (parked, owed)
//
// `granted` is terminal — no later transition leaves it, and no money field is ever rewritten.
//
// RD-MC-REFUND-V2-P1 narrowed that from "immutable" to "terminal", and the distinction is the
// point: a granted purchase is now also a credit LOT, so `creditsRemaining` and `lotSeq` do
// change as its credits are spent. What must never change is anything the payment established
// — `credits`, `amountPaise`, `status`, the gateway ids.
//
// ═══ WHY `paid` IS NOT `failed` ══════════════════════════════════════════════
// If Razorpay captured the money and the Firestore transaction then failed, calling that
// purchase "failed" would be a lie that loses a real debt. It parks at `paid` and a
// reconciliation record names what is owed. See reconciliation.ts.
//
// ═══ THE CLIENT COMPUTES NOTHING ═════════════════════════════════════════════
// The request carries a credit QUANTITY. Price, amount and every snapshot come from
// `getCreditPolicy()` on the server. A client that posts an amount is ignored, because there
// is no field to post it into.

import { adminDb } from '@/lib/firebase/admin'
import { razorpay, RAZORPAY_KEY_ID } from '@/lib/razorpay/client'
import { verifyRazorpaySignature } from '@/lib/razorpay/verifySignature'
import { captureFinancialError } from '@/lib/monitoring/sentry'
import { flagSuspiciousPayment } from '@/lib/payments/flagSuspicious'
import * as purchaseRepo from '@/features/media-credits/repositories/purchaseRepo'
import {
  creditInTx, getCreditPolicy, pricingService, walletService,
} from '@/features/media-credits/services'
import {
  CreditGrantDeferredError, CreditsDisabledError, InvalidCreditOperationError,
  PaymentVerificationError,
} from '@/features/media-credits/errors'
import { resolveMediaConfig } from '@/lib/config/resolveMediaConfig'
import { computeUsage } from '@/features/media-studio/repositories/settingsRepo'
import { resolveOwnedEvent } from '@/features/media-studio/services/authorize'
import {
  isWithinCapacity, purchaseCapacity, type PurchaseCapacity,
} from '@/features/media-credits/utils/creditPacks'
import type {
  CreditPurchaseDetailDto, CreditPurchaseDto, CreditPurchaseIntentDto,
} from '@/features/media-credits/types'

/**
 * Ceiling on one purchase. Not a business rule about spending — a bound on what a single
 * request may ask the arithmetic to do, so a caller cannot post 10^12 credits and overflow
 * the amount into a value Razorpay would reject in a confusing way.
 */
const MAX_CREDITS_PER_PURCHASE = 1_000_000

const toMs = (v: unknown): number =>
  v && typeof v === 'object' && 'toMillis' in v
    ? (v as { toMillis(): number }).toMillis()
    : 0

// ─── Reads ────────────────────────────────────────────────────────────────────

const toDto = (p: Awaited<ReturnType<typeof purchaseRepo.read>>): CreditPurchaseDto => ({
  purchaseId:  p!.purchaseId,
  credits:     p!.credits,
  amountPaise: p!.amountPaise,
  status:      p!.status,
  createdAtMs: toMs(p!.createdAt),
  grantedAtMs: p!.grantedAt ? toMs(p!.grantedAt) : null,
  // RD-MC-REFUND-V2-P2 · each purchase's OWN price, so a page of refund quotes prices every
  // row at what was actually paid for it.
  unitPricePaise: p!.unitPricePaise,
})

/**
 * One purchase, tenant-checked.
 *
 * Returns null — not "forbidden" — for another workspace's purchase, so the endpoint cannot
 * be used to discover whether a purchaseId exists.
 */
export async function getPurchase(
  organizerUid: string, purchaseId: string,
): Promise<CreditPurchaseDetailDto | null> {
  const p = await purchaseRepo.read(purchaseId)
  if (!p || p.organizerUid !== organizerUid) return null

  return {
    ...toDto(p),
    unitPricePaise:            p.unitPricePaise,
    creditsPerPhotoAtPurchase: p.creditsPerPhotoAtPurchase,
    currency:                  p.currency,
    tierAtPurchase:            p.tierAtPurchase,
    gatewayOrderId:            p.gatewayOrderId,
    gatewayPaymentId:          p.gatewayPaymentId,
    grantedAtMs:               p.grantedAt ? toMs(p.grantedAt) : null,
    failureReason:             p.failureReason,
  }
}

export async function listPurchases(
  organizerUid: string, limit: number, cursor?: string | null,
): Promise<{ purchases: CreditPurchaseDto[]; nextCursor: string | null }> {
  const capped = Math.min(Math.max(1, Math.trunc(limit)), 100)
  const rows   = await purchaseRepo.listByOrganizer(organizerUid, capped, cursor)
  return {
    purchases:  rows.map(toDto),
    nextCursor: rows.length === capped ? rows[rows.length - 1].purchaseId : null,
  }
}

// ─── createPurchaseIntent ─────────────────────────────────────────────────────

export interface CreateIntentInput {
  /**
   * RD-MC-CUSTOM-01 · The event the credits are for.
   *
   * Optional so every existing caller keeps working. When present, the purchase is
   * additionally bounded by that event`s remaining photo capacity.
   */
  eventId?:     string | null
  organizerUid: string
  /** How many CREDITS to buy. The only number the client supplies. */
  credits:      number
  actorUid:     string
}

/**
 * Prices the request, opens a Razorpay order and persists the intent.
 *
 * Order of operations is deliberate: the Razorpay order is created BEFORE the Firestore
 * record. If the gateway call fails we have written nothing, which is the clean outcome. The
 * reverse order would strand a `pending` purchase with no order behind it — a row that can
 * never be paid and never be cleaned up, indistinguishable from one the organizer abandoned.
 */
export async function createPurchaseIntent(
  input: CreateIntentInput,
): Promise<CreditPurchaseIntentDto> {
  const policy = await getCreditPolicy()
  if (!policy.creditsEnabled) throw new CreditsDisabledError()

  const credits = Math.trunc(input.credits)
  if (!Number.isFinite(credits) || credits <= 0) {
    throw new InvalidCreditOperationError('credits must be a positive integer')
  }
  if (credits < policy.minCreditPurchase) {
    throw new InvalidCreditOperationError(
      `the minimum purchase is ${policy.minCreditPurchase} credit(s)`,
    )
  }
  if (credits > MAX_CREDITS_PER_PURCHASE) {
    throw new InvalidCreditOperationError(
      `a single purchase is limited to ${MAX_CREDITS_PER_PURCHASE} credits`,
    )
  }

  // ── RD-MC-CUSTOM-01 · capacity, re-checked server-side ────────────────────
  // The client offers a range; this decides whether the number it sent is inside it. The
  // SAME pure `purchaseCapacity` runs in both places, so the offer and the guard cannot
  // drift — and a caller bypassing the UI entirely is refused here.
  //
  // Skipped only when no event is named. That keeps every existing caller working: the
  // per-purchase ceiling and the configured minimum above still apply, and an organizer
  // reaching this path without an event context is bounded by those.
  if (input.eventId) {
    const capacity = await capacityForEvent(input.organizerUid, input.eventId)
    if (capacity && !isWithinCapacity(credits, capacity)) {
      throw new InvalidCreditOperationError(
        capacity.canPurchase
          ? `you can buy between ${capacity.min} and ${capacity.max} credits for this event`
          : "this event has reached its plan capacity — upgrade the licence to buy more credits",
      )
    }
  }

  // THE price calculation. One call, one place. `quote` is the same pure function the
  // pricing preview uses, so a quoted amount and a charged amount cannot drift.
  const { amountPaise } = pricingService.quote(credits, policy.creditUnitPricePaise)
  if (amountPaise <= 0) {
    // A zero price with credits requested means the unit price is misconfigured. Creating a
    // ₹0 Razorpay order would "succeed" and grant free credits.
    throw new InvalidCreditOperationError('credit pricing is not configured')
  }

  const purchaseId = purchaseRepo.newPurchaseId()

  let order: { id: string; amount: number; currency: string }
  try {
    order = await razorpay.orders.create({
      amount:   amountPaise,
      currency: 'INR',
      receipt:  `mc_${purchaseId.slice(-12)}`.slice(0, 40),
      notes:    { purpose: 'media_credits', purchaseId, uid: input.organizerUid },
    }) as { id: string; amount: number; currency: string }
  } catch (err) {
    captureFinancialError(err, { scope: 'media_credits.order_create_failed', purchaseId })
    throw new Error('Payment service unavailable. Please try again.')
  }

  await purchaseRepo.createPending({
    purchaseId,
    organizerUid:   input.organizerUid,
    credits,
    amountPaise,
    // ── The pricing snapshot ──
    // Stored per purchase so a later config change cannot rewrite what this organizer was
    // sold. `unitPricePaise` freezes the cost of a credit; `creditsPerPhotoAtPurchase`
    // freezes its value in photos. They are independent keys and both can move.
    unitPricePaise:            policy.creditUnitPricePaise,
    creditsPerPhotoAtPurchase: policy.creditsPerPhoto,
    tierAtPurchase:            null,   // global-only pricing (MC-01 Decision 1)
    gatewayOrderId:            order.id,
  })

  return {
    purchaseId,
    gatewayOrderId: order.id,
    amountPaise,
    credits,
    currency: 'INR',
    keyId:    RAZORPAY_KEY_ID ?? '',
  }
}

// ─── completePurchase ─────────────────────────────────────────────────────────

export interface CompletePurchaseInput {
  organizerUid: string
  orderId:      string
  paymentId:    string
  signature:    string
  actorUid:     string
}

export interface CompletePurchaseResult {
  purchaseId: string
  credits:    number
  balance:    number
}

/**
 * Verifies a payment and grants the credits.
 *
 * ═══ FIVE INDEPENDENT CHECKS BEFORE ANY CREDIT MOVES ════════════════════════
 *   1. HMAC signature      — proves the payment belongs to the order.
 *   2. Purchase exists     — proves the order is one WE created.
 *   3. Tenant match        — proves it belongs to the caller's workspace.
 *   4. Payment re-fetch    — asks RAZORPAY what happened, not the client.
 *   5. Amount/currency/order/status match the stored intent.
 *
 * Check 1 alone is not enough, and this is the subtle part: the signature proves the
 * order↔payment pairing but says nothing about the AMOUNT. Without check 5, a caller could
 * pay ₹1 against an order for ₹10,000 and present a perfectly valid signature.
 *
 * The client's own "payment succeeded" callback is never trusted at any step.
 */
export async function completePurchase(
  input: CompletePurchaseInput,
): Promise<CompletePurchaseResult> {
  const policy = await getCreditPolicy()
  if (!policy.creditsEnabled) throw new CreditsDisabledError()

  // ── 1. Signature ──────────────────────────────────────────────────────────
  if (!verifyRazorpaySignature({
    orderId: input.orderId, paymentId: input.paymentId, signature: input.signature,
  })) {
    throw new PaymentVerificationError('signature_mismatch')
  }

  // ── 2/3. The purchase, and whose it is ────────────────────────────────────
  const purchase = await purchaseRepo.findByOrderId(input.orderId)
  if (!purchase) throw new PaymentVerificationError('unknown_order')
  if (purchase.organizerUid !== input.organizerUid) {
    throw new PaymentVerificationError('tenant_mismatch')
  }

  // Fast-path replay. The transaction below is idempotent on its own, but a re-delivered
  // callback should not cost a Razorpay round trip.
  if (purchase.status === 'granted') {
    const { balance } = await walletService.getBalance(input.organizerUid)
    return { purchaseId: purchase.purchaseId, credits: purchase.credits, balance }
  }
  if (purchase.status === 'failed') {
    throw new PaymentVerificationError('purchase_already_failed')
  }

  // ── 4. Ask Razorpay ───────────────────────────────────────────────────────
  let payment: { amount?: number; currency?: string; status?: string; order_id?: string }
  try {
    payment = await razorpay.payments.fetch(input.paymentId) as typeof payment
  } catch (err) {
    // NOT a verification failure — we could not reach the authority. Surfacing this as
    // "verification failed" would mark a possibly-good payment bad on a transient outage.
    captureFinancialError(err, {
      scope: 'media_credits.payment_fetch_failed', paymentId: input.paymentId,
    })
    throw new Error('Could not verify payment. Please try again.')
  }

  // ── 5. Does what Razorpay says match what we sold? ────────────────────────
  const captured = payment.status === 'captured' || payment.status === 'authorized'
  if (
    !captured ||
    payment.currency !== purchase.currency ||
    payment.amount   !== purchase.amountPaise ||
    payment.order_id !== input.orderId
  ) {
    await flagSuspiciousPayment({
      source: 'media_credits', reason: 'amount_or_order_mismatch',
      paymentId: input.paymentId, orderId: input.orderId, entityId: input.organizerUid,
      expectedAmountPaise: purchase.amountPaise, actualAmountPaise: payment.amount,
      expectedCurrency: purchase.currency,       actualCurrency: payment.currency,
      expectedOrderId: input.orderId,            actualOrderId: payment.order_id,
    })
    await purchaseRepo.markOutcome(purchase.purchaseId, 'failed', {
      gatewayPaymentId: input.paymentId,
      failureReason:    'Payment did not match the purchase.',
    })
    throw new PaymentVerificationError('amount_or_order_mismatch')
  }

  // ── THE transaction ───────────────────────────────────────────────────────
  // Purchase record, ledger entry and wallet balance commit together or not at all.
  // `creditInTx` runs first because it READS (ledger + wallet) and Firestore forbids a read
  // after a write; `markGrantedInTx` is a pure write, so it must follow.
  //
  // Idempotent by the deterministic entryId: a concurrent duplicate verification either
  // no-ops on the existence check or loses the `tx.create` race and retries into the no-op.
  try {
    await adminDb.runTransaction(async tx => {
      await creditInTx(tx, {
        organizerUid: input.organizerUid,
        entryId:      `purchase:${purchase.purchaseId}`,
        credits:      purchase.credits,
        reason:       'purchase',
        actorUid:     input.actorUid,
        actorKind:    'organizer',
        purchaseId:   purchase.purchaseId,
      })
      purchaseRepo.markGrantedInTx(tx, purchase.purchaseId, input.paymentId, purchase.credits)
    })
  } catch (err) {
    // The money is captured. Park the purchase at `paid`, record the debt, and tell the
    // caller it is pending — never an error that would invite paying again.
    const cause = err instanceof Error ? err.message : 'grant_failed'
    captureFinancialError(err, {
      scope: 'media_credits.grant_failed', purchaseId: purchase.purchaseId,
    })
    await purchaseRepo.recordReconciliation({
      gatewayOrderId:   input.orderId,
      organizerUid:     input.organizerUid,
      purchaseId:       purchase.purchaseId,
      gatewayPaymentId: input.paymentId,
      credits:          purchase.credits,
      amountPaise:      purchase.amountPaise,
      lastError:        cause,
    }).catch(recErr => {
      // Both writes failing is the worst case; make sure it is loud rather than swallowed.
      captureFinancialError(recErr, {
        scope: 'media_credits.reconciliation_write_failed', purchaseId: purchase.purchaseId,
      })
    })
    await purchaseRepo.markOutcome(purchase.purchaseId, 'paid', {
      gatewayPaymentId: input.paymentId,
    }).catch(() => { /* already recorded above; the reconciliation record is the truth */ })

    throw new CreditGrantDeferredError(purchase.purchaseId, cause)
  }

  const { balance } = await walletService.getBalance(input.organizerUid)
  return { purchaseId: purchase.purchaseId, credits: purchase.credits, balance }
}

/** The MC-01 interface, now implemented. Named per the MC-04 brief. */
export const purchaseService = {
  createPurchaseIntent,
  completePurchase,
  getPurchase,
  listPurchases,
}

// ─── RD-MC-CUSTOM-01 · capacity for one event ─────────────────────────────────

/**
 * The purchase capacity for one event, or null when it cannot be established.
 *
 * Null — not zero — when the event cannot be resolved: refusing every purchase because a
 * lookup failed would be worse than falling back to the ceilings `createPurchaseIntent`
 * already applies. The event is ownership-checked, so another workspace's event resolves to
 * null and its capacity is never revealed.
 *
 * The composition is identical to `GET /media-credits/capacity`. Both call the same pure
 * `purchaseCapacity`; only the I/O around it lives here.
 */
async function capacityForEvent(
  organizerUid: string, eventId: string,
): Promise<PurchaseCapacity | null> {
  try {
    const event = await resolveOwnedEvent(organizerUid, eventId)
    if (!event.ok) return null

    const [limits, usage, balance] = await Promise.all([
      resolveMediaConfig({ organizerUid, eventId, eventSlug: event.event.eventSlug }),
      computeUsage(organizerUid, eventId),
      walletService.getBalance(organizerUid),
    ])

    return purchaseCapacity({
      maxPhotosPerEvent: limits.maxPhotosPerEvent,
      uploadedPhotos:    usage.photoCount,
      walletAvailable:   balance.available,
    })
  } catch {
    // A capacity that cannot be read must not block a purchase the other guards allow.
    return null
  }
}
