// POST /api/licensing/capacity/activation-quote — RD-CAPACITY-01
//
// Price a FIRST activation at a chosen capacity. Read-only: no order, no Razorpay call, no
// write. The capacity selector in the event builder calls this as the organizer moves the
// slider, so the fee, GST and total on screen are always the server's own arithmetic.
//
// It takes no event id, because at this point there usually is no event: the organizer is
// still in the builder and the draft has never been published. That is also why it resolves
// the GLOBAL commercial terms — a per-event override cannot exist for an event that does
// not. Once the event is published, /api/licensing/capacity/quote is the endpoint to use, and
// it does resolve the event's own terms.
//
// Nothing here is authoritative. /api/licensing/purchase re-quotes from scratch, and the
// publish step re-quotes again before it will store a capacity, so a doctored response
// changes what is displayed and nothing else.

import { NextRequest, NextResponse } from 'next/server'
import { calculateActivationQuote, formatPaise } from '@/lib/licensing/capacityPricing'
import { getGlobalCommercialTerms }   from '@/lib/licensing/resolveCommercialTerms'
import { authorizeWorkspace } from '@/lib/team/workspace'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest): Promise<NextResponse> {
  // Authenticated, because the commercial terms are not public copy. No permission beyond
  // "is a real signed-in organizer" is needed: this reads nothing that belongs to anyone.
  // RD-CE-FIX M5 · the same gate as the rest of licensing (capacity/*, checkout/confirm): verified
  // token, the workspace it acts for, suspension of caller OR owner, and the `events` permission —
  // a check-in-only or finance member, or a suspended workspace, cannot buy or read licences here.
  const authz = await authorizeWorkspace(req, 'events')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })

  let body: { capacity?: unknown }
  try { body = await req.json() as typeof body }
  catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }

  const terms  = await getGlobalCommercialTerms()
  // Raw, never coerced — the engine owns what counts as a capacity.
  const quoted = calculateActivationQuote({ capacity: body.capacity, terms })

  if (!quoted.ok) {
    // The terms travel with the rejection so the slider can still render its own bounds and
    // explain the refusal, rather than showing a dead end.
    return NextResponse.json(
      { ok: false, code: quoted.code, error: quoted.message, terms },
      { status: 422, headers: { 'Cache-Control': 'no-store' } },
    )
  }

  const q = quoted.quote
  return NextResponse.json({
    ok: true,
    quote:   q,
    terms,
    display: {
      base:  formatPaise(q.basePaise),
      gst:   formatPaise(q.gstPaise),
      total: formatPaise(q.totalPaise),
    },
  }, { status: 200, headers: { 'Cache-Control': 'no-store' } })
}
