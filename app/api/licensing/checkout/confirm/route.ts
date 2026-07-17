// POST /api/licensing/checkout/confirm — finalize a license purchase (F2.2).
//
// Runs AFTER the wallet-first split from /api/licensing/purchase and (when a
// remainder was charged) a successful Razorpay payment. This route now owns only the
// CLIENT-path concerns — auth, Razorpay signature + captured-payment verification,
// notifications — and delegates the atomic activation (wallet deduct + coupon redeem
// + order→paid + history) to the SHARED activateLicenseOrder, which is also used by
// the webhook + purchase self-heal recovery paths (GA-8 P1-1). One activation
// implementation ⇒ no divergent double-settlement.
//
// It does NOT create the eventLicenses doc — that is created by the (unmodified)
// event publish transaction at submit time. All writes are keyed by deterministic
// ids (`lic_<eventId>`), so a replay is idempotent (no double charge).

import { NextRequest, NextResponse } from 'next/server'
import { adminDb }               from '@/lib/firebase/admin'
import { authorizeWorkspace }    from '@/lib/team/workspace'
import { razorpay }              from '@/lib/razorpay/client'
import { flagSuspiciousPayment } from '@/lib/payments/flagSuspicious'
import { RazorpayDonationGateway } from '@/lib/razorpay/donationGateway'
import { isEventLicenseTier } from '@/lib/licensing/eventLicense'
import { getEffectiveLicenseDefinition } from '@/lib/licensing/resolveCatalog'
import { LICENSE_ORDERS_COLLECTION, licenseOrderConverter } from '@/lib/licensing/schema'
import { deriveLicenseCharge, activateLicenseOrder, refundExhaustedCouponRemainder } from '@/lib/licensing/finalizeLicensePurchase'
import { notificationEngine, NotificationType, NotificationChannel } from '@/lib/notifications'
import { sendOrganizerWhatsApp } from '@/lib/notifications/organizerWhatsApp'

const verifier = new RazorpayDonationGateway()

export async function POST(req: NextRequest): Promise<NextResponse> {
  const authz = await authorizeWorkspace(req, 'events')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  const uid = authz.workspaceUid

  let body: {
    eventId?: unknown; tier?: unknown; walletUsePaise?: unknown
    razorpay_order_id?: unknown; razorpay_payment_id?: unknown; razorpay_signature?: unknown
  }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }

  const eventId = typeof body.eventId === 'string' ? body.eventId.trim() : ''
  if (!eventId) return NextResponse.json({ error: 'eventId is required' }, { status: 400 })
  if (!isEventLicenseTier(body.tier)) return NextResponse.json({ error: 'Invalid tier' }, { status: 400 })
  const tier = body.tier

  const def = await getEffectiveLicenseDefinition(tier)
  if (def.contactSales || def.licensePricePaise === 0) {
    return NextResponse.json({ error: 'This tier does not require payment' }, { status: 400 })
  }
  const pricePaise = def.licensePricePaise

  const orderId   = typeof body.razorpay_order_id   === 'string' ? body.razorpay_order_id   : null
  const paymentId = typeof body.razorpay_payment_id === 'string' ? body.razorpay_payment_id : null
  const signature = typeof body.razorpay_signature  === 'string' ? body.razorpay_signature  : null

  // ── Server-authoritative split (never trust the client wallet/remainder) ──────
  // The purchase step persisted a PENDING order carrying the exact Razorpay
  // remainder it created an order for. We bind the captured payment to THAT order
  // (id + amount + currency) so a payment from another order/event — or a cheap ₹1
  // payment — can neither activate this license nor be replayed across events.
  const orderRef      = adminDb.collection(LICENSE_ORDERS_COLLECTION).doc(`lic_${eventId}`).withConverter(licenseOrderConverter)
  const persistedSnap = await orderRef.get()
  const persisted     = persistedSnap.exists ? persistedSnap.data() ?? null : null

  const { remainderPaise, expectedOrderId, walletUsePaise, finalPricePaise, couponCode } = deriveLicenseCharge(persisted, pricePaise)

  // A remainder must be backed by a Razorpay payment bound to the persisted order.
  if (remainderPaise > 0) {
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
    const captured = payment.status === 'captured' || payment.status === 'authorized'
    if (!captured || payment.currency !== 'INR' || payment.amount !== remainderPaise || payment.order_id !== expectedOrderId) {
      await flagSuspiciousPayment({
        source: 'license', reason: 'amount_or_order_mismatch',
        paymentId, orderId, entityId: eventId,
        expectedAmountPaise: remainderPaise, actualAmountPaise: payment.amount,
        expectedCurrency: 'INR', actualCurrency: payment.currency,
        expectedOrderId, actualOrderId: payment.order_id,
      })
      console.warn(`[license] payment amount/order mismatch · eventId=${eventId}`)
      return NextResponse.json({ error: 'Payment verification failed.' }, { status: 400 })
    }
    console.info(`[license] payment verified · eventId=${eventId} paymentId=${paymentId} amount=${remainderPaise}`)
  }

  // ── Atomic activation (shared with webhook + self-heal recovery) ──────────────
  const activation = await activateLicenseOrder({
    eventId, uid, tier, licenseName: def.name, basePricePaise: pricePaise,
    persisted, razorpayOrderId: orderId, razorpayPaymentId: paymentId,
  })

  if (activation.kind === 'coupon_exhausted') {
    // The coupon hit its usage limit between checkout and confirm. Activation rolled
    // back; refund the captured Razorpay remainder (idempotent, gated by
    // couponExhaustedRefundId). The wallet portion was never deducted (same txn).
    console.warn(`[license] activation blocked — coupon usage limit reached · eventId=${eventId} coupon=${couponCode ?? ''}`)
    await refundExhaustedCouponRemainder({ eventId, orderId, paymentId, remainderPaise, persisted })
    return NextResponse.json(
      { error: 'This coupon reached its usage limit. If you were charged, a full refund has been initiated and will appear within 5–7 business days.' },
      { status: 409, headers: { 'Cache-Control': 'no-store' } },
    )
  }

  if (activation.kind === 'insufficient') {
    console.warn(`[license] activation blocked — insufficient wallet · eventId=${eventId} walletUse=${walletUsePaise}`)
    return NextResponse.json({ error: 'Insufficient wallet balance' }, { status: 402, headers: { 'Cache-Control': 'no-store' } })
  }

  console.info(`[license] activated · eventId=${eventId} tier=${tier} order=lic_${eventId} ${activation.kind === 'already' ? '(idempotent replay)' : 'wallet=' + walletUsePaise + ' razorpay=' + remainderPaise}`)

  // License Purchased — organizer Email + WhatsApp (FREE, Phase G3.5). Only on a
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
        const tierName  = def.name

        if (notificationEngine.isAvailable(NotificationChannel.EMAIL)) {
          await notificationEngine.send(NotificationType.LICENSE_PURCHASED, {
            to: u.email, organizerName: u.name ?? '', eventName, tierName, amountPaise: finalPricePaise,
          })
        }
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

  return NextResponse.json(
    { success: true, orderId: `lic_${eventId}`, alreadyPaid: activation.kind === 'already', pricePaise, finalPricePaise, walletUsePaise, remainderPaise, ...(couponCode ? { couponCode } : {}) },
    { status: 200, headers: { 'Cache-Control': 'no-store' } },
  )
}
