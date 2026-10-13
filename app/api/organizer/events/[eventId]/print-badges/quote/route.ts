// POST /api/organizer/events/[eventId]/print-badges/quote — RD-PRINT-BILL-P4
//
// The server's price for prepaid ID-badge units on a PUBLISHED event (`eventId` = the event slug).
// Read-only: nothing is written and a coupon is only VALIDATED (its usage is never consumed).
// The workspace OWNER only — a staff member with the `events` permission is refused. Fails closed
// while purchases are unreleased in code, the GST treatment is unapproved, or anything is unreadable.
//
// Body: { quantity: number, couponCode?: string }

import { NextRequest, NextResponse } from 'next/server'
import { authorizeWorkspace } from '@/lib/team/workspace'
import { quoteBadgePurchase } from '@/lib/licensing/printBadgePurchase/quote'

export const dynamic = 'force-dynamic'
const NO_STORE = { 'Cache-Control': 'no-store' }

export async function POST(req: NextRequest, context: { params: Promise<{ eventId: string }> }): Promise<NextResponse> {
  const { eventId: slug } = await context.params
  const authz = await authorizeWorkspace(req, 'events')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status, headers: NO_STORE })
  let body: { quantity?: unknown; couponCode?: unknown }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400, headers: NO_STORE }) }
  try {
    const q = await quoteBadgePurchase({ workspaceUid: authz.workspaceUid, isOwner: authz.isOwner, slug, quantity: body.quantity, couponCode: body.couponCode })
    if (!q.ok) return NextResponse.json({ error: q.message, code: q.code }, { status: q.status, headers: NO_STORE })
    const s = q.quote.snapshot
    return NextResponse.json({
      quote: {
        quantity: s.quantity, unitPricePaise: s.unitPricePaise, priceSource: s.priceSource,
        grossPaise: s.grossPaise, discountPaise: s.discountPaise, netPaise: s.netPaise,
        gstRatePercent: s.gstRatePercent, netBasePaise: s.netBasePaise, netGstPaise: s.netGstPaise,
        couponCode: s.coupon?.code ?? null, currency: s.currency, minQuantity: q.quote.bounds.min, maxQuantity: q.quote.bounds.max,
        free: s.netPaise === 0,
      },
    }, { headers: NO_STORE })
  } catch (e) {
    console.error('[print-badges/quote] failed', { type: e instanceof Error ? e.name : typeof e })
    return NextResponse.json({ error: 'Could not price this purchase. Please try again.' }, { status: 500, headers: NO_STORE })
  }
}
