// POST /api/licensing/capacity/confirm — RD-CAPACITY-01
//
// Finalise a paid capacity change. Verifies the Razorpay payment against the order the
// server itself created, then applies the change through the ONE transaction that moves the
// capacity and appends the audit entry together. No wallet is ever debited (RD-LICENSE-PAYMENT-01).
//
// ═══ EVERY GUARD THIS SHARES WITH THE LICENCE CONFIRM PATH ═══════════════════
//   • the expected amount comes from the PERSISTED order, never the request
//   • the payment must be bound to that order id
//   • the HMAC signature is verified with the same shared verifier
//   • the captured payment is re-fetched and its amount/currency/order re-asserted
//   • a mismatch is flagged as suspicious and refused, never activated
//   • a replay is idempotent — the apply transaction short-circuits on `paid`
//
// ═══ THE ONE GUARD THAT IS NEW ═══════════════════════════════════════════════
// A capacity change is priced as a DELTA, so it is only valid against the capacity it was
// quoted from. If the event's capacity moved in between, the apply transaction returns
// `stale` and the captured payment is refunded. Applying it anyway would either hand over
// capacity nobody paid for or silently discard capacity somebody did.

import { NextRequest, NextResponse } from 'next/server'
import { scheduleServicePurchaseNotification } from '@/lib/notifications/servicePurchase'
import { authorizeWorkspace }      from '@/lib/team/workspace'
import { adminDb }                 from '@/lib/firebase/admin'
import { razorpay }                from '@/lib/razorpay/client'
import { flagSuspiciousPayment }   from '@/lib/payments/flagSuspicious'
import { RazorpayDonationGateway } from '@/lib/razorpay/donationGateway'
import { LICENSE_ORDERS_COLLECTION, licenseOrderConverter, isCapacityChangePurpose } from '@/lib/licensing/schema'
import { applyCapacityChange, holdStaleCapacityRemainder, resolveCapacityEventSlug } from '@/lib/licensing/capacityChange'
import { sumServiceItems, isConsistentServiceItem } from '@/lib/licensing/serviceAllowances'
import { holdSupersededPayment, isSupersededUnheld } from '@/lib/licensing/manualRefundHold'

export const dynamic = 'force-dynamic'

const verifier = new RazorpayDonationGateway()

