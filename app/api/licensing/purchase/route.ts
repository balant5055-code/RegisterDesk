// POST /api/licensing/purchase — Event License purchase (Phases D4.3 + D4.4).
//
// Validates the request, calls the pure Purchase Service (purchaseLicense), and —
// for a PAID license — creates a Razorpay ORDER using the existing shared Razorpay
// client. Free Starter (zero-price) purchases return immediately with no order.
//
// It still does NOT charge money (payment happens on the client), does NOT verify
// payment, does NOT persist the order/license/payment, does NOT create license
// documents or history, and does NOT activate anything. The only Firestore access
// is reads used to build the service's preparation context. Creating a Razorpay
// order is an external API call, not a database write.

import { NextRequest, NextResponse } from 'next/server'
import { FieldValue }          from 'firebase-admin/firestore'
import { verifyCaller }        from '@/lib/team/access'
import { resolveWorkspaceUid } from '@/lib/team/workspace'
import { getEventBySlug }      from '@/lib/firebase/firestore/events'
import { adminDb }             from '@/lib/firebase/admin'
import { getWalletBalance }   from '@/lib/firebase/firestore/wallet'
import { getWalletConfig }     from '@/lib/wallet/resolveWalletConfig'
import { razorpay, RAZORPAY_KEY_ID } from '@/lib/razorpay/client'
import { createEventLicenseService, type LicensePreparationContext } from '@/lib/licensing/service'
import { EVENT_LICENSES_COLLECTION, LICENSE_ORDERS_COLLECTION, licenseOrderConverter, type LicenseOrderDoc } from '@/lib/licensing/schema'
import { isEventLicenseTier, type EventLicenseTier } from '@/lib/licensing/eventLicense'
import { getEffectiveLicenseDefinition } from '@/lib/licensing/resolveCatalog'
import { activateLicenseOrder, refundExhaustedCouponRemainder } from '@/lib/licensing/finalizeLicensePurchase'
import {
  getLicenseCoupon, getLicenseCouponsConfig, countOrganizerCouponRedemptions,
  validateLicenseCoupon, normalizeCouponCode, type LicenseCouponSnapshot,
} from '@/lib/licensing/coupons'
import type { PurchaseLicenseRequest, PurchaseLicenseResponse, PurchaseFailureReason } from '@/lib/licensing/purchase'
import type { LicenseRepositories } from '@/lib/licensing/repository'

// purchaseLicense() is pure and never touches the repositories, so this endpoint
// injects a throwing stub. A real Firestore-backed repository set arrives in a
// later phase (order creation / activation), not here.
const notWired = (): never => {
  throw new Error('License repositories are not wired in the purchase-preparation endpoint (D4.3).')
}
const stubRepositories: LicenseRepositories = {
  licenses: { getByEventId: notWired, save: notWired, listActiveByOrganizer: notWired },
  orders:   { getById: notWired, create: notWired, updateStatus: notWired },
  history:  { append: notWired, listByEvent: notWired },
}

/** Map a purchase failure reason to the appropriate HTTP status. */
function statusForFailure(reason: PurchaseFailureReason): number {
  switch (reason) {
    case 'event_not_found':       return 404
    case 'already_licensed':      return 409
    case 'downgrade_not_allowed': return 409
    case 'invalid_tier':          return 422
    default:                      return 422
  }
}

/** Read the current license tier for an event (null when unlicensed). Read-only. */
async function readCurrentLicenseTier(eventId: string): Promise<EventLicenseTier | null> {
  const snap = await adminDb.collection(EVENT_LICENSES_COLLECTION).doc(eventId).get()
  if (!snap.exists) return null
  const tier = (snap.data() as { tier?: unknown }).tier
  return isEventLicenseTier(tier) ? tier : null
}

/**
 * Create a Razorpay ORDER for a paid license using the existing shared client.
 * Nothing is persisted here. The `notes.kind = 'license'` tag lets a later
 * verification/webhook phase distinguish license orders from registration/donation
 * orders that share the same webhook.
 */
