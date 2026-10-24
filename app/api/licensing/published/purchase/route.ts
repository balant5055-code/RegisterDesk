// POST /api/licensing/published/purchase — RD-EVENT-COMMERCE-03
//
// Buy MORE for an event that is already submitted (published or pending review), from the
// License & Services step itself — no dashboard redirect. One Razorpay payment covers:
//
//   • a capacity change      → the existing concurrency-safe capacity-change order (`cap_`),
//                              now also carrying any prepaid service lines; confirmed through
//                              /api/licensing/capacity/confirm and the webhook backstop, both
//                              of which apply capacity AND service lines in ONE transaction.
//   • services only          → a pre-publish-style add-on order (`add_`), confirmed through
//                              /api/licensing/checkout/confirm and the webhook backstop.
//
//   body  { eventId: <draftId>, capacity: <target capacity>, services: { <kind>: <ADDITIONAL units> },
//           expectedTotalPaise?: <the total the page displayed> }
//
// Quantities only. Every amount is computed here from the event's own commercial terms (capacity)
// and the Business Configuration catalog (services). Guards: workspace permission, draft ownership,
// server-written submitted status, live lifecycle, sold-count floor, per-service availability and
// range, media base cap, stale-quote, and reuse of an identical unpaid order (no duplicate orders).

import { NextRequest, NextResponse } from 'next/server'
import { checkDraftCommerceOwnership, DRAFT_COMMERCE_FORBIDDEN_MESSAGE } from '@/lib/licensing/draftOwnership'
import { authorizeWorkspace } from '@/lib/team/workspace'
import { adminDb } from '@/lib/firebase/admin'
import { RAZORPAY_KEY_ID } from '@/lib/razorpay/client'
import {
  resolveCapacityEventSlug, loadCapacityChangeContext, applyFreeCapacityChange,
  isPurchaseEligibleLifecycle, readSoldCount,
} from '@/lib/licensing/capacityChange'
import { openCapacityCheckout } from '@/lib/licensing/capacityOrderCheckout'
import { quoteCapacityChange } from '@/lib/licensing/capacityPricing'
import {
  SERVICE_KINDS, parseServiceSelection, validateServiceQuantity, priceServiceItem, sumServiceItems, withMediaBaseCap,
  selectionIsEmpty, type ServiceSelection,
} from '@/lib/licensing/serviceAllowances'
import { getServiceAllowancesConfig } from '@/lib/licensing/serviceAllowanceConfig'
import { readDraftCoverage, purchaseAddon } from '@/lib/licensing/draftCommerce'
import { mediaBasePhotoCap } from '@/lib/licensing/mediaAllowance'
import { readEventPhotoLedger, checkPhotoSelection } from '@/lib/licensing/photoCapacityServer'
import { defaultLicenseTierForVersion, CURRENT_LICENSE_VERSION } from '@/lib/licensing/eventLicense'
import { isSubmittedDraftStatus } from '@/lib/events/builder/stepRegistry'

export const dynamic = 'force-dynamic'
const noStore = { 'Cache-Control': 'no-store' }
const fail = (status: number, code: string, message: string, extra: Record<string, unknown> = {}) =>
  NextResponse.json({ ok: false, code, message, ...extra }, { status, headers: noStore })

