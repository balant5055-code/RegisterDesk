// GET /api/admin/print-badges/suspicious-payments — RD-PRINT-BILL-P4.4
//
// READ-ONLY list of captured ID-badge payments that could not be settled or held — wrong amount /
// currency / order, or a not-payable order (suspiciousPayments/badge_{paymentId}, written durably by
// lib/licensing/printBadgePurchase/suspicious.ts). Super Admin (ADMIN_UIDS) only; a legacy
// `admin: true` claim alone is refused. Bounded pages in document-id order with `hasMore` and
// `nextCursor`. Returns payment/order ids, reason, expected vs actual amounts, review status and
// timestamps — no attendee data, no secrets, no URLs. Nothing is refunded, activated or released here.
//
//   ?limit=<1–100, default 50>   ?cursor=<nextCursor from the previous page>

import { NextRequest, NextResponse } from 'next/server'
import { requireSuperAdmin } from '@/lib/admin/financialGuard'
import { listBadgeSuspiciousPayments, SUSPICIOUS_PAGE_MAX } from '@/lib/licensing/printBadgePurchase/suspicious'

export const dynamic = 'force-dynamic'
const NO_STORE = { 'Cache-Control': 'no-store' }

export async function GET(req: NextRequest): Promise<NextResponse> {
  const gate = await requireSuperAdmin(req)
  if (gate.response) return gate.response
  const cursor = req.nextUrl.searchParams.get('cursor')?.trim() || null
  const limitRaw = Number(req.nextUrl.searchParams.get('limit') ?? '50')
  const limit = Number.isInteger(limitRaw) && limitRaw >= 1 && limitRaw <= SUSPICIOUS_PAGE_MAX ? limitRaw : 50
  try {
    return NextResponse.json(await listBadgeSuspiciousPayments({ cursor, limit }), { headers: NO_STORE })
  } catch (e) {
    if (e instanceof Error && e.message === 'INVALID_CURSOR') return NextResponse.json({ error: 'Invalid cursor' }, { status: 400, headers: NO_STORE })
    console.error('[admin/print-badges/suspicious-payments] failed', { type: e instanceof Error ? e.name : typeof e })
    return NextResponse.json({ error: 'Could not load suspicious payments' }, { status: 500, headers: NO_STORE })
  }
}
