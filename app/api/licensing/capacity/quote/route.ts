// POST /api/licensing/capacity/quote — RD-CAPACITY-01
//
// Price a capacity change WITHOUT committing to it. Read-only: no order, no Razorpay call,
// no write of any kind. The organizer's capacity slider calls this on every change so the
// figures on screen are the server's own, which is the point — the UI never computes an
// amount it then asks the server to accept.
//
// The response is safe to show and useless to tamper with: /capacity/order re-quotes from
// scratch inside its transaction, so a doctored response changes nothing but the display.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeWorkspace }    from '@/lib/team/workspace'
import { loadCapacityChangeContext, resolveCapacityEventSlug } from '@/lib/licensing/capacityChange'
import { quoteCapacityChange, formatPaise } from '@/lib/licensing/capacityPricing'

export const dynamic = 'force-dynamic'

const statusFor = (code: string): number =>
  code === 'EVENT_NOT_FOUND' ? 404
  : code === 'FORBIDDEN'     ? 403
  : 422

export async function POST(req: NextRequest): Promise<NextResponse> {
  const authz = await authorizeWorkspace(req, 'events')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })

  let body: { eventId?: unknown; capacity?: unknown }
  try { body = await req.json() as typeof body }
  catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }

  const requestedId = typeof body.eventId === 'string' ? body.eventId.trim() : ''
  if (!requestedId) return NextResponse.json({ error: 'eventId is required' }, { status: 400 })

  // RD-EVENT-COMMERCE-01 · D1 — the dashboard sends the DRAFT id; the live event is its slug.
  const resolved = await resolveCapacityEventSlug(requestedId, authz.workspaceUid)
  if (!resolved.ok) return NextResponse.json({ error: resolved.message, code: resolved.code }, { status: 404 })
  const eventId = resolved.slug

  const loaded = await loadCapacityChangeContext(eventId, authz.workspaceUid)
  if (!loaded.ok) {
    return NextResponse.json({ error: loaded.message, code: loaded.code }, { status: statusFor(loaded.code) })
  }
  const { currentCapacity, terms } = loaded.ctx

  // `body.capacity` goes in RAW. The engine rejects NaN, Infinity, decimals, strings,
  // booleans, zero, negatives and anything above the configured maximum, each with its own
  // reason — nothing is coerced into a number on the way.
  const quoted = quoteCapacityChange({ currentCapacity, newCapacity: body.capacity, terms })
  if (!quoted.ok) {
    return NextResponse.json(
      { error: quoted.message, code: quoted.code, currentCapacity, terms },
      { status: 422, headers: { 'Cache-Control': 'no-store' } },
    )
  }

  const q = quoted.quote
  return NextResponse.json({
    ok: true,
    currentCapacity,
    quote: q,
    // Pre-formatted for display so every surface renders the same rupee string from the
    // same paise, rather than each one re-implementing the conversion.
    display: {
      base:  formatPaise(q.basePaise),
      gst:   formatPaise(q.gstPaise),
      total: formatPaise(q.totalPaise),
    },
  }, { status: 200, headers: { 'Cache-Control': 'no-store' } })
}