async function createLicenseRazorpayOrder(args: {
  eventId:      string
  organizerUid: string
  tier:         EventLicenseTier
  amountPaise:  number
}): Promise<string> {
  const order = await razorpay.orders.create({
    amount:   args.amountPaise,
    currency: 'INR',
    receipt:  `lic_${args.eventId}`.slice(0, 40),   // Razorpay receipt: max 40 chars
    notes: {
      kind:         'license',
      eventId:      args.eventId,
      organizerUid: args.organizerUid,
      tier:         args.tier,
    },
  })
  return order.id
}

/**
 * GA-8 P1-1 — find a captured/authorized Razorpay payment on an existing license
 * order that matches the persisted remainder (amount + INR). Used to self-heal a
 * captured-but-unconfirmed order on retry so we never mint a SECOND order for an
 * already-captured payment (double-charge). Returns the payment id, or null.
 */
async function findCapturedLicensePayment(razorpayOrderId: string, expectedRemainderPaise: number): Promise<string | null> {
  if (expectedRemainderPaise <= 0) return null
  try {
    const res = await razorpay.orders.fetchPayments(razorpayOrderId) as { items?: Array<{ id?: string; status?: string; amount?: number; currency?: string }> }
    const hit = (res.items ?? []).find(p =>
      (p.status === 'captured' || p.status === 'authorized') &&
      p.currency === 'INR' && p.amount === expectedRemainderPaise)
    return hit?.id ?? null
  } catch (err) {
    console.error('[license] fetchPayments failed during self-heal', err)
    return null
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const caller = await verifyCaller(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: { eventId?: unknown; tier?: unknown; couponCode?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const eventId = typeof body.eventId === 'string' ? body.eventId.trim() : ''
  if (!eventId) return NextResponse.json({ error: 'eventId is required' }, { status: 400 })
  // EA-4 S2: optional license coupon (empty ⇒ no coupon; flow unchanged).
  const couponCode = typeof body.couponCode === 'string' && body.couponCode.trim() ? normalizeCouponCode(body.couponCode) : ''
  if (typeof body.tier !== 'string') {
    return NextResponse.json({ error: 'tier is required' }, { status: 400 })
  }
  console.info(`[license] payment started · eventId=${eventId} tier=${body.tier}`)

  const ctx = await resolveWorkspaceUid(caller.uid)

  // Reads to build the preparation context (existence + ownership + current tier).
  // The organizer pays BEFORE submitting, so eventId may be a DRAFT id (no
  // published event yet) — accept either a published event or an owned draft.
  const event = await getEventBySlug(eventId)
  if (event && event.uid !== ctx.workspaceUid) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  let exists = event !== null
  let eventType: string | null = event && typeof (event as { eventType?: unknown }).eventType === 'string'
    ? ((event as { eventType?: string }).eventType ?? null) : null
  if (!exists) {
    const draftSnap = await adminDb.doc(`users/${ctx.workspaceUid}/eventDrafts/${eventId}`).get()
    exists = draftSnap.exists
    const dd = draftSnap.exists ? (draftSnap.data() as Record<string, unknown>) : null
    if (typeof dd?.eventType === 'string') eventType = dd.eventType
  }
  const currentTier = event ? await readCurrentLicenseTier(eventId) : null

  const request: PurchaseLicenseRequest = {
    eventId,
    organizerUid: ctx.workspaceUid,
    tier:         body.tier as EventLicenseTier,   // validated inside the service
    method:       'razorpay',
  }
  // Resolve the EFFECTIVE (config-aware) price so the charge reflects any admin
  // override. Invalid tiers fall through to the service's validation.
  const effectivePricePaise = isEventLicenseTier(body.tier)
    ? (await getEffectiveLicenseDefinition(body.tier)).licensePricePaise
    : undefined
  const context: LicensePreparationContext = {
    eventExists: exists,
    currentTier,
    pricePaise: effectivePricePaise,
  }

  const prepared = createEventLicenseService(stubRepositories).purchaseLicense(request, context)

  // Validation / preparation failure → mapped HTTP status.
  if (!prepared.ok) {
    return NextResponse.json(prepared, {
      status:  statusForFailure(prepared.failureReason),
      headers: { 'Cache-Control': 'no-store' },
    })
  }

  // Free Starter (zero-price / no checkout) → immediate success, no order.
  if (!prepared.checkout || prepared.checkout.amountPaise <= 0) {
    return NextResponse.json(
      { ...prepared, pricePaise: 0, walletUsePaise: 0, remainderPaise: 0 },
      { status: 200, headers: { 'Cache-Control': 'no-store' } },
    )
  }

  // ── Retry / double-charge guard (Phase 7) ────────────────────────────────────
  // If a PAID license order already exists for this draft (payment succeeded on a
  // previous attempt but the publish step failed), NEVER create a second Razorpay
  // order. Same tier → allow a FREE retry (the client skips checkout and re-runs
  // publish, which reads the paid order). Different tier → refuse rather than
  // silently double-charge.
  const existingOrderSnap = await adminDb.collection(LICENSE_ORDERS_COLLECTION).doc(`lic_${eventId}`).withConverter(licenseOrderConverter).get()
  if (existingOrderSnap.exists) {
    const existing = existingOrderSnap.data() as LicenseOrderDoc | undefined

    // GA-8 P1-1 self-heal: a `created` order that already has a CAPTURED Razorpay
    // payment means a prior attempt paid but /checkout/confirm never ran. Activate it
    // now (idempotent, shared with confirm + webhook) BEFORE minting anything, so we
    // never create a SECOND Razorpay order for an already-captured payment.
    if (existing?.status === 'created' && existing.razorpayOrderId) {
      const remainder = Math.max(0, existing.razorpayAmountPaise ?? 0)
      const capturedPaymentId = await findCapturedLicensePayment(existing.razorpayOrderId, remainder)
      if (capturedPaymentId && isEventLicenseTier(existing.tier)) {
        const rdef = await getEffectiveLicenseDefinition(existing.tier)
        const act = await activateLicenseOrder({
          eventId, uid: ctx.workspaceUid, tier: existing.tier, licenseName: rdef.name,
          basePricePaise: rdef.licensePricePaise, persisted: existing,
          razorpayOrderId: existing.razorpayOrderId, razorpayPaymentId: capturedPaymentId,
        })
        if (act.kind === 'coupon_exhausted') {
          await refundExhaustedCouponRemainder({ eventId, orderId: existing.razorpayOrderId, paymentId: capturedPaymentId, remainderPaise: remainder, persisted: existing })
          return NextResponse.json({
            ok: false, status: 'failed', failureReason: 'coupon_exhausted',
            message: 'This coupon reached its usage limit. If you were charged, a full refund has been initiated.',
          }, { status: 409, headers: { 'Cache-Control': 'no-store' } })
        }
        if (act.kind === 'ok' || act.kind === 'already') {
          console.info(`[license] purchase self-healed captured order · eventId=${eventId} tier=${existing.tier}`)
          existing.status = 'paid'   // fall through to the paid-order retry logic below
        }
      }
    }

    if (existing?.status === 'paid') {
      if (existing.tier === request.tier) {
        console.info(`[license] purchase → already paid, free retry · eventId=${eventId} tier=${request.tier}`)
        return NextResponse.json({
          ok: true, status: 'paid', alreadyPaid: true, receipt: prepared.receipt,
          pricePaise: prepared.checkout.amountPaise, walletUsePaise: 0, remainderPaise: 0, checkout: null,
        }, { status: 200, headers: { 'Cache-Control': 'no-store' } })
      }
      console.warn(`[license] purchase blocked — different tier already paid · eventId=${eventId} paid=${String(existing.tier)} requested=${request.tier}`)
      return NextResponse.json({
        ok: false, status: 'failed', failureReason: 'already_licensed',
        message: `A ${String(existing.tier)} license was already paid for this event. Retry submission, or contact support to change tiers.`,
      }, { status: 409, headers: { 'Cache-Control': 'no-store' } })
    }

    // ── GA-8 P2 — never re-mint over an existing Razorpay order ──────────────────
    // A `created` order that already OWNS a razorpayOrderId must NEVER cause a
    // SECOND Razorpay order to be minted (that would create a duplicate payable
    // order, orphan an already-captured payment, and risk a double charge). The
    // self-heal above already tried to activate a captured payment; if we are still
    // `created` here (no captured payment matched, or activation was insufficient),
    // the order is genuinely awaiting payment — so REUSE it: return the SAME
    // razorpayOrderId and its PERSISTED remainder and let the client retry checkout
    // on it. We return before any write, so the persisted order (and its
    // razorpayOrderId) is never overwritten. Confirm + webhook recovery already read
    // this same persisted order, so both continue to work unchanged.
    if (existing?.status === 'created' && existing.razorpayOrderId) {
      const remainder = Math.max(0, existing.razorpayAmountPaise ?? 0)
      console.info(`[license] purchase → reuse existing created order, no re-mint · eventId=${eventId} tier=${String(existing.tier)}`)
      return NextResponse.json({
        ok: true, status: 'created',
        receipt: { ...prepared.receipt, razorpayOrderId: existing.razorpayOrderId },
        checkout: remainder > 0
          ? { provider: 'razorpay', razorpayOrderId: existing.razorpayOrderId, amountPaise: remainder, currency: 'INR', keyId: RAZORPAY_KEY_ID }
          : null,
        pricePaise:     existing.amountPaise,
        walletUsePaise: Math.max(0, existing.amountPaise - remainder),
        remainderPaise: remainder,
        ...(existing.couponCode ? {
          originalPricePaise: existing.originalPricePaise,
          discountPaise:      existing.discountPaise,
          couponCode:         existing.couponCode,
        } : {}),
      }, { status: 200, headers: { 'Cache-Control': 'no-store' } })
    }
  }

  // ── EA-4 S2: apply a LICENSE coupon BEFORE the wallet split (one payment flow).
  //    The discount reduces the price; wallet + Razorpay then cover the remainder. ─
  const basePricePaise = prepared.checkout.amountPaise
  let finalPricePaise  = basePricePaise
  let couponFields: {
    couponCode: string; campaign: string; originalPricePaise: number
    discountPaise: number; finalPricePaise: number; couponSnapshot: LicenseCouponSnapshot
  } | null = null
  if (couponCode) {
    const [coupon, cfg, organizerRedemptions] = await Promise.all([
      getLicenseCoupon(couponCode),
      getLicenseCouponsConfig(),
      countOrganizerCouponRedemptions(couponCode, ctx.workspaceUid),
    ])
    const cres = validateLicenseCoupon(coupon, {
      tier: request.tier, eventType, pricePaise: basePricePaise, organizerRedemptions,
      couponsEnabled: cfg.enabled, maxPercentageDiscount: cfg.maxPercentageDiscount,
      maxFixedDiscountPaise: cfg.maxFixedDiscountPaise, allowFreeLicense: cfg.allowFreeLicense,
    }, Date.now())
    if (!cres.ok) {
      return NextResponse.json(
        { ok: false, status: 'failed', failureReason: 'invalid_coupon', message: cres.message },
        { status: 422, headers: { 'Cache-Control': 'no-store' } },
      )
    }
    finalPricePaise = cres.finalPricePaise
    couponFields = {
      couponCode, campaign: cres.snapshot.campaign, originalPricePaise: basePricePaise,
      discountPaise: cres.discountPaise, finalPricePaise, couponSnapshot: cres.snapshot,
    }
  }

  // Wallet split on the (discounted) price, governed by Business Configuration
  // (RD-CONF-05 / GA-3 S4C). Wallet funds are consulted only when the resolver says
  // wallet payments apply (enabled, payments allowed, not frozen, mode participates);
  // 'gateway_only' opts out. The wallet is never spent below minimumRequiredBalance.
  // No wallet is deducted here — that happens on confirm. Defaults (enabled,
  // wallet_first, not frozen, min-required 0) preserve the prior wallet-first split.
  const walletCfg      = await getWalletConfig({ organizerUid: ctx.workspaceUid })
  const walletApplies  = walletCfg.enabled && walletCfg.allowWalletPayments && !walletCfg.frozen && walletCfg.mode !== 'gateway_only'
  const pricePaise     = finalPricePaise
  const walletBalance  = walletApplies ? await getWalletBalance(ctx.workspaceUid) : 0
  const spendablePaise = Math.max(0, walletBalance - walletCfg.minimumRequiredBalancePaise)
  const walletUsePaise = Math.max(0, Math.min(spendablePaise, pricePaise))
  const remainderPaise = pricePaise - walletUsePaise

  // Persist the PENDING order carrying the coupon accounting so /checkout/confirm
  // reads the authoritative discount (razorpayOrderId is null when remainder = 0).
  const persistCreatedOrder = async (razorpayOrderId: string | null): Promise<void> => {
    const nowTs = FieldValue.serverTimestamp() as unknown as LicenseOrderDoc['createdAt']
    const createdOrder: LicenseOrderDoc = {
      orderId:             `lic_${eventId}`,
      eventId,
      organizerUid:        ctx.workspaceUid,
      tier:                request.tier,
      fromTier:            null,
      purpose:             'purchase',
      amountPaise:         finalPricePaise,     // FINAL charged (keeps revenue aggregates correct)
      currency:            'INR',
      status:              'created',
      razorpayOrderId,
      razorpayPaymentId:   null,
      razorpayAmountPaise: remainderPaise,
      createdAt:           nowTs,
      updatedAt:           nowTs,
      paidAt:              null,
      ...(couponFields ? {
        couponCode:         couponFields.couponCode,
        campaign:           couponFields.campaign || null,
        originalPricePaise: couponFields.originalPricePaise,
        discountPaise:      couponFields.discountPaise,
        finalPricePaise:    couponFields.finalPricePaise,
        couponSnapshot:     couponFields.couponSnapshot,
      } : {}),
    }
    await adminDb.collection(LICENSE_ORDERS_COLLECTION).doc(`lic_${eventId}`).set(createdOrder)
  }

  // Wallet (and/or a coupon) fully covers the price → NO Razorpay. Persist the order
  // when a coupon was applied so confirm has the discount; the client then calls
  // /checkout/confirm (remainder = 0) — the SAME confirm flow, no special path.
  if (remainderPaise <= 0) {
    if (couponFields) await persistCreatedOrder(null)
    return NextResponse.json({
      ok: true, status: 'created', receipt: prepared.receipt,
      pricePaise, walletUsePaise, remainderPaise: 0, checkout: null,
      ...(couponFields ? { originalPricePaise: couponFields.originalPricePaise, discountPaise: couponFields.discountPaise, couponCode } : {}),
    }, { status: 200, headers: { 'Cache-Control': 'no-store' } })
  }

  // Remainder > 0 → create a Razorpay order for the remainder only.
  try {
    const razorpayOrderId = await createLicenseRazorpayOrder({
      eventId, organizerUid: ctx.workspaceUid, tier: request.tier, amountPaise: remainderPaise,
    })
    await persistCreatedOrder(razorpayOrderId)
    return NextResponse.json({
      ok: true, status: 'created',
      receipt:  { ...prepared.receipt, razorpayOrderId },
      checkout: { provider: 'razorpay', razorpayOrderId, amountPaise: remainderPaise, currency: 'INR', keyId: RAZORPAY_KEY_ID },
      pricePaise, walletUsePaise, remainderPaise,
      ...(couponFields ? { originalPricePaise: couponFields.originalPricePaise, discountPaise: couponFields.discountPaise, couponCode } : {}),
    }, { status: 200, headers: { 'Cache-Control': 'no-store' } })
  } catch {
    const failure: PurchaseLicenseResponse = {
      ok: false, status: 'failed', failureReason: 'unknown',
      message: 'Failed to create payment order',
    }
    return NextResponse.json(failure, { status: 502, headers: { 'Cache-Control': 'no-store' } })
  }
}
