// POST /api/organizer/events/[eventId]/print-badges/purchase — RD-PRINT-BILL-P4
//
// Creates (or resumes) ONE prepaid ID-badge purchase order for a published event and returns its
// Razorpay checkout — or, for a free-coupon order, applies the units at once. The workspace OWNER only.
// The internal order is written BEFORE any Razorpay order; the same `requestId` always resolves to the
// same order (double-clicks and retries are safe). Payment is confirmed through
// /api/licensing/checkout/confirm (orderId = bdg_…) and, as a backstop, the Razorpay webhook.
//
// Body: { quantity: number, couponCode?: string, requestId: string, expectedNetPaise: number }

import { NextRequest, NextResponse } from 'next/server'
import { authorizeWorkspace } from '@/lib/team/workspace'
import { createBadgePurchase } from '@/lib/licensing/printBadgePurchase/orders'

export const dynamic = 'force-dynamic'
const NO_STORE = { 'Cache-Control': 'no-store' }

export async function POST(req: NextRequest, context: { params: Promise<{ eventId: string }> }): Promise<NextResponse> {
  const { eventId: slug } = await context.params
  const authz = await authorizeWorkspace(req, 'events')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status, headers: NO_STORE })
  let body: { quantity?: unknown; couponCode?: unknown; requestId?: unknown; expectedNetPaise?: unknown }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400, headers: NO_STORE }) }
  try {
    const r = await createBadgePurchase({
      workspaceUid: authz.workspaceUid, isOwner: authz.isOwner, callerUid: authz.callerUid, slug,
      quantity: body.quantity, couponCode: body.couponCode, requestId: body.requestId, expectedNetPaise: body.expectedNetPaise,
    })
    if (r.kind === 'refused') {
      return NextResponse.json({ error: r.message, code: r.code, ...(r.quote ? { netPaise: r.quote.snapshot.netPaise } : {}) }, { status: r.status, headers: NO_STORE })
    }
    if (r.kind === 'paid') return NextResponse.json({ ok: true, orderId: r.orderId, alreadyPaid: true, checkout: null }, { headers: NO_STORE })
    if (r.kind === 'activated') return NextResponse.json({ ok: true, orderId: r.orderId, applied: true, quantity: r.snapshot.quantity, checkout: null }, { headers: NO_STORE })
    return NextResponse.json({
      ok: true, orderId: r.orderId, confirmVia: '/api/licensing/checkout/confirm', reused: r.reused,
      checkout: { provider: 'razorpay', razorpayOrderId: r.razorpayOrderId, amountPaise: r.amountPaise, currency: r.currency, keyId: r.keyId, expiresAt: r.expiresAt },
    }, { headers: NO_STORE })
  } catch (e) {
    console.error('[print-badges/purchase] failed', { type: e instanceof Error ? e.name : typeof e })
    return NextResponse.json({ error: 'Could not start this purchase. Please try again.' }, { status: 500, headers: NO_STORE })
  }
}
