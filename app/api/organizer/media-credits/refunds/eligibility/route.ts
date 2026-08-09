// GET /api/organizer/media-credits/refunds/eligibility
//
// MC-11. For each of the organizer's recent purchases: can it be refunded, and if not, why —
// plus the exact figures a refund would return. READ ONLY.
//
// ═══ WHY THIS EXISTS ══════════════════════════════════════════════════════════
// The Credits dashboard needs to decide, per purchase row, whether to offer a Refund button
// and what to say when it does not. Both answers depend on config thresholds, the live
// wallet, the refund window and any refund already open — none of which the browser has, and
// none of which it should be trusted to combine.
//
// It could have been answered by calling a quote endpoint once per row. That is 25 round
// trips to render one table, and it would still leave the eligibility RULES on the client.
//
// ═══ THE CLIENT COMPUTES NO MONEY ════════════════════════════════════════════
// `serviceChargePaise` and `refundAmountPaise` come from `refundMath`, the same functions
// that price the refund when it is actually created. The dashboard renders these values and
// derives nothing from them — if it multiplied a percentage itself, the figure shown and the
// figure charged would come from two implementations that could disagree.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeWorkspace } from '@/lib/team/workspace'
import { purchaseService } from '@/features/media-credits/services/purchaseService'
import { refundViewsForPurchases } from '@/features/media-credits/services/refundService'
import { getCreditPolicy } from '@/features/media-credits/services'

export const dynamic = 'force-dynamic'

const DEFAULT_LIMIT = 25
const MAX_LIMIT     = 100

export async function GET(req: NextRequest): Promise<NextResponse> {
  const authz = await authorizeWorkspace(req, 'wallet')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })

  const raw   = Number(req.nextUrl.searchParams.get('limit') ?? DEFAULT_LIMIT)
  const limit = Math.min(Math.max(1, Number.isFinite(raw) ? Math.trunc(raw) : DEFAULT_LIMIT), MAX_LIMIT)

  const [policy, page] = await Promise.all([
    getCreditPolicy(),
    purchaseService.listPurchases(authz.workspaceUid, limit),
  ])

  const views = await refundViewsForPurchases(
    authz.workspaceUid,
    page.purchases.map(p => ({
      purchaseId:  p.purchaseId,
      status:      p.status,
      credits:     p.credits,
      amountPaise: p.amountPaise,
      // The window runs from the GRANT, never from creation. Null — not yet granted — becomes
      // 0, which fails the window check CLOSED. That is the safe direction: a purchase with
      // no grant has no credits behind it to refund.
      grantedAtMs: p.grantedAtMs ?? 0,
      // RD-MC-REFUND-V2-P2 · the purchase's own price. A partial refund is
      // `creditsRemaining × unitPricePaise`, so every row must carry its own rate.
      unitPricePaise: p.unitPricePaise,
    })),
  )

  return NextResponse.json({
    views,
    /** The policy in force, so the dashboard can explain the terms before asking. */
    policy: {
      refundsEnabled:       policy.refundsEnabled,
      refundWindowDays:     policy.refundWindowDays,
      reasonRequired:       policy.refundReasonRequired,
      serviceChargeMethod:  policy.refundServiceChargeMethod,
      serviceChargePercent: policy.refundServiceChargePercent,
      serviceChargeFixedPaise: policy.refundServiceChargeFixedPaise,
    },
  }, { headers: { 'Cache-Control': 'no-store' } })
}
