// GET /api/admin/media-credits/overview
//
// MC-08. Platform-wide credit position for the operations console. READ ONLY.
//
// ═══ BOUNDED, AND HONEST ABOUT IT ════════════════════════════════════════════
// Firestore counts documents server-side but cannot sum a field, so platform totals require
// reading wallets and purchases. This scans up to `limit` of each and sets `truncated` when
// more remain. A figure below the cap is exact; above it, the response says so rather than
// presenting a floor as a total.
//
// The alternatives were rejected in MC-08's audit: a rollup counter would mean writing to a
// new hot document inside every settlement transaction (a frozen financial path), and a
// scheduled snapshot would be stale and would add work to a cron that moves money.
//
// ═══ WHY THIS ENDPOINT SUMS NOTHING ITSELF ═══════════════════════════════════
// The arithmetic lives in `utils/platformTotals`, which is pure and unit-tested. This route
// fetches and hands off — a financial figure computed inline in a route handler is one nobody
// can test without standing up a database.

import { NextRequest, NextResponse } from 'next/server'
import { resolveAdminUid } from '@/lib/admin/auth'
import * as walletRepo from '@/features/media-credits/repositories/walletRepo'
import * as purchaseRepo from '@/features/media-credits/repositories/purchaseRepo'
import { sessionMetrics } from '@/features/media-credits/services/sessionCleanupService'
import { getCreditPolicy } from '@/features/media-credits/services'
import {
  averageCreditsPerUpload, totalPurchases, totalWallets,
} from '@/features/media-credits/utils/platformTotals'

export const dynamic = 'force-dynamic'

const DEFAULT_LIMIT = 1000
const MAX_LIMIT     = 5000

export async function GET(req: NextRequest): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const raw   = Number(req.nextUrl.searchParams.get('limit') ?? DEFAULT_LIMIT)
  const limit = Math.min(Math.max(1, Number.isFinite(raw) ? Math.trunc(raw) : DEFAULT_LIMIT), MAX_LIMIT)

  const [walletPage, purchasePage, sessions, policy] = await Promise.all([
    walletRepo.listAll(limit),
    purchaseRepo.listAllPurchases(limit),
    sessionMetrics(),
    getCreditPolicy(),
  ])

  const credits = totalWallets(walletPage.wallets)
  const revenue = totalPurchases(purchasePage.purchases)

  return NextResponse.json({
    credits,
    revenue,
    sessions,
    // Shown so an operator reading a liability figure knows the rate it was accrued at.
    pricing: {
      creditsEnabled:  policy.creditsEnabled,
      creditsPerPhoto: policy.creditsPerPhoto,
      unitPricePaise:  policy.creditUnitPricePaise,
      // MC-12.1 · the decision dialog gates its note field on this.
      refundNoteRequired: policy.refundNoteRequired,
    },
    // Platform-wide "average credits per upload" would need a cross-tenant photo count, which
    // does not exist. Null rather than an approximation from creditsConsumed ÷ creditsPerPhoto,
    // which drifts the moment an admin changes the rate.
    averageCreditsPerUpload: averageCreditsPerUpload(credits.creditsConsumed, null),
    scanned: {
      wallets:   walletPage.wallets.length,
      purchases: purchasePage.purchases.length,
      limit,
      /** True when either scan hit the cap — every total below is then a FLOOR, not a total. */
      truncated: walletPage.truncated || purchasePage.truncated,
    },
  }, { headers: { 'Cache-Control': 'no-store' } })
}
