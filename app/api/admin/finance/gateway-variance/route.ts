// GET /api/admin/finance/gateway-variance — RD-FEE-04
//
// Razorpay gateway cost: the FROZEN estimate (what the organizer's net was computed with) vs the
// ACTUAL fee Razorpay reported on captured payments, and their variance. REPORTING ONLY — this
// reads the ledger and writes nothing; no payable, net, wallet or payout is touched.
//
// Super Admin only (ADMIN_UIDS via requireSuperAdmin): gateway cost reconciliation is internal.
// Organizers never receive it — their own finance views already show "Razorpay fee (estimated /
// actual)" for their own rows, and nothing here is exposed to them.
//
// Scope — the existing finance scope vocabulary, nothing new:
//   (none)              every organizer, lifetime (the Super Admin Finance page)
//   ?eventSlug=<slug>   one event, lifetime (Event 360); the owner is resolved server-side
//   ?organizerUid=<uid> one organizer, lifetime
// Lifetime, like every ledger total: the ledger aggregates carry no date filter.

import { NextRequest, NextResponse } from 'next/server'
import { requireSuperAdmin } from '@/lib/admin/financialGuard'
import { adminDb } from '@/lib/firebase/admin'
import { getGatewayVariance, type GatewayVarianceScope } from '@/lib/finance/financeAnalytics'
import type { GatewayVariance } from '@/lib/finance/gatewayFee'

export const dynamic = 'force-dynamic'

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/

export interface GatewayVarianceResponse {
  scope:    { kind: 'platform' } | { kind: 'organizer'; organizerUid: string } | { kind: 'event'; eventSlug: string; organizerUid: string }
  variance: GatewayVariance
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const gate = await requireSuperAdmin(req)
  if (gate.response) return gate.response

  const eventSlug    = req.nextUrl.searchParams.get('eventSlug')
  const organizerUid = req.nextUrl.searchParams.get('organizerUid')
  if ((eventSlug && !ID_RE.test(eventSlug)) || (organizerUid && !ID_RE.test(organizerUid))) {
    return NextResponse.json({ error: 'Invalid scope' }, { status: 400 })
  }

  let scope: GatewayVarianceScope = { kind: 'platform' }
  let echo: GatewayVarianceResponse['scope'] = { kind: 'platform' }
  if (eventSlug) {
    const ev = await adminDb.collection('events').doc(eventSlug).get()
    const owner = ev.exists ? (ev.data() as { uid?: unknown }).uid : null
    if (typeof owner !== 'string' || !owner) return NextResponse.json({ error: 'Event not found' }, { status: 404 })
    scope = { kind: 'organizer', organizerUid: owner, eventSlug }
    echo  = { kind: 'event', eventSlug, organizerUid: owner }
  } else if (organizerUid) {
    scope = { kind: 'organizer', organizerUid, eventSlug: null }
    echo  = { kind: 'organizer', organizerUid }
  }

  const variance = await getGatewayVariance(scope)
  return NextResponse.json({ scope: echo, variance } satisfies GatewayVarianceResponse, { headers: { 'Cache-Control': 'no-store' } })
}
