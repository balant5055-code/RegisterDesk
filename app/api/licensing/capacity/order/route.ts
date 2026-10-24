// POST /api/licensing/capacity/order — RD-CAPACITY-01
//
// Commit to a capacity change: re-quote it transactionally, write the order, and (when it
// costs anything) create the Razorpay order for the WHOLE amount. The communication wallet
// is never involved (RD-LICENSE-PAYMENT-01).
//
// ═══ WHAT THE CLIENT IS ALLOWED TO SEND ══════════════════════════════════════
// `eventId` and `capacity`. Nothing else. The amount, the rate, the free allowance and the
// GST are all derived server-side from the event's effective commercial
// terms, inside the transaction that also claims the operation's sequence number — so two
// concurrent changes cannot both price against the same capacity.
//
// A change that costs nothing is applied immediately and NO Razorpay order is created: a
// ₹0 order is not payable and would leave the organizer holding a document they can never
// clear.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeWorkspace }        from '@/lib/team/workspace'
import { RAZORPAY_KEY_ID }           from '@/lib/razorpay/client'
import { formatPaise }               from '@/lib/licensing/capacityPricing'
import { applyFreeCapacityChange, resolveCapacityEventSlug } from '@/lib/licensing/capacityChange'
import { openCapacityCheckout }      from '@/lib/licensing/capacityOrderCheckout'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest): Promise<NextResponse> {
  const authz = await authorizeWorkspace(req, 'events')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  const uid = authz.workspaceUid

  let body: { eventId?: unknown; capacity?: unknown }
  try { body = await req.json() as typeof body }
  catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }

  const requestedId = typeof body.eventId === 'string' ? body.eventId.trim() : ''
  if (!requestedId) return NextResponse.json({ error: 'eventId is required' }, { status: 400 })

  // RD-EVENT-COMMERCE-01 · D1 — the dashboard sends the DRAFT id; the live event is its slug.
  // Every order is keyed by the slug, exactly as before, so confirm/webhook are unchanged.
  const resolved = await resolveCapacityEventSlug(requestedId, uid)
  if (!resolved.ok) return NextResponse.json({ error: resolved.message, code: resolved.code }, { status: 404 })
  const eventId = resolved.slug

  // RD-L6 D1 — the SHARED transactional reuse / replace decision (same as the wizard route): an
  // identical pending order is reused, a different one goes through the M3 lookup + M4 supersede,
  // and a new request never leaves a second payable capacity order for this event.
  const opened = await openCapacityCheckout({ eventId, organizerUid: uid, newCapacity: body.capacity, logTag: 'capacity' })
  if (opened.kind === 'fail') {
    return NextResponse.json({ error: opened.message, code: opened.code }, { status: opened.status, headers: { 'Cache-Control': 'no-store' } })
  }
  const { quote, snapshot } = opened

  // ── Free path: apply now, create nothing payable ────────────────────────────
  if (opened.kind === 'free') {
    const applied = await applyFreeCapacityChange({ eventId, organizerUid: uid, snapshot })
    if (applied === 'stale') {
      return NextResponse.json(
        { error: 'The capacity changed while you were editing. Reload and try again.', code: 'STALE_CAPACITY' },
        { status: 409, headers: { 'Cache-Control': 'no-store' } },
      )
    }
    if (applied === 'not_found') {
      return NextResponse.json({ error: 'Event not found.', code: 'EVENT_NOT_FOUND' }, { status: 404 })
    }
    // RD-SA-COMMERCE-P1 — the licence went inactive between the quote and this change.
    if (applied === 'lifecycle_ineligible') {
      return NextResponse.json({ error: "This event's licence is not active (suspended, cancelled or refunded), so its capacity cannot be changed. Contact RegisterDesk support.", code: 'LICENCE_INACTIVE' }, { status: 409, headers: { 'Cache-Control': 'no-store' } })
    }
    console.info(`[capacity] applied free change · eventId=${eventId} ${snapshot.previousCapacity} → ${snapshot.capacity} (${applied})`)
    return NextResponse.json({
      ok: true, paymentRequired: false, applied: applied === 'ok', unchanged: applied === 'already',
      capacity: snapshot.capacity, quote, checkout: null,
    }, { status: 200, headers: { 'Cache-Control': 'no-store' } })
  }

  // ── A Razorpay order for the WHOLE total (RD-LICENSE-PAYMENT-01) ──────────────
  // There is no wallet share and no "covered without a gateway" branch: the communication
  // wallet never funds a capacity change. The Razorpay order (created or reused by the shared
  // helper) is for the server's own figure — never anything the client sent.
  const { orderId, razorpayOrderId, razorpayAmountPaise, reused } = opened
  console.info(`[capacity] order ${reused ? 'reused' : 'created'} · orderId=${orderId} ${snapshot.previousCapacity} → ${snapshot.capacity} razorpay=${razorpayAmountPaise}`)
  return NextResponse.json({
    ok: true, paymentRequired: true, orderId, reused, quote, razorpayAmountPaise,
    checkout: { provider: 'razorpay', razorpayOrderId, amountPaise: razorpayAmountPaise, currency: 'INR', keyId: RAZORPAY_KEY_ID },
    display: { base: formatPaise(quote.basePaise), gst: formatPaise(quote.gstPaise), total: formatPaise(quote.totalPaise) },
  }, { status: 200, headers: { 'Cache-Control': 'no-store' } })
}
