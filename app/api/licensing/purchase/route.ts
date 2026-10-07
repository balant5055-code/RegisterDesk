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
import { scheduleServicePurchaseNotification } from '@/lib/notifications/servicePurchase'
import { FieldValue }          from 'firebase-admin/firestore'
import { checkPublishAgreement, isPaidEventPricing, AGREEMENT_REQUIRED_MESSAGE } from '@/lib/legal/organizerAgreement'
import { checkDraftCommerceOwnership, DRAFT_COMMERCE_FORBIDDEN_MESSAGE } from '@/lib/licensing/draftOwnership'
import { authorizeWorkspace } from '@/lib/team/workspace'
import { getEventBySlug }      from '@/lib/firebase/firestore/events'
import { adminDb }             from '@/lib/firebase/admin'
import { razorpay, RAZORPAY_KEY_ID } from '@/lib/razorpay/client'
import { captureFinancialError } from '@/lib/monitoring/sentry'
import { createEventLicenseService, type LicensePreparationContext } from '@/lib/licensing/service'
import {
  EVENT_LICENSES_COLLECTION, LICENSE_ORDERS_COLLECTION, licenseOrderConverter,
  capacityChargeSnapshot, type LicenseOrderDoc, type CapacityChargeSnapshot,
} from '@/lib/licensing/schema'
import { calculateActivationQuote } from '@/lib/licensing/capacityPricing'
import { getEventCommercialTerms }  from '@/lib/licensing/resolveCommercialTerms'
import { CURRENT_LICENSE_VERSION, isValidTierForVersion, defaultLicenseTierForVersion, type AnyEventLicenseTier } from '@/lib/licensing/eventLicense'
import { getEffectiveDefinitionForVersion } from '@/lib/licensing/resolveCatalog'
import { activateLicenseOrder, holdExhaustedCouponRemainder, holdPhotoCapacityExceeded } from '@/lib/licensing/finalizeLicensePurchase'
import {
  getLicenseCoupon, getLicenseCouponsConfig, countOrganizerCouponRedemptions,
  validateLicenseCoupon, normalizeCouponCode, type LicenseCouponSnapshot, COUPON_USAGE_UNVERIFIED_MESSAGE,
} from '@/lib/licensing/coupons'
import { decideCreatedOrderReuse } from '@/lib/licensing/existingOrderDecision'
import { orderListPricePaise, PHOTO_CAPACITY_HELD_MESSAGE } from '@/lib/licensing/finalizeLicensePurchase'
import { supersededActivationOrderId, RAZORPAY_ORDER_ID_RE } from '@/lib/licensing/manualRefundHold'
import {
  SERVICE_KINDS, EMPTY_SELECTION, parseServiceSelection, validateServiceQuantity, priceServiceItem, sumServiceItems, withMediaBaseCap,
  type ServiceChargeItem, type ServiceSelection,
} from '@/lib/licensing/serviceAllowances'
import { getServiceAllowancesConfig } from '@/lib/licensing/serviceAllowanceConfig'
import { readDraftCoverage, purchaseAddon, quoteAddon } from '@/lib/licensing/draftCommerce'
import { mediaBasePhotoCap } from '@/lib/licensing/mediaAllowance'
import { readEventPhotoLedger, checkPhotoSelection } from '@/lib/licensing/photoCapacityServer'

/**
 * RD-EVENT-COMMERCE-03 · STALE-QUOTE GUARD. The page sends the total it DISPLAYED. It is never
 * used as a price — only compared with the server's own figure. A mismatch (rates changed, a
 * coupon expired, an add-on was already paid elsewhere) is refused before any order is created,
 * so an organizer can never be charged an amount other than the one they saw.
 */
function staleQuote(expected: unknown, actualPaise: number): NextResponse | null {
  if (expected === undefined || expected === null) return null
  if (typeof expected !== 'number' || !Number.isInteger(expected) || expected !== actualPaise) {
    return NextResponse.json({
      ok: false, status: 'failed', failureReason: 'quote_changed', code: 'QUOTE_CHANGED', currentTotalPaise: actualPaise,
      message: 'The price changed since it was shown. Review the updated total and try again — nothing was charged.',
    }, { status: 409, headers: { 'Cache-Control': 'no-store' } })
  }
  return null
}
import type { PurchaseLicenseRequest, PurchaseLicenseResponse, PurchaseFailureReason } from '@/lib/licensing/purchase'
import type { LicenseRepositories } from '@/lib/licensing/repository'
import { settleCapturedActivation, findCapturedLicensePayment } from '@/lib/licensing/activationSelfHeal'
import { eventSlugTakenByOther } from '@/lib/events/slugAvailability'

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

/** Read the current license tier for an event (null when unlicensed). Read-only.
 *  RD-LICENSE-GA-02: a license DOC carries a `version` — validate its tier against that
 *  stored version (V1 or V2), so a historical V1 license and a future V2 one both resolve. */
