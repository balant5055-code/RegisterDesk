// GET /api/admin/print-badges/orders — RD-PRINT-BILL-P7. Super Admin (ADMIN_UIDS) only; READ-ONLY.
//
// ID-badge purchase orders (licenseOrders, purpose 'print_badges') in document-id order:
//   ?status=created|paid|failed|expired   ?draftId=<event draft id>   ?organizerUid=<uid>
//   ?cursor=<nextCursor>                   ?limit=<1–100, default 50>
//   ?q=<bdg_… | order_… | pay_…>           exact lookup by internal order / Razorpay order / payment id
// List rows carry MASKED gateway ids; the full ids are in the audited order detail. A list read is
// not audited (approved: only detail views are). Never writes.

import { NextRequest, NextResponse } from 'next/server'
import { requireSuperAdmin } from '@/lib/admin/financialGuard'
import { listBadgeOrders, searchBadgeOrders, classifyOrderSearch, parseOrderFilters, ORDER_PAGE_MAX } from '@/lib/admin/printBadgeAdmin/orders'
import { pageSize, CURSOR_RE } from '@/lib/admin/printBadgeAdmin/common'

export const dynamic = 'force-dynamic'
const NO_STORE = { 'Cache-Control': 'no-store' }

export async function GET(req: NextRequest): Promise<NextResponse> {
  const gate = await requireSuperAdmin(req)
  if (gate.response) return gate.response
  const p = req.nextUrl.searchParams
  const q = p.get('q')?.trim() || null
  try {
    if (q) {
      if (!classifyOrderSearch(q)) return NextResponse.json({ error: 'Search by an order id (bdg_…), a Razorpay order id (order_…) or a payment id (pay_…).' }, { status: 400, headers: NO_STORE })
      return NextResponse.json({ items: await searchBadgeOrders(q), hasMore: false, nextCursor: null }, { headers: NO_STORE })
    }
    const filters = parseOrderFilters(p)
    if (!filters) return NextResponse.json({ error: 'Invalid filter' }, { status: 400, headers: NO_STORE })
    const cursor = p.get('cursor')?.trim() || null
    if (cursor && !CURSOR_RE.test(cursor)) return NextResponse.json({ error: 'Invalid cursor' }, { status: 400, headers: NO_STORE })
    return NextResponse.json(await listBadgeOrders(filters, cursor, pageSize(p.get('limit'), 50, ORDER_PAGE_MAX)), { headers: NO_STORE })
  } catch (e) {
    console.error('[admin/print-badges/orders] failed', { type: e instanceof Error ? e.name : typeof e })
    return NextResponse.json({ error: 'Could not load badge orders' }, { status: 500, headers: NO_STORE })
  }
}
