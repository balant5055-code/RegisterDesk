// POST /api/licensing/checkout/confirm — finalize a license purchase (F2.2).
//
// Runs AFTER /api/licensing/purchase created a Razorpay order for the FULL price and the
// organizer paid it. This route now owns only the CLIENT-path concerns — auth, Razorpay
// signature + captured-payment verification, notifications — and delegates the atomic
// activation (coupon redeem + order→paid + history) to the SHARED activateLicenseOrder,
// which is also used by the webhook + purchase self-heal recovery paths (GA-8 P1-1). One
// activation implementation ⇒ no divergent double-settlement. The communication wallet is
// never involved (RD-LICENSE-PAYMENT-01).
//
// It does NOT create the eventLicenses doc — that is created by the (unmodified)
// event publish transaction at submit time. All writes are keyed by deterministic
// ids (`lic_<eventId>`), so a replay is idempotent (no double charge).

import { NextRequest, NextResponse } from 'next/server'
import { scheduleServicePurchaseNotification } from '@/lib/notifications/servicePurchase'
import { adminDb }               from '@/lib/firebase/admin'
import { authorizeWorkspace }    from '@/lib/team/workspace'
import { razorpay }              from '@/lib/razorpay/client'
import { flagSuspiciousPayment } from '@/lib/payments/flagSuspicious'
import { RazorpayDonationGateway } from '@/lib/razorpay/donationGateway'
import { CURRENT_LICENSE_VERSION, isValidTierForVersion, defaultLicenseTierForVersion, type AnyEventLicenseTier } from '@/lib/licensing/eventLicense'
import { getEffectiveDefinitionForVersion } from '@/lib/licensing/resolveCatalog'
import { LICENSE_ORDERS_COLLECTION, licenseOrderConverter } from '@/lib/licensing/schema'
import { deriveLicenseCharge, activateLicenseOrder, holdExhaustedCouponRemainder, holdPhotoCapacityExceeded, PHOTO_CAPACITY_HELD_MESSAGE, orderListPricePaise } from '@/lib/licensing/finalizeLicensePurchase'
import { isConsistentServiceItem } from '@/lib/licensing/serviceAllowances'
import { activateAddonOrder, holdLicenceInactiveAddon, ADDON_LICENCE_INACTIVE } from '@/lib/licensing/draftCommerce'
import { confirmBadgePurchase } from '@/lib/licensing/printBadgePurchase/confirm'
import { holdSupersededPayment, isSupersededUnheld, supersededActivationOrderId, RAZORPAY_ORDER_ID_RE, recordDuplicateLicensePayment } from '@/lib/licensing/manualRefundHold'
import { NotificationType } from '@/lib/notifications'
import { sendOrganizerWhatsApp } from '@/lib/notifications/organizerWhatsApp'

const verifier = new RazorpayDonationGateway()