export async function POST(req: NextRequest): Promise<NextResponse> {
  const authz = await authorizeWorkspace(req, 'events')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  const uid = authz.workspaceUid

  let body: { eventId?: unknown; capacity?: unknown; services?: unknown; expectedTotalPaise?: unknown }
  try { body = await req.json() as typeof body } catch { return fail(400, 'BAD_JSON', 'Invalid JSON body') }

  const draftId = typeof body.eventId === 'string' ? body.eventId.trim() : ''
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(draftId)) return fail(400, 'BAD_EVENT', 'A valid eventId is required')

  // ── Ownership + SUBMITTED status (server-written; clients cannot write it) ──────────
  const draftSnap = await adminDb.doc(`users/${uid}/eventDrafts/${draftId}`).get()
  if (!draftSnap.exists) return fail(404, 'EVENT_NOT_FOUND', 'Event not found.')
  if (!isSubmittedDraftStatus(draftSnap.get('status'))) {
    return fail(409, 'NOT_SUBMITTED', 'This event has not been submitted yet — pay for it from the draft flow.')
  }
  const resolved = await resolveCapacityEventSlug(draftId, uid)
  if (!resolved.ok) return fail(404, resolved.code, resolved.message)
  const slug = resolved.slug

  const evSnap = await adminDb.collection('events').doc(slug).get()
  const ev = evSnap.exists ? evSnap.data() as Record<string, unknown> : undefined
  if (!ev || ev.uid !== uid) return fail(404, 'EVENT_NOT_FOUND', 'Event not found.')
  // RD-HIGH-2 — additional services are granted into the ledger keyed by this draft id; it (and
  // every order / event under the id) must be this workspace's.
  const ownership = await checkDraftCommerceOwnership(draftId, uid)
  if (!ownership.ok) return fail(403, 'FORBIDDEN', DRAFT_COMMERCE_FORBIDDEN_MESSAGE)
  if (!isPurchaseEligibleLifecycle(ev)) return fail(409, 'LIFECYCLE_INELIGIBLE', 'This event is no longer live, so nothing can be bought for it.')

  // ── Services: ADDITIONAL units, validated against the catalog ─────────────────────────
  const parsed = parseServiceSelection(body.services)
  if (!parsed.ok) return fail(400, 'INVALID_SERVICES', parsed.message)
  const additional: ServiceSelection = parsed.selection
  const catalog = await getServiceAllowancesConfig()
  for (const k of SERVICE_KINDS) {
    const c = validateServiceQuantity(k, additional[k], catalog[k])
    if (!c.ok) return fail(422, c.code, c.message, { service: k })
  }
  // RD-PHOTO-01 — ADDITIONAL photo units may never take the event above 3,000 (server rule; the
  // slider only mirrors it). The base each media line records is 0: there are no free photos.
  const mediaBase = additional.media > 0 ? await mediaBasePhotoCap({ organizerUid: uid, draftId, eventSlug: slug }) : null
  if (additional.media > 0) {
    const fits = checkPhotoSelection('published', additional.media, await readEventPhotoLedger(uid, draftId))
    if (!fits.ok) return fail(422, fits.code, fits.message, { service: 'media', maxAdditional: fits.maxAdditional })
  }
  // The media line records the base limit it sits on top of (withMediaBaseCap) — the Wallet's refund basis.
  const serviceItems = withMediaBaseCap(SERVICE_KINDS.filter(k => additional[k] > 0).map(k => priceServiceItem(k, additional[k], catalog[k])), mediaBase)
  const servicesTotal = sumServiceItems(serviceItems)

  // ── Capacity: target vs the ENFORCED capacity, never below registrations taken ────────
  const loaded = await loadCapacityChangeContext(slug, uid)
  if (!loaded.ok) return fail(loaded.code === 'FORBIDDEN' ? 403 : loaded.code === 'LICENCE_INACTIVE' ? 409 : 422, loaded.code, loaded.message)
  const { currentCapacity, terms } = loaded.ctx
  const target = body.capacity === undefined || body.capacity === null ? currentCapacity : body.capacity
  const q = quoteCapacityChange({ currentCapacity, newCapacity: target, terms })
  if (!q.ok) return fail(422, q.code, q.message)
  const sold = await readSoldCount(slug)
  if (q.quote.capacity < sold) {
    return fail(422, 'BELOW_SOLD', `${sold.toLocaleString('en-IN')} registrations are already taken, so capacity cannot go below ${sold.toLocaleString('en-IN')}.`, { sold })
  }
  const capacityChanges = q.quote.kind !== 'unchanged'
  if (!capacityChanges && selectionIsEmpty(additional)) return fail(400, 'NOTHING_TO_BUY', 'Choose more capacity or additional services to buy.')

  const payable = (capacityChanges ? q.quote.totalPaise : 0) + servicesTotal
  if (body.expectedTotalPaise !== undefined && body.expectedTotalPaise !== null && body.expectedTotalPaise !== payable) {
    return fail(409, 'QUOTE_CHANGED', 'The price changed since it was shown. Review the updated total and try again — nothing was charged.', { currentTotalPaise: payable })
  }

  // ── Services only → add-on order (reuse / supersede handled there) ────────────────────
  if (!capacityChanges) {
    const coverage = await readDraftCoverage(draftId, uid)
    const cumulative = { ...coverage.purchased }
    for (const k of SERVICE_KINDS) cumulative[k] += additional[k]
    const addon = await purchaseAddon({
      draftId, organizerUid: uid, tier: defaultLicenseTierForVersion(CURRENT_LICENSE_VERSION),
      capacity: coverage.paidCapacity ?? 0, services: cumulative, catalog, coverage, mediaBaseCap: mediaBase,
    })
    if (addon.kind === 'covered') return fail(400, 'NOTHING_TO_BUY', 'Nothing to buy.')
    if (addon.kind === 'processing') return fail(409, 'PAYMENT_PROCESSING', 'A payment for this event is already being processed. Refresh the status in a moment.')
    if (addon.kind === 'error') return fail(422, 'INVALID', addon.message)
    return NextResponse.json({
      ok: true, confirmVia: 'checkout', orderId: addon.orderId, reused: addon.reused,
      checkout: { provider: 'razorpay', razorpayOrderId: addon.razorpayOrderId, amountPaise: addon.amountPaise, currency: 'INR', keyId: RAZORPAY_KEY_ID },
      serviceItems: addon.order.serviceItems ?? [], pricePaise: addon.amountPaise,
    }, { headers: noStore })
  }

  // ── Capacity change (+ service lines) → capacity-change order ─────────────────────────
  // RD-L6 D1 — the SHARED transactional reuse / replace decision (same as the dashboard route): an
  // identical unpaid order is REUSED (double click, retry, or an order the dashboard created); a
  // different one is replaced only after the M3 capture lookup says "none" and the M4 transactional
  // re-check still finds it created, unheld and on the same Razorpay order. Never a second payable order.
  const opened = await openCapacityCheckout({
    eventId: slug, organizerUid: uid, newCapacity: target, serviceItems, draftId,
    notes: { services: String(serviceItems.length) }, logTag: 'published-purchase',
  })
  if (opened.kind === 'fail') return fail(opened.status, opened.code, opened.message)

  if (opened.kind === 'free') {
    // A free capacity change with no service lines: applied now, nothing payable.
    const applied = await applyFreeCapacityChange({ eventId: slug, organizerUid: uid, snapshot: opened.snapshot })
    if (applied === 'stale') return fail(409, 'STALE_CAPACITY', 'The capacity changed while you were editing. Refresh and try again.')
    if (applied === 'not_found') return fail(404, 'EVENT_NOT_FOUND', 'Event not found.')
    // RD-SA-COMMERCE-P1 — the licence went inactive between the quote and this change.
    if (applied === 'lifecycle_ineligible') return fail(409, 'LICENCE_INACTIVE', "This event's licence is not active (suspended, cancelled or refunded), so its capacity cannot be changed. Contact RegisterDesk support.")
    return NextResponse.json({ ok: true, confirmVia: null, applied: true, capacity: opened.snapshot.capacity, checkout: null }, { headers: noStore })
  }

  const { orderId, razorpayOrderId, razorpayAmountPaise, snapshot, reused } = opened
  console.info(`[published-purchase] order ${orderId} ${reused ? 'reused' : 'created'} · ${snapshot.previousCapacity}→${snapshot.capacity} services=${serviceItems.length} amount=${razorpayAmountPaise}`)
  return NextResponse.json({
    ok: true, confirmVia: 'capacity', orderId, reused,
    checkout: { provider: 'razorpay', razorpayOrderId, amountPaise: razorpayAmountPaise, currency: 'INR', keyId: RAZORPAY_KEY_ID },
    capacityCharge: snapshot, serviceItems, pricePaise: razorpayAmountPaise,
  }, { headers: noStore })
}
