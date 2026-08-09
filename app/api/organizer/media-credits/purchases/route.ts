// /api/organizer/media-credits/purchases
//
//   POST — create a purchase intent (prices it, opens a Razorpay order)
//   GET  — the organizer's purchase history
//
// ═══ AUTHORIZATION ═══════════════════════════════════════════════════════════
// `wallet`, not `events`. Buying credits spends the organizer's money, so it sits with the
// same permission as the money wallet's top-up — `finance` may do it, `manager` and
// `checkin_staff` may not. No new permission was added; the existing matrix decides.
//
// ═══ WHAT THE CLIENT MAY SEND ════════════════════════════════════════════════
// A credit QUANTITY. That is the entire input surface. There is no amount field to tamper
// with because price is resolved server-side from MediaStudioConfig on every call.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeWorkspace } from '@/lib/team/workspace'
import { organizerStatusGuard } from '@/lib/admin/organizerStatus'
import { checkRateLimit } from '@/lib/rateLimit'
import { purchaseService } from '@/features/media-credits/services/purchaseService'
import { CreditsDisabledError, InvalidCreditOperationError } from '@/features/media-credits/errors'

export async function POST(req: NextRequest): Promise<NextResponse> {
  const authz = await authorizeWorkspace(req, 'wallet')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  const uid = authz.workspaceUid

  const blocked = await organizerStatusGuard(uid)
  if (blocked) return NextResponse.json({ error: blocked.message }, { status: 403 })

  // Same budget as the money wallet's top-up. Each call creates a real Razorpay order, so
  // an unbounded loop would litter the gateway with orders as fast as it could dial out.
  const rl = checkRateLimit(uid, 'media-credit-purchase', 10, 60 * 60 * 1000)
  if (rl.limited) {
    return NextResponse.json(
      { error: 'Too many purchase requests. Please try again later.' },
      {
        status: 429,
        headers: {
          'Retry-After':       String(Math.ceil((rl.resetAt - Date.now()) / 1000)),
          'X-RateLimit-Limit': '10',
          'X-RateLimit-Reset': String(rl.resetAt),
        },
      },
    )
  }

  let credits: number
  let eventId: string | null = null
  try {
    const body = await req.json() as Record<string, unknown>
    credits = typeof body.credits === 'number' ? Math.trunc(body.credits) : NaN
    // RD-MC-CUSTOM-01 · optional. When present the service additionally bounds the purchase
    // by that event's remaining photo capacity, re-derived server-side.
    eventId = typeof body.eventId === 'string' && body.eventId.trim() ? body.eventId.trim() : null
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  try {
    const intent = await purchaseService.createPurchaseIntent({
      organizerUid: uid, credits, eventId, actorUid: authz.callerUid,
    })
    return NextResponse.json(intent, { headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    if (err instanceof CreditsDisabledError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 403 })
    }
    if (err instanceof InvalidCreditOperationError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 400 })
    }
    console.error('[media-credits/purchases] intent failed:', err)
    return NextResponse.json(
      { error: 'Could not start this purchase. Please try again.' },
      { status: 503 },
    )
  }
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const authz = await authorizeWorkspace(req, 'wallet')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })

  const url    = new URL(req.url)
  const limit  = Number(url.searchParams.get('limit') ?? '25')
  const cursor = url.searchParams.get('cursor')

  const page = await purchaseService.listPurchases(
    authz.workspaceUid, Number.isFinite(limit) ? limit : 25, cursor,
  )
  return NextResponse.json(page, { headers: { 'Cache-Control': 'no-store' } })
}