async function readCurrentLicenseTier(eventId: string): Promise<AnyEventLicenseTier | null> {
  const snap = await adminDb.collection(EVENT_LICENSES_COLLECTION).doc(eventId).get()
  if (!snap.exists) return null
  const data = snap.data() as { tier?: unknown; version?: unknown }
  const version = typeof data.version === 'number' && data.version >= 1 ? data.version : 1
  return isValidTierForVersion(data.tier, version) ? data.tier : null
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
  tier:         AnyEventLicenseTier
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

// RD-CE-FIX H4 — CaptureLookup / findCapturedLicensePayment moved to lib/licensing/activationSelfHeal
// (shared with publish). Behaviour unchanged.

/** RD-M3 — the ONE answer when an earlier payment's status cannot be established: change nothing. */
const paymentStatusUnconfirmed = () => NextResponse.json({
  ok: false, status: 'failed', failureReason: 'payment_processing',
  message: 'We couldn’t confirm the status of your earlier payment, so nothing was changed. Please try again in a moment — you won’t be charged twice.',
}, { status: 409, headers: { 'Cache-Control': 'no-store' } })

export async function POST(req: NextRequest): Promise<NextResponse> {
  // RD-CE-FIX M5 · the same gate as the rest of licensing (capacity/*, checkout/confirm): verified
  // token, the workspace it acts for, suspension of caller OR owner, and the `events` permission —
  // a check-in-only or finance member, or a suspended workspace, cannot buy or read licences here.
  const authz = await authorizeWorkspace(req, 'events')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })

  let body: { eventId?: unknown; tier?: unknown; couponCode?: unknown; capacity?: unknown; services?: unknown; expectedTotalPaise?: unknown; agreement?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const eventId = typeof body.eventId === 'string' ? body.eventId.trim() : ''
  if (!eventId) return NextResponse.json({ error: 'eventId is required' }, { status: 400 })
  // EA-4 S2: optional license coupon (empty ⇒ no coupon; flow unchanged).
  const couponCode = typeof body.couponCode === 'string' && body.couponCode.trim() ? normalizeCouponCode(body.couponCode) : ''
  // ══ RD-CAPACITY-01 · CAPACITY is the commercial input; tier is legacy ═══════════
  //
  // A request carrying `capacity` is priced by the capacity-based model: the amount comes
  // from the server's own quote against the event's authoritative commercial terms, and
  // NOTHING about the money is taken from the request. The client may send only the
  // capacity — not the rate, not the free allowance, not the GST, not the total. A request
  // without `capacity` keeps the historical tier path, unchanged, so events mid-purchase
  // during the migration and any older client continue to work.
  //
  // `capacity` is read RAW (`unknown`) and handed to the validator. It is never coerced:
  // `Number('437abc')` is NaN and `Number(true)` is 1, and either would become a money
  // amount. See lib/licensing/capacityPricing.validateCapacity.
  const capacityRequested = 'capacity' in body && body.capacity !== undefined && body.capacity !== null
    ? body.capacity
    : null
  const isCapacityPurchase = capacityRequested !== null

  // ══ RD-EVENT-COMMERCE-01 · X1 — NEW TIER PURCHASES ARE CLOSED ═════════════════════
  // A request without `capacity` used to sell a licence TIER at its catalogue price. No UI has
  // sent one since RD-CAPACITY-01, but the route still honoured it, and an organizer can set
  // `licenseTier` / delete `registrationCapacity` on their own draft (the draft rules allow
  // it). Together that bought the publish route's grandfathered tier path: Enterprise at its
  // tier price ⇒ UNLIMITED capacity, against ≈₹3.5 lakh for the 200,000 cap under the
  // capacity model. New orders must now name a capacity. Tier orders created BEFORE this
  // change still settle unchanged through /checkout/confirm and the webhook backstop — only
  // minting a new one is refused.
  if (!isCapacityPurchase) {
    return NextResponse.json(
      { ok: false, status: 'failed', failureReason: 'capacity_required', error: 'A registration capacity is required to activate an event.' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    )
  }
  // The tier carries no price and no limits under the capacity model — it is stamped on the
  // order purely so every historical reader (and the schema validator) keeps working. It is
  // ALWAYS the version's default: a client-sent `tier` is ignored, so a capacity order can
  // never carry a paid-tier stamp that tier-derived readers would honour.
  const requestedTier: string = defaultLicenseTierForVersion(CURRENT_LICENSE_VERSION)

  // ══ RD-EVENT-COMMERCE-02 · PREPAID SERVICE QUANTITIES ═════════════════════════════
  // Quantities only — never a price. Each is validated RAW against the Business
  // Configuration catalog; a service whose price, GST, range or exhaustion policy is not
  // configured cannot be bought (fail closed), and 0 always means "none".
  const parsedServices = parseServiceSelection(body.services)
  if (!parsedServices.ok) {
    return NextResponse.json({ ok: false, status: 'failed', failureReason: 'invalid_services', message: parsedServices.message }, { status: 400, headers: { 'Cache-Control': 'no-store' } })
  }
  const servicesRequested: ServiceSelection = parsedServices.selection
  const catalog = await getServiceAllowancesConfig()
  for (const k of SERVICE_KINDS) {
    const check = validateServiceQuantity(k, servicesRequested[k], catalog[k])
    if (!check.ok) {
      return NextResponse.json({ ok: false, status: 'failed', failureReason: 'invalid_services', code: check.code, service: k, message: check.message }, { status: 422, headers: { 'Cache-Control': 'no-store' } })
    }
  }
  console.info(`[license] payment started · eventId=${eventId} ${isCapacityPurchase ? `capacity=${String(capacityRequested)}` : `tier=${requestedTier}`}`)

  const ctx = authz
  // RD-PHOTO-01 — photo units are the event's PAID capacity (no free base, recorded as 0 on the
  // line) and the event's total may never exceed 3,000. The selection here is the draft's TOTAL.
  const mediaBase = servicesRequested.media > 0 ? await mediaBasePhotoCap({ organizerUid: ctx.workspaceUid, draftId: eventId }) : null
  if (servicesRequested.media > 0) {
    const fits = checkPhotoSelection('draft', servicesRequested.media, await readEventPhotoLedger(ctx.workspaceUid, eventId))
    if (!fits.ok) {
      return NextResponse.json({ ok: false, status: 'failed', failureReason: 'invalid_services', code: fits.code, service: 'media', message: fits.message, maxAdditional: fits.maxAdditional }, { status: 422, headers: { 'Cache-Control': 'no-store' } })
    }
  }

  // Reads to build the preparation context (existence + ownership + current tier).
  // The organizer pays BEFORE submitting, so eventId may be a DRAFT id (no
  // published event yet) — accept either a published event or an owned draft.
  const event = await getEventBySlug(eventId)
  if (event && event.uid !== ctx.workspaceUid) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  let exists = event !== null
  let draftLifecycle: unknown = null
  let draftPricing: unknown = null
  let draftDetails: unknown = null
  let eventType: string | null = event && typeof (event as { eventType?: unknown }).eventType === 'string'
    ? ((event as { eventType?: string }).eventType ?? null) : null
  if (!exists) {
    const draftSnap = await adminDb.doc(`users/${ctx.workspaceUid}/eventDrafts/${eventId}`).get()
    exists = draftSnap.exists
    const dd = draftSnap.exists ? (draftSnap.data() as Record<string, unknown>) : null
    if (typeof dd?.eventType === 'string') eventType = dd.eventType
    draftLifecycle = dd?.status ?? null
    draftPricing = dd?.pricing ?? null
    draftDetails = dd?.eventDetails ?? null
  }
  // RD-EVENT-COMMERCE-02 · LIFECYCLE. Pre-publish commerce is for DRAFTS only. Once an event is
  // submitted (the server writes 'published' or 'pending_review' onto the draft; clients cannot
  // write it) no new activation or add-on order may be created here — capacity then changes only
  // through the dashboard capacity-change flow.
  if (event || (draftLifecycle !== null && draftLifecycle !== 'draft')) {
    return NextResponse.json({
      ok: false, status: 'failed', failureReason: 'already_licensed',
      message: 'This event has already been submitted. Change its capacity from the event dashboard.',
    }, { status: 409, headers: { 'Cache-Control': 'no-store' } })
  }
  // RD-HIGH-2 — every order / ledger / live event already under this draft id must be this
  // workspace's. Without this, a draft created under another organizer's (public) draft id could
  // supersede or self-heal THEIR order, stamp itself as owner and merge units into their ledger.
  const ownership = await checkDraftCommerceOwnership(eventId, ctx.workspaceUid)
  if (!ownership.ok) {
    console.warn(`[license] refused · eventId=${eventId} reason=FORBIDDEN record=${ownership.record} verdict=${ownership.verdict}`)
    return NextResponse.json({
      ok: false, status: 'failed', failureReason: 'forbidden', code: 'FORBIDDEN', message: DRAFT_COMMERCE_FORBIDDEN_MESSAGE,
    }, { status: 403, headers: { 'Cache-Control': 'no-store' } })
  }
  // RD-EVENT-COMMERCE-05F — "Pay & Publish Event" starts HERE, so the Publish Agreement is
  // checked before any order (Razorpay or otherwise) can exist. The same items the publish route
  // checks; the paid/free decision comes from the STORED draft, never the request.
  if (!checkPublishAgreement(body.agreement, { paidEvent: isPaidEventPricing(draftPricing) }).ok) {
    return NextResponse.json({
      ok: false, status: 'failed', failureReason: 'agreement_required', code: 'AGREEMENT_REQUIRED',
      message: AGREEMENT_REQUIRED_MESSAGE,
    }, { status: 422, headers: { 'Cache-Control': 'no-store' } })
  }
  // RD-CE-FIX (slug timing) — the public URL this draft will publish under is checked BEFORE any
  // payment: a URL already used by another event used to surface only at publish, after charging.
  if (!event) {
    const taken = await eventSlugTakenByOther(eventId, draftDetails)
    if (taken) {
      return NextResponse.json({
        ok: false, status: 'failed', failureReason: 'slug_conflict', code: 'SLUG_CONFLICT',
        message: `The event URL “${taken}” is already used by another event. Choose a different URL in Event Details › SEO before paying — nothing was charged.`,
      }, { status: 409, headers: { 'Cache-Control': 'no-store' } })
    }
  }
  const currentTier = event ? await readCurrentLicenseTier(eventId) : null

  const request: PurchaseLicenseRequest = {
    eventId,
    organizerUid: ctx.workspaceUid,
    tier:         requestedTier as AnyEventLicenseTier,   // validated inside the service
    method:       'razorpay',
  }

  // ── The authoritative amount ──────────────────────────────────────────────────
  // Capacity model: quote it here, on the server, from the event's effective commercial
  // terms (global defaults ⊕ any per-event admin override). A rejected capacity — NaN,
  // decimal, zero, negative, or above the configured maximum — fails with its own reason
  // rather than falling through to a tier price.
  let capacitySnapshot: CapacityChargeSnapshot | null = null
  let quotedPricePaise: number | undefined
  if (isCapacityPurchase) {
    const terms  = await getEventCommercialTerms(eventId)
    const quoted = calculateActivationQuote({ capacity: capacityRequested, terms })
    if (!quoted.ok) {
      return NextResponse.json(
        { ok: false, status: 'failed', failureReason: 'invalid_capacity', code: quoted.code, message: quoted.message },
        { status: 422, headers: { 'Cache-Control': 'no-store' } },
      )
    }
    capacitySnapshot = capacityChargeSnapshot(quoted.quote)
    quotedPricePaise = quoted.quote.totalPaise
    console.info(`[license] capacity quote · eventId=${eventId} capacity=${quoted.quote.capacity} chargeable=${quoted.quote.chargeableCapacity} base=${quoted.quote.basePaise} gst=${quoted.quote.gstPaise} total=${quoted.quote.totalPaise}`)
  }

  // RD-LEGACY-01 — no tier price is looked up: a request without a capacity was refused above
  // (capacity_required), so the price is ALWAYS the server's capacity quote.
  const context: LicensePreparationContext = {
    eventExists: exists,
    currentTier,
    pricePaise: quotedPricePaise,
  }

  const prepared = createEventLicenseService(stubRepositories).purchaseLicense(request, context)

  // Validation / preparation failure → mapped HTTP status.
  if (!prepared.ok) {
    return NextResponse.json(prepared, {
      status:  statusForFailure(prepared.failureReason),
      headers: { 'Cache-Control': 'no-store' },
    })
  }

  // RD-EVENT-COMMERCE-02 — the service lines for a FIRST purchase are the full selection.
  const requestedCapacity = capacitySnapshot?.capacity ?? 0
  // The media line records the base limit it sits on top of (withMediaBaseCap) — the Wallet's refund basis.
  const serviceItems: ServiceChargeItem[] = withMediaBaseCap(SERVICE_KINDS
    .filter(k => servicesRequested[k] > 0)
    .map(k => priceServiceItem(k, servicesRequested[k], catalog[k])), mediaBase)
  const servicesTotalPaise = sumServiceItems(serviceItems)
  const activationBasePaise = prepared.checkout?.amountPaise ?? 0

  // ── A PAID activation already exists → coverage / add-on (never a second activation) ──
  // Checked BEFORE the zero-price shortcut: a draft that paid for 437 and now asks for 100
  // is covered, and one that asks for more services must buy the difference.
  {
    const licSnap = await adminDb.collection(LICENSE_ORDERS_COLLECTION).doc(`lic_${eventId}`).withConverter(licenseOrderConverter).get()
    const lic = licSnap.exists ? licSnap.data() : undefined
    if (lic?.status === 'paid' && lic.organizerUid === ctx.workspaceUid && lic.commercialModel === 'capacity') {
      const coverage = await readDraftCoverage(eventId, ctx.workspaceUid)
      const aq = quoteAddon({ coverage, capacity: requestedCapacity, services: servicesRequested, catalog })
      if (aq.ok && aq.totalPaise > 0) {
        const stale = staleQuote(body.expectedTotalPaise, aq.totalPaise)
        if (stale) return stale
      }
      const addon = await purchaseAddon({
        draftId: eventId, organizerUid: ctx.workspaceUid, tier: request.tier,
        capacity: requestedCapacity, services: servicesRequested, catalog, coverage, mediaBaseCap: mediaBase,
      })
      if (addon.kind === 'covered') {
        return NextResponse.json({ ok: true, status: 'paid', alreadyPaid: true, receipt: prepared.receipt, pricePaise: 0, checkout: null }, { status: 200, headers: { 'Cache-Control': 'no-store' } })
      }
      if (addon.kind === 'processing') {
        return NextResponse.json({ ok: false, status: 'failed', failureReason: 'payment_processing', message: 'A payment for this event is already being processed. Refresh the status in a moment.' }, { status: 409, headers: { 'Cache-Control': 'no-store' } })
      }
      if (addon.kind === 'error') {
        return NextResponse.json({ ok: false, status: 'failed', failureReason: 'invalid_capacity', message: addon.message }, { status: 422, headers: { 'Cache-Control': 'no-store' } })
      }
      console.info(`[license] add-on order ${addon.reused ? 'reused' : 'created'} · eventId=${eventId} order=${addon.orderId} amount=${addon.amountPaise}`)
      return NextResponse.json({
        ok: true, status: 'created', orderId: addon.orderId, purpose: 'addon',
        receipt: { ...prepared.receipt, razorpayOrderId: addon.razorpayOrderId },
        checkout: { provider: 'razorpay', razorpayOrderId: addon.razorpayOrderId, amountPaise: addon.amountPaise, currency: 'INR', keyId: RAZORPAY_KEY_ID },
        pricePaise: addon.amountPaise,
        capacityCharge: addon.order.capacityChange ?? null, serviceItems: addon.order.serviceItems ?? [],
      }, { status: 200, headers: { 'Cache-Control': 'no-store' } })
    }
  }

  // Zero-price → immediate success and NO order of any kind.
  //
  // RD-CAPACITY-01 · a capacity at or below the free allowance costs ₹0, and a ₹0 Razorpay
  // order is not payable — creating one would leave an unpayable order the organizer could
  // never clear. The publish step re-quotes the capacity itself and requires a paid order
  // only when its own quote says payment is due, so nothing needs to be persisted here.
  // The quote is returned so the UI can show "Activation fee ₹0" truthfully.
  if (activationBasePaise <= 0 && servicesTotalPaise <= 0) {
    // RD-CE-FIX H4 — an earlier checkout for this draft may already have been PAID. Settle it before
    // answering "nothing to pay": a captured payment is activated (the organizer gets what they paid
    // for); an unknown status changes nothing and asks for a retry.
    if (await settleCapturedActivation(eventId, ctx.workspaceUid) === 'unknown') return paymentStatusUnconfirmed()
    return NextResponse.json(
      {
        ...prepared, pricePaise: 0,
        ...(capacitySnapshot ? { capacity: capacitySnapshot.capacity, capacityCharge: capacitySnapshot } : {}),
      },
      { status: 200, headers: { 'Cache-Control': 'no-store' } },
    )
  }

  // ══ EA-4 S2 · LICENSE COUPON — resolved BEFORE the existing-order guard ═══════
  //
  // This block used to sit AFTER the retry/reuse guard below. That ordering was the bug:
  // an organizer who reached checkout once (leaving a `created` order for the full price
  // with a Razorpay order id) and THEN applied a coupon hit the reuse branch first. The
  // route returned the persisted full-price remainder and `validateLicenseCoupon` was
  // never called — so the UI showed ₹0 while Razorpay was asked for the full amount.
  //
  // Resolving the coupon first means the CURRENT authoritative price is known before we
  // decide whether a persisted order may still be reused. Nothing about the coupon engine,
  // its validation rules, or the discount maths changes — only when it runs.
  // The coupon discounts the ACTIVATION only. Prepaid service lines are never discounted.
  const basePricePaise = activationBasePaise
  if (couponCode && basePricePaise <= 0) {
    return NextResponse.json({ ok: false, status: 'failed', failureReason: 'invalid_coupon', message: 'Coupons apply to the activation fee only, and this capacity has no activation fee.' }, { status: 422, headers: { 'Cache-Control': 'no-store' } })
  }
  let finalPricePaise  = basePricePaise
  let couponFields: {
    couponCode: string; campaign: string; originalPricePaise: number
    discountPaise: number; finalPricePaise: number; couponSnapshot: LicenseCouponSnapshot
  } | null = null
  if (couponCode) {
    const [coupon, cfg, usage] = await Promise.all([
      getLicenseCoupon(couponCode),
      getLicenseCouponsConfig(),
      countOrganizerCouponRedemptions(couponCode, ctx.workspaceUid),
    ])
    // RD-M5 D2 — usage that cannot be verified is never treated as zero. Refused BEFORE the
    // existing-order guard, so nothing is created, replaced, archived or reserved.
    if (!usage.ok) {
      return NextResponse.json(
        { ok: false, status: 'failed', failureReason: 'coupon_usage_unverified', message: COUPON_USAGE_UNVERIFIED_MESSAGE },
        { status: 503, headers: { 'Cache-Control': 'no-store' } },
      )
    }
    const cres = validateLicenseCoupon(coupon, {
      tier: request.tier, eventType, pricePaise: basePricePaise, organizerRedemptions: usage.count,
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
      couponCode, campaign: cres.snapshot.campaign, originalPricePaise: basePricePaise + servicesTotalPaise,
      discountPaise: cres.discountPaise, finalPricePaise: finalPricePaise + servicesTotalPaise, couponSnapshot: cres.snapshot,
    }
  }
  // The WHOLE amount payable in this order: (discounted) activation + every service line.
  finalPricePaise += servicesTotalPaise
  const requestedSelection = { capacity: requestedCapacity, services: { ...servicesRequested } }
  {
    const stale = staleQuote(body.expectedTotalPaise, finalPricePaise)
    if (stale) return stale
  }

  // ── Retry / double-charge guard (Phase 7) ────────────────────────────────────
  // If a PAID license order already exists for this draft (payment succeeded on a
  // previous attempt but the publish step failed), NEVER create a second Razorpay
  // order. Same tier → allow a FREE retry (the client skips checkout and re-runs
  // publish, which reads the paid order). Different tier → refuse rather than
  // silently double-charge.
  // True once we decide an unpaid persisted order is stale and must be rewritten. It
  // forces the zero-remainder branch below to persist even with no coupon, so a
  // superseded order can never keep pointing at its abandoned Razorpay order id.
  let supersededExisting = false

  const existingOrderSnap = await adminDb.collection(LICENSE_ORDERS_COLLECTION).doc(`lic_${eventId}`).withConverter(licenseOrderConverter).get()
  if (existingOrderSnap.exists) {
    const existing = existingOrderSnap.data() as LicenseOrderDoc | undefined

    // GA-8 P1-1 self-heal: a `created` order that already has a CAPTURED Razorpay
    // payment means a prior attempt paid but /checkout/confirm never ran. Activate it
    // now (idempotent, shared with confirm + webhook) BEFORE minting anything, so we
    // never create a SECOND Razorpay order for an already-captured payment.
    if (existing?.status === 'created' && existing.razorpayOrderId) {
      const remainder = Math.max(0, existing.razorpayAmountPaise ?? 0)
      const lookup = await findCapturedLicensePayment(existing.razorpayOrderId, remainder)
      // RD-M3 — status unknown, or money authorised but not captured: the existing order is left
      // exactly as it is (no activation, no replacement, no new Razorpay order). A retry once the
      // status is knowable takes the normal path; an authorised payment is activated by the
      // payment.captured webhook when Razorpay captures it.
      if (lookup.state === 'unknown' || (lookup.state === 'captured' && lookup.paymentStatus !== 'captured')) {
        console.warn(`[license] purchase → earlier payment status not confirmable (${lookup.state === 'unknown' ? 'lookup failed' : 'authorised, not captured'}); nothing changed · eventId=${eventId} order=${existing.razorpayOrderId}`)
        return paymentStatusUnconfirmed()
      }
      // Activation only for an AFFIRMATIVELY captured payment.
      const capturedPaymentId = lookup.state === 'captured' ? lookup.paymentId : null
      // `existing` is a stored license ORDER (transient current-version artifact, no
      // version field) → resolve its tier against CURRENT_LICENSE_VERSION.
      const rdef = isValidTierForVersion(existing.tier, CURRENT_LICENSE_VERSION)
        ? await getEffectiveDefinitionForVersion(existing.tier, CURRENT_LICENSE_VERSION) : null
      if (capturedPaymentId && rdef) {
        // RD-CAPACITY-01 · a capacity order's price is the total on its OWN snapshot, not
        // a tier price. Getting this wrong here would settle the payment against the free
        // tier's ₹0 and record a ₹0 activation for money that was actually captured.
        const healBasePaise = orderListPricePaise(existing, rdef.licensePricePaise)
        const act = await activateLicenseOrder({
          eventId, uid: ctx.workspaceUid, tier: existing.tier, licenseName: rdef.name,
          basePricePaise: healBasePaise, persisted: existing,
          razorpayOrderId: existing.razorpayOrderId, razorpayPaymentId: capturedPaymentId,
        })
        // RD-M4 D1 — the order was replaced while this request was self-healing: never activate the
        // stale payment; answer exactly as an unconfirmable status (M3). Nothing was written.
        if (act.kind === 'superseded') return paymentStatusUnconfirmed()
        if (act.kind === 'photo_capacity_exceeded') {
          await holdPhotoCapacityExceeded({ eventId, orderId: existing.razorpayOrderId, paymentId: capturedPaymentId, amountPaise: remainder })
          return NextResponse.json({ ok: false, status: 'failed', failureReason: 'photo_capacity_exceeded', message: PHOTO_CAPACITY_HELD_MESSAGE }, { status: 409, headers: { 'Cache-Control': 'no-store' } })
        }
        if (act.kind === 'coupon_exhausted') {
          await holdExhaustedCouponRemainder({ eventId, orderId: existing.razorpayOrderId, paymentId: capturedPaymentId, remainderPaise: remainder, persisted: existing })
          return NextResponse.json({
            ok: false, status: 'failed', failureReason: 'coupon_exhausted',
            message: 'This coupon reached its usage limit, so the licence was not activated. If you were charged, the payment is on hold for review by the RegisterDesk team — nothing further will be charged.',
          }, { status: 409, headers: { 'Cache-Control': 'no-store' } })
        }
        if (act.kind === 'ok' || act.kind === 'already') {
          // Wallet-02 — purchase notifications, once per order (claim-deduplicated; never throws).
          scheduleServicePurchaseNotification(`lic_${eventId}`)
          console.info(`[license] purchase self-healed captured order · eventId=${eventId} tier=${existing.tier}`)
          existing.status = 'paid'   // fall through to the paid-order retry logic below
        }
        if (act.kind === 'underpaid') {
          // RD-LICENSE-PAYMENT-01 · a pre-change order whose Razorpay amount was only part of
          // the price (the rest was planned from the communication wallet). It is never
          // activated at a discount; the captured payment is left for operator review, and
          // the drift guard below refuses to mint over it.
          captureFinancialError('license_underpaid_order', { scope: 'license.underpaid_selfheal', eventId, orderId: existing.razorpayOrderId, paymentId: capturedPaymentId, amount: remainder })
          console.warn(`[license] purchase self-heal refused — order does not cover its full price · eventId=${eventId} razorpay=${remainder} price=${existing.amountPaise}`)
        }
      }
    }

    if (existing?.status === 'paid') {
      // RD-CAPACITY-01 · what counts as "the same purchase" depends on the model. A
      // capacity order is the same purchase when it bought AT LEAST the capacity now being
      // asked for — the organizer already paid for that much, so a retry is free. Asking
      // for MORE than was paid for is not a retry: it is a capacity increase, which has its
      // own priced operation and must not be granted here for nothing.
      const paidCapacity = existing.capacityChange?.capacity ?? null
      // RD-EVENT-COMMERCE-02 — and it must also have bought at least the requested service units.
      const paidServices = (k: (typeof SERVICE_KINDS)[number]) => (existing.serviceItems ?? []).filter(i => i.service === k).reduce((n, i) => n + i.quantity, 0)
      const servicesCovered = SERVICE_KINDS.every(k => paidServices(k) >= servicesRequested[k])
      const samePurchase = isCapacityPurchase && paidCapacity !== null
        ? paidCapacity >= (capacitySnapshot?.capacity ?? Number.POSITIVE_INFINITY) && servicesCovered
        : existing.tier === request.tier
      if (samePurchase) {
        console.info(`[license] purchase → already paid, free retry · eventId=${eventId} tier=${request.tier}`)
        return NextResponse.json({
          ok: true, status: 'paid', alreadyPaid: true, receipt: prepared.receipt,
          pricePaise: prepared.checkout?.amountPaise ?? 0, checkout: null,
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

      // ══ PRICING/COUPON DRIFT — reuse only when the persisted order still matches ══
      //
      // Reuse is correct ONLY while the persisted order still represents what the
      // organizer is asking to buy. Applying a coupon after reaching checkout once
      // changes the authoritative price, and blindly reusing the old order is exactly
      // the bug this sprint fixes: the UI showed ₹0 while Razorpay was handed the full
      // amount, because the persisted remainder was returned unchanged.
      //
      // `amountPaise` is the FINAL charged amount on the persisted order, so comparing
      // it against the freshly-computed `finalPricePaise` (plus the coupon identity)
      // detects both directions of drift: a coupon newly applied, changed, or removed.
      const requestedCoupon = couponCode || null
      const decision = decideCreatedOrderReuse({
        persistedAmountPaise:     existing.amountPaise,
        persistedCouponCode:      existing.couponCode ?? null,
        requestedFinalPricePaise: finalPricePaise,
        requestedCouponCode:      requestedCoupon,
      })
      // RD-LICENSE-PAYMENT-01 · Razorpay is asked for the WHOLE price. A persisted order whose
      // Razorpay amount is only part of it was created when activation drew a share from the
      // communication wallet; reusing it would hand the organizer a checkout for less than
      // the price. It is superseded exactly like a price drift (same captured-payment guard).
      const coversFullPrice = remainder === existing.amountPaise
      // RD-EVENT-COMMERCE-02 — the persisted order must be for the SAME selection, not just the
      // same amount: an organizer must never pay for one selection and receive another.
      const persistedSel = existing.selection ?? { capacity: existing.capacityChange?.capacity ?? -1, services: { ...EMPTY_SELECTION } }
      const sameSelection = persistedSel.capacity === requestedSelection.capacity
        && SERVICE_KINDS.every(k => (persistedSel.services?.[k] ?? 0) === requestedSelection.services[k])

      if (decision === 'supersede' || !coversFullPrice || !sameSelection) {
        // Before superseding, make absolutely sure the old payable order has NOT been
        // paid. `findCapturedLicensePayment` is the SAME helper the self-heal above
        // uses. If money was captured against it, superseding would orphan a real
        // payment — so we refuse and hand back the existing order untouched, leaving
        // the established self-heal / confirm / webhook paths to finish it.
        const captured = await findCapturedLicensePayment(existing.razorpayOrderId, remainder)
        // RD-M3 — replace ONLY on an affirmative "nothing captured". An unknown status changes nothing:
        // no replacement order, no F2A archive, no hold.
        if (captured.state === 'unknown') {
          console.warn(`[license] purchase → capture status UNKNOWN; NOT superseding · eventId=${eventId} order=${existing.razorpayOrderId}`)
          return paymentStatusUnconfirmed()
        }
        if (captured.state === 'captured') {
          console.warn(`[license] purchase → coupon/price drift but a CAPTURED payment exists; NOT superseding · eventId=${eventId} order=${existing.razorpayOrderId}`)
          return NextResponse.json({
            ok: false, status: 'failed', failureReason: 'already_licensed',
            message: 'A payment for this license is already being processed. Refresh the page — if it is not resolved shortly, contact support.',
          }, { status: 409, headers: { 'Cache-Control': 'no-store' } })
        }

        // Genuinely unpaid → the old pending order may be superseded. We fall THROUGH
        // to the normal pricing path below, which rewrites this same
        // `licenseOrders/lic_{eventId}` document via `persistCreatedOrder`. That write
        // sets `razorpayOrderId` to the new value — or to NULL when the coupon brings
        // the remainder to zero — so the abandoned Razorpay order can never again be
        // the authoritative one:
        //   • webhook recovery looks the order up by `.where('razorpayOrderId','==',…)`,
        //     which no longer matches, so a late payment cannot activate this licence;
        //   • confirm binds to `persisted.razorpayOrderId` (`deriveLicenseCharge`), which
        //     is likewise no longer the stale id.
        // No new status is introduced: the same document remains the single authoritative
        // order, which is what the existing schema supports.
        supersededExisting = true
        console.info(`[license] purchase → superseding unpaid order (pricing/coupon drift) · eventId=${eventId} was=${existing.amountPaise} now=${finalPricePaise} coupon=${requestedCoupon ?? 'none'} staleOrder=${existing.razorpayOrderId}`)
      } else {
      console.info(`[license] purchase → reuse existing created order, no re-mint · eventId=${eventId} tier=${String(existing.tier)}`)
      return NextResponse.json({
        ok: true, status: 'created',
        receipt: { ...prepared.receipt, razorpayOrderId: existing.razorpayOrderId },
        checkout: remainder > 0
          ? { provider: 'razorpay', razorpayOrderId: existing.razorpayOrderId, amountPaise: remainder, currency: 'INR', keyId: RAZORPAY_KEY_ID }
          : null,
        pricePaise:     existing.amountPaise,
        ...(existing.couponCode ? {
          originalPricePaise: existing.originalPricePaise,
          discountPaise:      existing.discountPaise,
          couponCode:         existing.couponCode,
        } : {}),
      }, { status: 200, headers: { 'Cache-Control': 'no-store' } })
      }
    }
  }

  // ══ RD-LICENSE-PAYMENT-01 · RAZORPAY PAYS THE WHOLE (discounted) PRICE ══════════
  // Event activation is a Razorpay payment, full stop. The communication wallet
  // (`organizerWallets`) funds WhatsApp / bulk / SMS usage and is a separate financial
  // system: it is not read here, no share of the price is taken from it, and there is
  // no remainder — the Razorpay order is created for exactly `finalPricePaise`.
  const pricePaise = finalPricePaise

  // Persist the PENDING order carrying the coupon accounting so /checkout/confirm
  // reads the authoritative discount (razorpayOrderId is null only for a ₹0 price).
  const persistCreatedOrder = async (razorpayOrderId: string | null): Promise<'ok' | 'already_paid'> => {
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
      razorpayAmountPaise: finalPricePaise,   // the WHOLE price — never a share of it
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
      // RD-CAPACITY-01 — the immutable pricing record travels WITH the order from the
      // moment it is created, so /checkout/confirm, the webhook backstop and the publish
      // step all read the same server-computed capacity and amounts. None of them has to
      // trust a client, and none of them has to re-derive the price from configuration
      // that may have changed in the meantime.
      ...(capacitySnapshot ? { commercialModel: 'capacity' as const, capacityChange: capacitySnapshot } : {}),
      // RD-EVENT-COMMERCE-02 — the service lines, their total, and the exact selection.
      // `finalPricePaise` is always stamped when services are present so every settlement path
      // reads the combined amount from the order itself.
      ...(serviceItems.length ? { serviceItems, servicesTotalPaise, ...(couponFields ? {} : { finalPricePaise }) } : {}),
      selection: requestedSelection,
    }
    // ══ RD-F2A · the replaced activation order is ARCHIVED in the same transaction ══════════
    // Writing `lic_{eventId}` OVERWRITES the previous order. A superseded order's Razorpay order
    // stays payable, so its id, amount and snapshot are first copied to a deterministic archive doc
    // (`lic_{eventId}__sup_{itsRazorpayOrderId}`, status failed / superseded) — the late payment can
    // then be found and HELD (F2), never granted (F1). Atomic with the overwrite, so there is never a
    // moment where the old Razorpay id lives in both documents or in neither. The CURRENT document is
    // read inside the transaction, so whatever is actually being replaced is what gets archived; and
    // a document that became PAID meanwhile (a racing confirm) is never overwritten.
    const licRef = adminDb.collection(LICENSE_ORDERS_COLLECTION).doc(`lic_${eventId}`)
    return adminDb.runTransaction(async txn => {
      const curSnap = await txn.get(licRef)
      const cur = curSnap.exists ? curSnap.data() as Record<string, unknown> : undefined
      if (cur?.status === 'paid') return 'already_paid' as const
      const curRzp = typeof cur?.razorpayOrderId === 'string' ? cur.razorpayOrderId : null
      if (cur && cur.status === 'created' && curRzp && curRzp !== razorpayOrderId && RAZORPAY_ORDER_ID_RE.test(curRzp)) {
        const archiveRef = licRef.parent.doc(supersededActivationOrderId(eventId, curRzp))
        const archived = await txn.get(archiveRef)
        if (!archived.exists) {
          txn.create(archiveRef, {
            ...cur, orderId: archiveRef.id, status: 'failed', failReason: 'superseded',
            supersededFrom: `lic_${eventId}`, supersededAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
          })
        }
      }
      txn.set(licRef, createdOrder)
      return 'ok' as const
    })
  }

  // A coupon that discounts the price to ₹0 → NO Razorpay (a ₹0 order is not payable).
  // Persist the order when a coupon was applied so confirm has the discount; the client
  // then calls /checkout/confirm — the SAME confirm flow, no special path.
  //
  // RD-LICENSE-PAYMENT-01 · this branch is now reached ONLY by a ₹0 final price. The
  // E2E-02 `|| capacitySnapshot` persist existed solely for a wallet-covered capacity
  // activation, which no longer exists: a payable capacity order always goes to the
  // Razorpay branch below, which persists the order (with its capacity snapshot) BEFORE
  // checkout. A capacity at or below the free allowance returned ₹0 earlier and never
  // gets here.
  // RD-F2A — a racing confirm made the order PAID while this request was preparing its
  // replacement: nothing is overwritten and nothing new is sold for it.
  const alreadyPaidMidway = () => NextResponse.json({
    ok: false, status: 'failed', failureReason: 'already_licensed',
    message: 'A payment for this event was just completed. Refresh the page to continue — you will not be charged again.',
  }, { status: 409, headers: { 'Cache-Control': 'no-store' } })

  if (pricePaise <= 0) {
    if ((couponFields || supersededExisting) && (await persistCreatedOrder(null)) === 'already_paid') return alreadyPaidMidway()
    return NextResponse.json({
      ok: true, status: 'created', receipt: prepared.receipt,
      pricePaise, checkout: null,
      ...(couponFields ? { originalPricePaise: couponFields.originalPricePaise, discountPaise: couponFields.discountPaise, couponCode } : {}),
    }, { status: 200, headers: { 'Cache-Control': 'no-store' } })
  }

  // Price > 0 → create a Razorpay order for the FULL price, and persist the order (with
  // the capacity snapshot) before the client ever opens checkout.
  try {
    const razorpayOrderId = await createLicenseRazorpayOrder({
      eventId, organizerUid: ctx.workspaceUid, tier: request.tier, amountPaise: pricePaise,
    })
    if ((await persistCreatedOrder(razorpayOrderId)) === 'already_paid') return alreadyPaidMidway()
    return NextResponse.json({
      ok: true, status: 'created',
      receipt:  { ...prepared.receipt, razorpayOrderId },
      checkout: { provider: 'razorpay', razorpayOrderId, amountPaise: pricePaise, currency: 'INR', keyId: RAZORPAY_KEY_ID },
      pricePaise, orderId: `lic_${eventId}`, capacityCharge: capacitySnapshot, serviceItems,
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
