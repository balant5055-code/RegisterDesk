// GET /api/public/pricing — RD-PRICING-CALC
//
// The sanitized pricing the PUBLIC /pricing calculator computes with. Read-only, unauthenticated,
// GET only: there is no write path here, and no other verb is exported.
//
// The payload is built by `getPublicPricing()` (lib/licensing/publicPricingServer) — the SAME
// function the /pricing page renders its plan cards, facts and metadata from — over the same
// resolvers License & Services and the ticket checkout charge with. A Super Admin price change
// therefore reaches the page and this endpoint with no code change.
//
// FAILS CLOSED: when the commercial configuration is invalid or unreadable the checkout refuses to
// price, so this answers 503 rather than showing the code defaults. A service that is not on sale
// is reported as unavailable, with NO price.
//
// EXPOSED: the six commercial terms, each ON-SALE service's sale settings, and the ticket fee
// components. No other Business Configuration section, no per-event or organizer data, no
// metadata, no secrets.

import { NextResponse } from 'next/server'
import { getPublicPricing } from '@/lib/licensing/publicPricingServer'

export const dynamic = 'force-dynamic'

export async function GET(): Promise<NextResponse> {
  const pricing = await getPublicPricing()
  if (!pricing) {
    return NextResponse.json(
      { error: 'Pricing is temporarily unavailable.', code: 'PRICING_UNAVAILABLE' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    )
  }
  // Public and identical for every visitor: a short shared cache keeps a Super Admin change
  // visible within about a minute without a Firestore read per page view.
  return NextResponse.json({ pricing }, { headers: { 'Cache-Control': 'public, max-age=0, s-maxage=60' } })
}