export async function POST(req: NextRequest): Promise<NextResponse> {
  const authz = await authorizeWorkspace(req, 'events')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  const uid = authz.workspaceUid

  let body: {
    eventId?: unknown; orderId?: unknown
    razorpay_order_id?: unknown; razorpay_payment_id?: unknown; razorpay_signature?: unknown
  }
  try { body = await req.json() as typeof body }
  catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }

  const requestedId = typeof body.eventId === 'string' ? body.eventId.trim() : ''
  const orderId = typeof body.orderId === 'string' ? body.orderId.trim() : ''
  if (!requestedId || !orderId) return NextResponse.json({ error: 'eventId and orderId are required' }, { status: 400 })

  // RD-EVENT-COMMERCE-01 · D1 — resolve the dashboard's DRAFT id to the slug the order carries.
  const resolved = await resolveCapacityEventSlug(requestedId, uid)
  if (!resolved.ok) return NextResponse.json({ error: resolved.message, code: resolved.code }, { status: 404 })
  const eventId = resolved.slug

  // ── The order is the authority on what is owed ───────────────────────────────
  const snap = await adminDb.collection(LICENSE_ORDERS_COLLECTION).doc(orderId)
    .withConverter(licenseOrderConverter).get()
  if (!snap.exists) return NextResponse.json({ error: 'Order not found.' }, { status: 404 })
  const order = snap.data()!

  // Ownership and identity: the order must belong to this workspace AND to this event, and
  // it must actually be a capacity change. Without the purpose check, this route would be a
  // second door onto the licence ACTIVATION order, which has its own settlement path.
  if (order.organizerUid !== uid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  if (order.eventId !== eventId)  return NextResponse.json({ error: 'Order does not belong to this event.' }, { status: 400 })
  if (!isCapacityChangePurpose(order.purpose) || order.commercialModel !== 'capacity' || !order.capacityChange) {
    return NextResponse.json({ error: 'This order is not a capacity change.' }, { status: 400 })
  }

  const charge = order.capacityChange
  // The stored snapshot must still add up. It was written by this server, but a stored
  // value is still a value, and one that does not reconcile must not settle a payment.
  const consistent =
    charge.basePaise + charge.gstPaise === charge.totalPaise &&
    charge.chargeableCapacity * charge.activationRatePaise ===
      (charge.operation === 'decrease' ? (charge.removedCapacityValuePaise ?? -1) : charge.basePaise)
  // RD-EVENT-COMMERCE-03 — any prepaid service lines on the order must reconcile too.
  const serviceItems = order.serviceItems ?? []
  if (!consistent || !serviceItems.every(isConsistentServiceItem)) {
    console.error(`[capacity] snapshot inconsistent — refusing to settle · orderId=${orderId}`, charge)
    return NextResponse.json({ error: 'This order could not be verified. Please start again.' }, { status: 409 })
  }

  const razorpayAmountPaise = Math.max(0, order.razorpayAmountPaise ?? 0)
  const expectedOrderId = order.razorpayOrderId ?? null
  const rzpOrderId = typeof body.razorpay_order_id   === 'string' ? body.razorpay_order_id   : null
  const paymentId  = typeof body.razorpay_payment_id === 'string' ? body.razorpay_payment_id : null
  const signature  = typeof body.razorpay_signature  === 'string' ? body.razorpay_signature  : null

  // RD-LICENSE-PAYMENT-01 · Razorpay must have been asked for the WHOLE total. An order that
  // planned a communication-wallet share (created before this change) is refused here, before
  // any settlement — and a payable order can therefore never skip payment verification.
  // The whole order: the capacity change plus any service lines bought with it.
  const orderTotal = charge.totalPaise + sumServiceItems(serviceItems)
  if (razorpayAmountPaise !== orderTotal) {
    console.warn(`[capacity] confirm refused — order does not cover its full total · orderId=${orderId} razorpay=${razorpayAmountPaise} total=${orderTotal}`)
    return NextResponse.json({ error: 'This checkout is out of date. Please start the change again.' }, { status: 409, headers: { 'Cache-Control': 'no-store' } })
  }

  // ── Payment verification — mandatory: every payable capacity order is Razorpay ─
  if (razorpayAmountPaise > 0) {
    if (!rzpOrderId || !paymentId || !signature) {
      return NextResponse.json({ error: 'Payment details are required' }, { status: 400 })
    }
    if (!expectedOrderId || rzpOrderId !== expectedOrderId) {
      console.warn(`[capacity] order mismatch · orderId=${orderId} expected=${expectedOrderId ?? 'none'} got=${rzpOrderId}`)
      return NextResponse.json({ error: 'Payment order mismatch. Please restart checkout.' }, { status: 400 })
    }
    if (!verifier.verifySignature({ orderId: rzpOrderId, paymentId, signature })) {
      console.warn(`[capacity] signature verification FAILED · orderId=${orderId}`)
      return NextResponse.json({ error: 'Invalid payment signature' }, { status: 400 })
    }
    let payment: { amount?: number; currency?: string; status?: string; order_id?: string }
    try {
      payment = await razorpay.payments.fetch(paymentId) as typeof payment
    } catch (err) {
      console.error('[capacity] payment fetch failed', err)
      return NextResponse.json({ error: 'Could not verify payment. Please try again.' }, { status: 502 })
    }
    // RD-F1 — capacity is granted ONLY for a CAPTURED payment. Nothing in RegisterDesk captures
    // payments itself (the account auto-captures; the webhook settles on payment.captured), so an
    // `authorized` payment is not money yet: nothing is applied and the webhook applies it on capture.
    const matches = payment.currency === 'INR' && payment.amount === razorpayAmountPaise && payment.order_id === expectedOrderId
    if (payment.status === 'authorized' && matches) {
      console.info(`[capacity] payment authorized, not captured yet · orderId=${orderId} paymentId=${paymentId}`)
      return NextResponse.json({ error: 'Your payment is authorised but not yet captured by Razorpay, so nothing has been applied yet. It is applied automatically once the payment is captured — please do not pay again.', code: 'PAYMENT_NOT_CAPTURED' }, { status: 409, headers: { 'Cache-Control': 'no-store' } })
    }
    if (payment.status !== 'captured' || !matches) {
      await flagSuspiciousPayment({
        source: 'license', reason: 'amount_or_order_mismatch',
        paymentId, orderId: rzpOrderId, entityId: eventId,
        expectedAmountPaise: razorpayAmountPaise, actualAmountPaise: payment.amount,
        expectedCurrency: 'INR', actualCurrency: payment.currency,
        expectedOrderId, actualOrderId: payment.order_id,
      })
      console.warn(`[capacity] payment amount/order mismatch · orderId=${orderId}`)
      return NextResponse.json({ error: 'Payment verification failed.' }, { status: 400 })
    }
    console.info(`[capacity] payment verified · orderId=${orderId} paymentId=${paymentId} amount=${razorpayAmountPaise}`)
  }

  // ── Apply, atomically ───────────────────────────────────────────────────────
  const applied = await applyCapacityChange({
    eventId, organizerUid: uid, orderId,
    razorpayOrderId: rzpOrderId, razorpayPaymentId: paymentId,
  })

  if (applied.kind === 'stale') {
    // Priced against a capacity that has since moved. The organizer paid for a delta that
    // no longer exists, so the change is refused and the captured payment is HELD for a manual
    // refund decision (RD-EVENT-COMMERCE-04B — never refunded automatically).
    console.warn(`[capacity] STALE — capacity moved under a paid order · orderId=${orderId} expectedPrevious=${charge.previousCapacity}`)
    await holdStaleCapacityRemainder({
      orderId, eventId, paymentId, remainderPaise: razorpayAmountPaise,
      priorRefundId: (order as { staleRefundId?: string }).staleRefundId ?? null,
    })
    return NextResponse.json({
      error: 'This event’s capacity changed before the payment completed, so the change was not applied. If you were charged, the payment is on hold for review by the RegisterDesk team — nothing further will be charged.',
      code: 'STALE_CAPACITY',
    }, { status: 409, headers: { 'Cache-Control': 'no-store' } })
  }

  if (applied.kind === 'lifecycle_ineligible') {
    // RD-L6 D3 — the event is no longer live (cancelled / archived / completed …). Nothing was applied;
    // the order is terminal (marked in the apply transaction) and the verified captured payment is
    // HELD for a manual refund decision — the same deterministic hold as a stale order. Never refunded.
    console.warn(`[capacity] event no longer live — change refused, payment HELD · orderId=${orderId}`)
    await holdStaleCapacityRemainder({
      orderId, eventId, paymentId, remainderPaise: razorpayAmountPaise, reason: 'lifecycle_ineligible',
      priorRefundId: (order as { staleRefundId?: string }).staleRefundId ?? null,
    })
    return NextResponse.json({
      error: 'This event is no longer live, so the capacity change was not applied. If you were charged, the payment is on hold for review by the RegisterDesk team — nothing further will be charged.',
      code: 'EVENT_NOT_LIVE',
    }, { status: 409, headers: { 'Cache-Control': 'no-store' } })
  }

  if (applied.kind === 'ineligible') {
    // RD-F2 — a SUPERSEDED order whose payment was just verified as CAPTURED and matching (above):
    // nothing is applied (F1), but the money is recorded as a manual-refund hold so it is never lost.
    // Idempotent with the webhook and with concurrent confirms (one deterministic hold per order).
    // RD-L6 D2 — decided on the order's LATEST state (it may have been superseded after the read at
    // the top of this route); the hold helper re-checks it again inside its own transaction.
    const latestSnap = await adminDb.collection(LICENSE_ORDERS_COLLECTION).doc(orderId).get()
    const latest = latestSnap.exists ? latestSnap.data() as Record<string, unknown> : undefined
    if (paymentId && rzpOrderId && razorpayAmountPaise > 0 && isSupersededUnheld(latest as never, `license_hold_${orderId}`)) {
      const held = await holdSupersededPayment({
        orderDocId: orderId, razorpayOrderId: rzpOrderId, paymentId, amountPaise: razorpayAmountPaise,
        eventId, organizerUid: uid, source: 'license_capacity',
      })
      if (!held.skipped) {
        console.warn(`[capacity] payment captured on a SUPERSEDED order — HELD for review · orderId=${orderId} paymentId=${paymentId} created=${held.created}`)
        return NextResponse.json({
          error: 'This checkout was replaced before your payment completed, so nothing was applied. Your payment is on hold for review by the RegisterDesk team — nothing further will be charged. Please do not pay again.',
          code: 'PAYMENT_HELD',
        }, { status: 409, headers: { 'Cache-Control': 'no-store' } })
      }
    }
    // RD-F1 — failed / held / refunded: never applied, and never held a second time here.
    console.warn(`[capacity] apply refused — order not in a grantable state · orderId=${orderId}`)
    return NextResponse.json({ error: 'This checkout is no longer valid (it was replaced, refunded or put on hold), so nothing was applied. If you were charged for it, the RegisterDesk team will resolve it — please do not pay again.', code: 'ORDER_NOT_PAYABLE' }, { status: 409, headers: { 'Cache-Control': 'no-store' } })
  }

  if (applied.kind === 'underpaid') {
    console.warn(`[capacity] apply refused — order does not cover its full total · orderId=${orderId}`)
    return NextResponse.json({ error: 'This checkout is out of date. Please start the change again.' }, { status: 409, headers: { 'Cache-Control': 'no-store' } })
  }

  if (applied.kind === 'not_found') {
    return NextResponse.json({ error: 'Order or event not found.' }, { status: 404 })
  }

  // Wallet-02 — organizer + support-inbox email + Super Admin inbox, once per order (claim-deduplicated).
  scheduleServicePurchaseNotification(orderId)
  console.info(`[capacity] applied · orderId=${orderId} capacity=${applied.newCapacity} ${applied.kind === 'already' ? '(idempotent replay)' : `razorpay=${applied.razorpayAmountPaise}`}`)

  return NextResponse.json({
    success: true,
    orderId,
    alreadyApplied: applied.kind === 'already',
    capacity:       applied.newCapacity,
    totalPaise:     applied.totalPaise,
    razorpayAmountPaise: applied.razorpayAmountPaise,
  }, { status: 200, headers: { 'Cache-Control': 'no-store' } })
}