export async function POST(req: NextRequest): Promise<NextResponse> {
  const authz = await authorizeWorkspace(req, 'events')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  const uid = authz.workspaceUid

  let body: {
    eventId?: unknown; tier?: unknown; orderId?: unknown
    razorpay_order_id?: unknown; razorpay_payment_id?: unknown; razorpay_signature?: unknown
  }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }

  const eventId = typeof body.eventId === 'string' ? body.eventId.trim() : ''
  if (!eventId) return NextResponse.json({ error: 'eventId is required' }, { status: 400 })

  // ══ RD-PRINT-BILL-P4 · ID-BADGE PURCHASE ORDER (bdg_…) ═════════════════════════════
  // Owner only. The payment is bound to the order's own Razorpay id + amount, verified (signature +
  // fetched CAPTURED payment) here, then settled by the SAME function the webhook and sweep use:
  // activated once, or durably held — never acknowledged otherwise.
  if (typeof body.orderId === 'string' && body.orderId.trim().startsWith('bdg_')) {
    return confirmBadgePurchase({ uid, isOwner: authz.isOwner, eventId, orderId: body.orderId.trim(), body })
  }

  // ══ RD-EVENT-COMMERCE-02 · ADD-ON ORDER (pre-publish top-up) ═══════════════════════
  // Settled by its own shared transaction (also used by the webhook). The order must belong to
  // this workspace AND this draft; the payment is bound to the order's own Razorpay id + amount.
  const addonOrderId = typeof body.orderId === 'string' ? body.orderId.trim() : ''
  if (addonOrderId && addonOrderId !== `lic_${eventId}`) {
    if (!addonOrderId.startsWith(`add_${eventId}_`)) return NextResponse.json({ error: 'Order does not belong to this event.' }, { status: 400 })
    const aSnap = await adminDb.collection(LICENSE_ORDERS_COLLECTION).doc(addonOrderId).withConverter(licenseOrderConverter).get()
    const addon = aSnap.exists ? aSnap.data() : undefined
    if (!addon || addon.purpose !== 'addon' || addon.eventId !== eventId || addon.organizerUid !== uid) {
      return NextResponse.json({ error: 'Order not found.' }, { status: 404 })
    }
    if (addon.status === 'paid') {
      return NextResponse.json({ success: true, orderId: addonOrderId, alreadyPaid: true }, { status: 200, headers: { 'Cache-Control': 'no-store' } })
    }
    // RD-F2 — a SUPERSEDED add-on is still verified (below) so that a captured payment on it can be
    // recorded as a manual-refund hold; it is never settled.
    const supersededAddon = isSupersededUnheld(addon as never, `license_hold_${addonOrderId}`)
    // RD-SA-COMMERCE-P1 — refused for an inactive licence: verified below so its hold can be (re)completed.
    const licenceRefusedAddon = addon.status === 'failed' && (addon as { failReason?: unknown }).failReason === ADDON_LICENCE_INACTIVE
    if ((addon.status !== 'created' && !supersededAddon && !licenceRefusedAddon) || !addon.razorpayOrderId) {
      return NextResponse.json({ error: 'This checkout is no longer valid. Please restart the payment.' }, { status: 409 })
    }
    const aOrderId   = typeof body.razorpay_order_id   === 'string' ? body.razorpay_order_id   : null
    const aPaymentId = typeof body.razorpay_payment_id === 'string' ? body.razorpay_payment_id : null
    const aSignature = typeof body.razorpay_signature  === 'string' ? body.razorpay_signature  : null
    if (!aOrderId || !aPaymentId || !aSignature) return NextResponse.json({ error: 'Payment details are required' }, { status: 400 })
    if (aOrderId !== addon.razorpayOrderId) return NextResponse.json({ error: 'Payment order mismatch. Please restart checkout.' }, { status: 400 })
    if (!verifier.verifySignature({ orderId: aOrderId, paymentId: aPaymentId, signature: aSignature })) {
      console.warn(`[license] add-on payment verification FAILED · eventId=${eventId} order=${addonOrderId}`)
      return NextResponse.json({ error: 'Invalid payment signature' }, { status: 400 })
    }
    let pay: { amount?: number; currency?: string; status?: string; order_id?: string }
    try { pay = await razorpay.payments.fetch(aPaymentId) as typeof pay } catch {
      return NextResponse.json({ error: 'Could not verify payment. Please try again.' }, { status: 502 })
    }
    // RD-F1 — granted only for a CAPTURED payment (see the activation branch below).
    const ok = pay.status === 'captured' && pay.currency === 'INR'
      && pay.amount === addon.razorpayAmountPaise && pay.order_id === addon.razorpayOrderId
    if (!ok && pay.status === 'authorized' && pay.currency === 'INR' && pay.amount === addon.razorpayAmountPaise && pay.order_id === addon.razorpayOrderId) {
      return NextResponse.json({
        error: supersededAddon
          ? 'This checkout was replaced, and your payment is authorised but not yet captured. Nothing was applied; once Razorpay captures it, it is held for review by the RegisterDesk team. Please do not pay again.'
          : 'Your payment is authorised but not yet captured by Razorpay, so nothing has been applied yet. It is applied automatically once the payment is captured — please do not pay again.',
        code: 'PAYMENT_NOT_CAPTURED',
      }, { status: 409, headers: { 'Cache-Control': 'no-store' } })
    }
    if (!ok) {
      await flagSuspiciousPayment({
        source: 'license', reason: 'amount_or_order_mismatch', paymentId: aPaymentId, orderId: aOrderId, entityId: eventId,
        expectedAmountPaise: addon.razorpayAmountPaise ?? 0, actualAmountPaise: pay.amount,
        expectedCurrency: 'INR', actualCurrency: pay.currency, expectedOrderId: addon.razorpayOrderId, actualOrderId: pay.order_id,
      })
      return NextResponse.json({ error: 'Payment verification failed.' }, { status: 400 })
    }
    // RD-F2 — captured + verified on a SUPERSEDED add-on: hold it, grant nothing (idempotent).
    if (supersededAddon) {
      const held = await holdSupersededPayment({
        orderDocId: addonOrderId, razorpayOrderId: aOrderId, paymentId: aPaymentId,
        amountPaise: addon.razorpayAmountPaise ?? 0, eventId, organizerUid: uid, source: 'license',
      })
      console.warn(`[license] payment captured on a SUPERSEDED add-on — HELD for review · order=${addonOrderId} created=${held.created} skipped=${held.skipped === true}`)
      return NextResponse.json({
        error: 'This checkout was replaced before your payment completed, so nothing was applied. Your payment is on hold for review by the RegisterDesk team — nothing further will be charged. Please do not pay again.',
        code: 'PAYMENT_HELD',
      }, { status: 409, headers: { 'Cache-Control': 'no-store' } })
    }
    const result = await activateAddonOrder({ orderId: addonOrderId, razorpayOrderId: aOrderId, razorpayPaymentId: aPaymentId })
    // RD-PHOTO-01 — its photo units would take the event above 3,000 (another photo purchase settled
    // first). Nothing was granted and the order is now superseded: hold the payment for review.
    if (result === 'over_capacity') {
      const held = await holdSupersededPayment({
        orderDocId: addonOrderId, razorpayOrderId: aOrderId, paymentId: aPaymentId,
        amountPaise: addon.razorpayAmountPaise ?? 0, eventId, organizerUid: uid, source: 'license',
      })
      console.warn(`[license] add-on would exceed the 3,000-photo maximum — HELD for review · order=${addonOrderId} created=${held.created}`)
      return NextResponse.json({
        error: 'This purchase would take the event above its maximum of 3,000 photos, so nothing was applied. Your payment is on hold for review by the RegisterDesk team — please do not pay again.',
        code: 'PAYMENT_HELD',
      }, { status: 409, headers: { 'Cache-Control': 'no-store' } })
    }
    // RD-SA-COMMERCE-P1 — the event's licence is suspended / cancelled / refunded: nothing granted, the
    // order failed in that transaction; the captured payment is held for a Super Admin refund decision.
    if (result === 'licence_inactive') {
      const held = await holdLicenceInactiveAddon({
        orderId: addonOrderId, razorpayOrderId: aOrderId, paymentId: aPaymentId,
        amountPaise: addon.razorpayAmountPaise ?? 0, eventId, organizerUid: uid, detectedBy: 'confirm',
      })
      console.warn(`[license] add-on refused (licence inactive) — HELD for review · order=${addonOrderId} created=${held.created} skipped=${held.skipped === true}`)
      return NextResponse.json({
        error: "This event's licence is not active, so nothing was applied. Your payment is on hold for review by the RegisterDesk team — nothing further will be charged. Please do not pay again.",
        code: 'PAYMENT_HELD',
      }, { status: 409, headers: { 'Cache-Control': 'no-store' } })
    }
    if (result === 'inconsistent') {
      // A verified, captured payment on an order whose snapshot does not re-derive: recorded durably for review.
      await flagSuspiciousPayment({
        source: 'license', reason: 'addon_inconsistent', paymentId: aPaymentId, orderId: aOrderId, entityId: eventId,
        expectedAmountPaise: addon.razorpayAmountPaise ?? 0, actualAmountPaise: pay.amount, expectedCurrency: 'INR', actualCurrency: pay.currency,
      })
    }
    if (result === 'inconsistent' || result === 'not_payable') {
      console.error(`[license] add-on settlement refused (${result}) · eventId=${eventId} order=${addonOrderId}`)
      return NextResponse.json({ error: 'This order could not be verified. Please contact support.' }, { status: 409 })
    }
    // Wallet-02 — organizer + support-inbox email + Super Admin inbox, once per order (claim-deduplicated).
    scheduleServicePurchaseNotification(addonOrderId)
    console.info(`[license] add-on paid · eventId=${eventId} order=${addonOrderId} ${result}`)
    return NextResponse.json({ success: true, orderId: addonOrderId, alreadyPaid: result === 'already' }, { status: 200, headers: { 'Cache-Control': 'no-store' } })
  }

  // ══ RD-CAPACITY-01 · the price comes from the PERSISTED ORDER, never the request ══
  //
  // The order was written by /api/licensing/purchase from the server's own quote, and the
  // Razorpay order was created for the full price recorded on it. So the authoritative
  // price at confirm time is the snapshot on that order — not a re-quote against today's
  // configuration (a Super Admin rate change between checkout and confirm would otherwise
  // unbind the captured payment from its order) and certainly not anything in this request
  // body. Nothing here reads `capacity`, `amount`, `gst` or a `rate` from the client.
  const preSnap = await adminDb.collection(LICENSE_ORDERS_COLLECTION)
    .doc(`lic_${eventId}`).withConverter(licenseOrderConverter).get()
  const preExisting = preSnap.exists ? preSnap.data() ?? null : null
  // RD-HIGH-2 — an activation order belongs to the organizer who created it. Confirming someone
  // else's (or an owner-less) order would stamp the caller as its owner and grant them its
  // capacity / services. Refused before any payment is looked at.
  if (preExisting && (typeof preExisting.organizerUid !== 'string' || preExisting.organizerUid !== uid)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // ══ RD-F2A · a payment on a SUPERSEDED activation order ══════════════════════════════════
  // The Razorpay order in this request is not the current activation order's. If it is one this
  // draft's activation order was superseded from, its archive (written atomically with the
  // replacement) carries the amount + owner: verify the payment exactly as below, then HOLD it —
  // never activate. Anything else falls through to the normal checks (which refuse a mismatch).
  const reqRzpOrderId = typeof body.razorpay_order_id === 'string' ? body.razorpay_order_id : null
  if (reqRzpOrderId && RAZORPAY_ORDER_ID_RE.test(reqRzpOrderId) && reqRzpOrderId !== preExisting?.razorpayOrderId) {
    const archiveId = supersededActivationOrderId(eventId, reqRzpOrderId)
    const arSnap = await adminDb.collection(LICENSE_ORDERS_COLLECTION).doc(archiveId).withConverter(licenseOrderConverter).get()
    const ar = arSnap.exists ? arSnap.data() : undefined
    if (ar) {
      if (ar.organizerUid !== uid || ar.eventId !== eventId || ar.razorpayOrderId !== reqRzpOrderId) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
      }
      const arAmount = Math.max(0, ar.razorpayAmountPaise ?? 0)
      const pId = typeof body.razorpay_payment_id === 'string' ? body.razorpay_payment_id : null
      const sig = typeof body.razorpay_signature  === 'string' ? body.razorpay_signature  : null
      if (!isSupersededUnheld(ar as never, `license_hold_${archiveId}`) || arAmount <= 0) {
        return NextResponse.json({ error: 'This checkout is no longer valid, so nothing was applied. If you were charged for it, the RegisterDesk team will resolve it — please do not pay again.', code: 'ORDER_NOT_PAYABLE' }, { status: 409, headers: { 'Cache-Control': 'no-store' } })
      }
      if (!pId || !sig) return NextResponse.json({ error: 'Payment details are required' }, { status: 400 })
      if (!verifier.verifySignature({ orderId: reqRzpOrderId, paymentId: pId, signature: sig })) {
        return NextResponse.json({ error: 'Invalid payment signature' }, { status: 400 })
      }
      let p: { amount?: number; currency?: string; status?: string; order_id?: string }
      try { p = await razorpay.payments.fetch(pId) as typeof p } catch {
        return NextResponse.json({ error: 'Could not verify payment. Please try again.' }, { status: 502 })
      }
      const matches = p.currency === 'INR' && p.amount === arAmount && p.order_id === reqRzpOrderId
      if (p.status === 'authorized' && matches) {
        return NextResponse.json({ error: 'This checkout was replaced, and your payment is authorised but not yet captured. Nothing was applied; once Razorpay captures it, it is held for review by the RegisterDesk team. Please do not pay again.', code: 'PAYMENT_NOT_CAPTURED' }, { status: 409, headers: { 'Cache-Control': 'no-store' } })
      }
      if (p.status !== 'captured' || !matches) {
        await flagSuspiciousPayment({
          source: 'license', reason: 'amount_or_order_mismatch', paymentId: pId, orderId: reqRzpOrderId, entityId: eventId,
          expectedAmountPaise: arAmount, actualAmountPaise: p.amount, expectedCurrency: 'INR', actualCurrency: p.currency,
          expectedOrderId: reqRzpOrderId, actualOrderId: p.order_id,
        })
        return NextResponse.json({ error: 'Payment verification failed.' }, { status: 400 })
      }
      const held = await holdSupersededPayment({
        orderDocId: archiveId, razorpayOrderId: reqRzpOrderId, paymentId: pId, amountPaise: arAmount,
        eventId, organizerUid: uid, source: 'license',
      })
      console.warn(`[license] payment captured on a SUPERSEDED activation order — HELD for review · eventId=${eventId} order=${archiveId} created=${held.created} skipped=${held.skipped === true}`)
      return NextResponse.json({
        error: 'This checkout was replaced before your payment completed, so nothing was applied. Your payment is on hold for review by the RegisterDesk team — nothing further will be charged. Please do not pay again.',
        code: 'PAYMENT_HELD',
      }, { status: 409, headers: { 'Cache-Control': 'no-store' } })
    }
  }

  const capacityCharge = preExisting?.commercialModel === 'capacity' ? preExisting.capacityChange ?? null : null

  // A capacity order's own arithmetic is re-checked before it is used as a price. The
  // server wrote this document, but a stored value is still a value: if base + GST does not
  // equal the total, or the base is not the rate times the chargeable capacity, the record
  // has been altered and must not settle a payment.
  // RD-EVENT-COMMERCE-02 — every stored service line is re-checked the same way.
  if ((preExisting?.serviceItems ?? []).some(i => !isConsistentServiceItem(i))) {
    console.error(`[license] service lines inconsistent — refusing to settle · eventId=${eventId}`)
    return NextResponse.json({ error: 'This order could not be verified. Please restart checkout.' }, { status: 409 })
  }
  if (capacityCharge) {
    const consistent =
      capacityCharge.basePaise + capacityCharge.gstPaise === capacityCharge.totalPaise &&
      capacityCharge.chargeableCapacity * capacityCharge.activationRatePaise === capacityCharge.basePaise
    if (!consistent) {
      console.error(`[license] capacity snapshot inconsistent — refusing to settle · eventId=${eventId}`, capacityCharge)
      return NextResponse.json({ error: 'This order could not be verified. Please restart checkout.' }, { status: 409 })
    }
  }

  // Tier is required only on the LEGACY tier-priced path. A capacity order carries the
  // version's free tier purely as a compatibility stamp and has no tier price.
  let tier: AnyEventLicenseTier = defaultLicenseTierForVersion(CURRENT_LICENSE_VERSION)
  let licenseName = 'Event activation'
  // The order's LIST price: capacity total + every prepaid service line (RD-EVENT-COMMERCE-02).
  let pricePaise  = capacityCharge ? orderListPricePaise(preExisting, 0) : 0

  if (!capacityCharge) {
    // RD-LEGACY-01 — HISTORICAL TIER SETTLEMENT ONLY. Licence tiers are retired and
    // /api/licensing/purchase can no longer create a tier order, so this branch exists only to
    // settle a tier order that was CREATED BEFORE RETIREMENT. It therefore requires that stored,
    // server-written order (non-capacity, same tier as the request), and prices it from the
    // ORDER's own frozen price — never from today's tier catalog, which a raw configuration write
    // could change. With no such order there is nothing to settle and nothing is created.
    if (!isValidTierForVersion(body.tier, CURRENT_LICENSE_VERSION)) return NextResponse.json({ error: 'Invalid tier' }, { status: 400 })
    if (!preExisting || preExisting.commercialModel === 'capacity' || preExisting.tier !== body.tier) {
      return NextResponse.json({ error: 'Licence tiers are retired. Choose a registration capacity on License & Services.', code: 'TIER_RETIRED' }, { status: 410 })
    }
    tier = body.tier
    const def = await getEffectiveDefinitionForVersion(tier, CURRENT_LICENSE_VERSION)
    if (!def) return NextResponse.json({ error: 'Invalid tier' }, { status: 400 })
    licenseName = def.name
    // The order's own list price: the pre-coupon price it was created for, else what it charges.
    pricePaise  = typeof preExisting.originalPricePaise === 'number' ? preExisting.originalPricePaise : preExisting.amountPaise
    if (!(pricePaise > 0)) return NextResponse.json({ error: 'This tier does not require payment' }, { status: 400 })
  } else if (pricePaise <= 0) {
    // A ₹0 capacity activation never produced a payable order, so there is nothing to
    // confirm. Refusing is correct: silently succeeding would let a caller "confirm" an
    // activation that no payment backs.
    return NextResponse.json({ error: 'This activation does not require payment' }, { status: 400 })
  }

  const orderId   = typeof body.razorpay_order_id   === 'string' ? body.razorpay_order_id   : null
  const paymentId = typeof body.razorpay_payment_id === 'string' ? body.razorpay_payment_id : null
  const signature = typeof body.razorpay_signature  === 'string' ? body.razorpay_signature  : null

  // ── Server-authoritative amount (never trust the client) ─────────────────────
  // The purchase step persisted a PENDING order carrying the exact Razorpay amount it
  // created an order for — the WHOLE price. We bind the captured payment to THAT order
  // (id + amount + currency) so a payment from another order/event — or a cheap ₹1
  // payment — can neither activate this license nor be replayed across events.
  // The order was already read above to resolve the authoritative price — reuse that read
  // rather than fetching the same document twice.
  const persisted = preExisting

  const { razorpayAmountPaise, underpaid, expectedOrderId, finalPricePaise, couponCode } = deriveLicenseCharge(persisted, pricePaise)

  // RD-LICENSE-PAYMENT-01 · Razorpay must have been asked for the whole price. An order that
  // planned a communication-wallet share (created before this change) is refused outright:
  // the shortfall is never taken from any wallet and never waived.
  if (underpaid) {
    console.warn(`[license] confirm refused — order does not cover its full price · eventId=${eventId} razorpay=${razorpayAmountPaise} price=${finalPricePaise}`)
    return NextResponse.json({ error: 'This checkout is out of date. Please restart the payment.' }, { status: 409, headers: { 'Cache-Control': 'no-store' } })
  }

  // A payable order must be backed by a Razorpay payment bound to the persisted order.
  if (razorpayAmountPaise > 0) {
    if (!orderId || !paymentId || !signature) {
      return NextResponse.json({ error: 'Payment details are required' }, { status: 400 })
    }
    if (!expectedOrderId || orderId !== expectedOrderId) {
      console.warn(`[license] order mismatch · eventId=${eventId} expected=${expectedOrderId ?? 'none'} got=${orderId}`)
      return NextResponse.json({ error: 'Payment order mismatch. Please restart checkout.' }, { status: 400 })
    }
    if (!verifier.verifySignature({ orderId, paymentId, signature })) {
      console.warn(`[license] payment verification FAILED · eventId=${eventId}`)
      return NextResponse.json({ error: 'Invalid payment signature' }, { status: 400 })
    }
    // Defense-in-depth: fetch the captured payment and assert amount/currency/order,
    // identical to the wallet top-up + registration verification paths.
    let payment: { amount?: number; currency?: string; status?: string; order_id?: string }
    try {
      payment = await razorpay.payments.fetch(paymentId) as typeof payment
    } catch (err) {
      console.error('[license] payment fetch failed', err)
      return NextResponse.json({ error: 'Could not verify payment. Please try again.' }, { status: 502 })
    }
    // RD-F1 — the activation grants capacity, so it needs a CAPTURED payment. An `authorized` one is
    // not money yet: nothing is applied, and the payment.captured webhook activates it on capture.
    if (payment.status === 'authorized' && payment.currency === 'INR' && payment.amount === razorpayAmountPaise && payment.order_id === expectedOrderId) {
      return NextResponse.json({ error: 'Your payment is authorised but not yet captured by Razorpay, so nothing has been applied yet. It is applied automatically once the payment is captured — please do not pay again.', code: 'PAYMENT_NOT_CAPTURED' }, { status: 409, headers: { 'Cache-Control': 'no-store' } })
    }
    const captured = payment.status === 'captured'
    if (!captured || payment.currency !== 'INR' || payment.amount !== razorpayAmountPaise || payment.order_id !== expectedOrderId) {
      await flagSuspiciousPayment({
        source: 'license', reason: 'amount_or_order_mismatch',
        paymentId, orderId, entityId: eventId,
        expectedAmountPaise: razorpayAmountPaise, actualAmountPaise: payment.amount,
        expectedCurrency: 'INR', actualCurrency: payment.currency,
        expectedOrderId, actualOrderId: payment.order_id,
      })
      console.warn(`[license] payment amount/order mismatch · eventId=${eventId}`)
      return NextResponse.json({ error: 'Payment verification failed.' }, { status: 400 })
    }
    console.info(`[license] payment verified · eventId=${eventId} paymentId=${paymentId} amount=${razorpayAmountPaise}`)
  }

  // ── Atomic activation (shared with webhook + self-heal recovery) ──────────────
  const activation = await activateLicenseOrder({
    eventId, uid, tier, licenseName, basePricePaise: pricePaise,
    persisted, razorpayOrderId: orderId, razorpayPaymentId: paymentId,
    ...(capacityCharge ? { capacitySnapshot: capacityCharge } : {}),
  })

  if (activation.kind === 'photo_capacity_exceeded') {
    console.warn(`[license] activation refused — would exceed the 3,000-photo maximum · eventId=${eventId}`)
    await holdPhotoCapacityExceeded({ eventId, orderId, paymentId, amountPaise: razorpayAmountPaise })
    return NextResponse.json({ error: PHOTO_CAPACITY_HELD_MESSAGE, code: 'PAYMENT_HELD' }, { status: 409, headers: { 'Cache-Control': 'no-store' } })
  }
  if (activation.kind === 'coupon_exhausted') {
    // The coupon hit its usage limit between checkout and confirm. Activation rolled
    // back. RD-EVENT-COMMERCE-04B: the captured amount is recorded as a MANUAL-REFUND HOLD
    // (idempotent; no automatic refund) for a Super Admin to refund or resolve explicitly.
    console.warn(`[license] activation blocked — coupon usage limit reached · eventId=${eventId} coupon=${couponCode ?? ''}`)
    await holdExhaustedCouponRemainder({ eventId, orderId, paymentId, remainderPaise: razorpayAmountPaise, persisted })
    return NextResponse.json(
      { error: 'This coupon reached its usage limit, so the licence was not activated. If you were charged, the payment is on hold for review by the RegisterDesk team — nothing further will be charged.' },
      { status: 409, headers: { 'Cache-Control': 'no-store' } },
    )
  }

  if (activation.kind === 'superseded') {
    // RD-M4 D1 — the order was REPLACED between this request's read and the activation transaction:
    // the verified payment belongs to the old order, now archived (F2A, written atomically with the
    // replacement). Hold it there — never apply it over the current order.
    if (orderId && paymentId && RAZORPAY_ORDER_ID_RE.test(orderId) && razorpayAmountPaise > 0) {
      const held = await holdSupersededPayment({
        orderDocId: supersededActivationOrderId(eventId, orderId), razorpayOrderId: orderId, paymentId,
        amountPaise: razorpayAmountPaise, eventId, organizerUid: uid, source: 'license',
      })
      if (!held.skipped) {
        console.warn(`[license] activation raced a replacement — payment HELD on the archive · eventId=${eventId} order=${orderId} created=${held.created}`)
        return NextResponse.json({
          error: 'This checkout was replaced before your payment completed, so nothing was applied. Your payment is on hold for review by the RegisterDesk team — nothing further will be charged. Please do not pay again.',
          code: 'PAYMENT_HELD',
        }, { status: 409, headers: { 'Cache-Control': 'no-store' } })
      }
    }
    console.warn(`[license] activation refused — order replaced and no archive to hold on · eventId=${eventId}`)
    return NextResponse.json({ error: 'This checkout is no longer valid (it was replaced, refunded or put on hold), so nothing was applied. If you were charged for it, the RegisterDesk team will resolve it — please do not pay again.', code: 'ORDER_NOT_PAYABLE' }, { status: 409, headers: { 'Cache-Control': 'no-store' } })
  }

  if (activation.kind === 'ineligible') {
    console.warn(`[license] activation refused — order not in a grantable state · eventId=${eventId}`)
    return NextResponse.json({ error: 'This checkout is no longer valid (it was replaced, refunded or put on hold), so nothing was applied. If you were charged for it, the RegisterDesk team will resolve it — please do not pay again.', code: 'ORDER_NOT_PAYABLE' }, { status: 409, headers: { 'Cache-Control': 'no-store' } })
  }

  if (activation.kind === 'underpaid') {
    console.warn(`[license] activation refused — order does not cover its full price · eventId=${eventId}`)
    return NextResponse.json({ error: 'This checkout is out of date. Please restart the payment.' }, { status: 409, headers: { 'Cache-Control': 'no-store' } })
  }

  // Wallet-02 — organizer + support-inbox email + Super Admin inbox, once per order (claim-deduplicated).
  // The purchase email (with lines, GST, references and balances) is sent there — it replaces the
  // older LICENSE_PURCHASED email so an activation is never emailed twice. The WhatsApp message below stays.
  scheduleServicePurchaseNotification(`lic_${eventId}`)
  console.info(`[license] activated · eventId=${eventId} tier=${tier} order=lic_${eventId} ${activation.kind === 'already' ? '(idempotent replay)' : 'razorpay=' + razorpayAmountPaise}`)

  // License Purchased — organizer WhatsApp (FREE, Phase G3.5; the email is the Wallet-02 one above). Only on a
  // fresh purchase (not an idempotent replay). Best-effort; never blocks the response.
  if (activation.kind === 'ok') {
    void (async () => {
      try {
        const [userSnap, eventSnap] = await Promise.all([
          adminDb.collection('users').doc(uid).get(),
          adminDb.collection('events').doc(eventId).get(),
        ])
        const u = userSnap.data() as { email?: string; name?: string } | undefined
        if (!u?.email) return
        const evName = (eventSnap.data() as { eventDetails?: { info?: { name?: string } } } | undefined)?.eventDetails?.info?.name
        const eventName = typeof evName === 'string' && evName.trim() ? evName : 'your event'
        // Under the capacity model there is no tier to name, so the notification says what
        // was actually bought. `tierName` is the EXISTING template variable — only the value
        // changes, so no template, dispatcher or provider contract is touched.
        const tierName  = capacityCharge
          ? `${capacityCharge.capacity.toLocaleString('en-IN')} registrations`
          : licenseName

        void sendOrganizerWhatsApp({
          type: NotificationType.LICENSE_PURCHASED, organizerUid: uid,
          variables: { organizerName: u.name ?? '', eventName, tierName },
          eventSlug: eventId, eventName,
        })
      } catch (err) {
        console.error('[license] purchase notification failed:', err)
      }
    })()
  }

  // RD-CE-FIX M4 — the order is already PAID. An already-paid order owes nothing, so the checks above
  // did not verify this request's payment; it is verified HERE against the stored order (signature,
  // then the fetched payment: captured, same Razorpay order, same amount, INR). A verified payment that
  // is NOT the one credited is a second capture: held for Super Admin review, never applied. The order
  // is re-read so a concurrent webhook that credited THIS payment is never mistaken for a duplicate.
  if (activation.kind === 'already' && paymentId && signature && orderId) {
    const nowOrder = (await adminDb.collection(LICENSE_ORDERS_COLLECTION).doc(`lic_${eventId}`).get()).data() as
      { razorpayPaymentId?: string | null; razorpayOrderId?: string | null; razorpayAmountPaise?: number; amountPaise?: number } | undefined
    const credited = nowOrder?.razorpayPaymentId ?? null
    // A PAID order keeps the final charged amount in amountPaise (licensing is Razorpay-only, full amount).
    const paidAmount = Math.max(0, nowOrder?.razorpayAmountPaise ?? nowOrder?.amountPaise ?? 0)
    let verifiedSecond = false
    if (credited && credited !== paymentId && nowOrder?.razorpayOrderId === orderId && paidAmount > 0
        && verifier.verifySignature({ orderId, paymentId, signature })) {
      try {
        const p = await razorpay.payments.fetch(paymentId) as { amount?: number; currency?: string; status?: string; order_id?: string }
        verifiedSecond = p.status === 'captured' && p.currency === 'INR' && p.amount === paidAmount && p.order_id === orderId
      } catch { verifiedSecond = false }
    }
    if (verifiedSecond && credited) {
      const dup = await recordDuplicateLicensePayment({
        orderDocId: `lic_${eventId}`, razorpayOrderId: orderId, paymentId, creditedPaymentId: credited,
        amountPaise: paidAmount, eventId, organizerUid: uid, detectedBy: 'confirm',
      })
      console.warn(`[license] SECOND payment on an already-paid activation order — HELD for review · eventId=${eventId} payment=${paymentId} created=${dup.created}`)
      return NextResponse.json({
        error: 'This event was already paid for, so this second payment was not applied. It is on hold for review by the RegisterDesk team — nothing further will be charged.',
        code: 'PAYMENT_HELD',
      }, { status: 409, headers: { 'Cache-Control': 'no-store' } })
    }
  }

  return NextResponse.json(
    { success: true, orderId: `lic_${eventId}`, alreadyPaid: activation.kind === 'already', pricePaise, finalPricePaise, razorpayAmountPaise, ...(couponCode ? { couponCode } : {}) },
    { status: 200, headers: { 'Cache-Control': 'no-store' } },
  )
}
