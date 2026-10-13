// GET /api/admin/print-badges/reconciliation — RD-PRINT-BILL-P4
//
// READ-ONLY reconciliation of ID-badge purchases (lib/licensing/printBadgePurchase/reconciliation.ts):
// gross / coupon discount / net / taxable base / GST of paid badge orders, activation markers, the
// ledger's purchased badges, coupon redemptions and releases, organizer counters, duplicate payment
// ids and open holds. Super Admin (ADMIN_UIDS) only. Never writes; repairs go through the audited paths.
//
//   ?draftId=<id>   one event's badge orders
//   ?limit=<n>      at most n orders (default 1,000, max 2,000)

import { NextRequest, NextResponse } from 'next/server'
import { requireSuperAdmin } from '@/lib/admin/financialGuard'
import { reconcileBadgePurchases } from '@/lib/licensing/printBadgePurchase/reconciliation'

export const dynamic = 'force-dynamic'
const NO_STORE = { 'Cache-Control': 'no-store' }
const ID = /^[A-Za-z0-9_-]{1,128}$/

export async function GET(req: NextRequest): Promise<NextResponse> {
  const gate = await requireSuperAdmin(req)
  if (gate.response) return gate.response
  const draftId = req.nextUrl.searchParams.get('draftId')?.trim() || null
  if (draftId && !ID.test(draftId)) return NextResponse.json({ error: 'Invalid draftId' }, { status: 400, headers: NO_STORE })
  const limitRaw = Number(req.nextUrl.searchParams.get('limit') ?? '')
  try {
    const report = await reconcileBadgePurchases({ draftId, limit: Number.isInteger(limitRaw) && limitRaw > 0 ? limitRaw : undefined })
    return NextResponse.json(report, { headers: NO_STORE })
  } catch (e) {
    console.error('[admin/print-badges/reconciliation] failed', { type: e instanceof Error ? e.name : typeof e })
    return NextResponse.json({ error: 'Reconciliation failed' }, { status: 500, headers: NO_STORE })
  }
}
