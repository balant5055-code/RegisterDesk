// GET /api/admin/wallet-management?view=…
//
// RD-WALLET-W2.e · Super Admin Wallet Management — READ-ONLY.
//
// Authorization: `requireSuperAdmin` (ADMIN_UIDS only, lib/admin/financialGuard.ts). A caller
// holding only the legacy `admin: true` claim gets 403 SUPER_ADMIN_REQUIRED; anyone else 403.
// Only GET is exported. Nothing is written (no audit row either — displaying data is not an
// action) and no payment provider is called; see lib/admin/walletManagementService.ts.
//
// Views:
//   overview                                   aggregate counts / sums only
//   organizers   [cursor] [search]             communication + media wallets
//   organizer    uid                           one organizer: wallet check, top-ups, records,
//                                              events & services, media credits
//   events       [cursor] [organizerUid] [source=ledgers]  every live event (capacity-only included)
//                                              + licence capacity + service ledger when present
//   event        draftId | slug                one event end to end (per-event reconciliation)
//   transactions [cursor] [organizerUid] [sign]  communication-wallet ledger
//   refunds      [status] [cursor]             media-credit refund requests
//   reconciliation [kind=topups|records|wallets|service_refunds] [cursor] [gateway=1 [gatewayAfter]]   W2.d report
//                  (read-only); gateway=1 adds S3 gateway evidence — NOT ENABLED in production
//                  (mock-only phase); gatewayAfter continues within the page (G1)

import { NextRequest, NextResponse } from 'next/server'
import { requireSuperAdmin } from '@/lib/admin/financialGuard'
import { captureError } from '@/lib/monitoring/sentry'
import {
  getWalletOverview, listOrganizerWallets, getOrganizerWalletDetail, listEventServices, getEventWalletDetail,
  listWalletTransactions, listRefundRequests, getReconciliationPage, isSafeId,
} from '@/lib/admin/walletManagementService'

export const dynamic = 'force-dynamic'
// G3 — explicit, so the 20 s reconciliation deadline never depends on the platform default.
export const maxDuration = 60

const NO_STORE = { 'Cache-Control': 'no-store' }

export async function GET(req: NextRequest): Promise<NextResponse> {
  const gate = await requireSuperAdmin(req)
  if (gate.response) {
    gate.response.headers.set('Cache-Control', 'no-store')
    return gate.response
  }

  const p = req.nextUrl.searchParams
  const view = p.get('view') ?? 'overview'
  const cursor = p.get('cursor')
  try {
    switch (view) {
      case 'overview':
        return NextResponse.json(await getWalletOverview(), { headers: NO_STORE })
      case 'organizers':
        return NextResponse.json(await listOrganizerWallets({ cursor, limit: p.get('limit'), search: p.get('search') }), { headers: NO_STORE })
      case 'organizer': {
        const uid = p.get('uid')
        if (!isSafeId(uid)) return NextResponse.json({ error: 'A valid organizer uid is required.' }, { status: 400, headers: NO_STORE })
        const detail = await getOrganizerWalletDetail(uid)
        return detail
          ? NextResponse.json(detail, { headers: NO_STORE })
          : NextResponse.json({ error: 'Not found.' }, { status: 404, headers: NO_STORE })
      }
      case 'events':
        return NextResponse.json(await listEventServices({ cursor, limit: p.get('limit'), organizerUid: p.get('organizerUid'), source: p.get('source') }), { headers: NO_STORE })
      case 'event': {
        // RD-CLOSE — one event end to end: services, capacity, orders, requests, charges, messages.
        const detail = await getEventWalletDetail({ draftId: p.get('draftId'), slug: p.get('slug') })
        return detail
          ? NextResponse.json(detail, { headers: NO_STORE })
          : NextResponse.json({ error: 'Event not found.' }, { status: 404, headers: NO_STORE })
      }
      case 'transactions':
        return NextResponse.json(await listWalletTransactions({ cursor, limit: p.get('limit'), organizerUid: p.get('organizerUid'), sign: p.get('sign') }), { headers: NO_STORE })
      case 'refunds':
        return NextResponse.json(await listRefundRequests({ status: p.get('status'), cursor, limit: p.get('limit') }), { headers: NO_STORE })
      case 'reconciliation':
        // gateway=1 — on-demand W2.d S3 gateway evidence. No provider is passed: production gateway
        // verification is not enabled (mock-only phase), so the report says so and calls nothing.
        return NextResponse.json(await getReconciliationPage({
          kind: p.get('kind'), cursor, limit: p.get('limit'), gateway: p.get('gateway') === '1', gatewayAfter: p.get('gatewayAfter'),
        }), { headers: NO_STORE })
      default:
        return NextResponse.json({ error: 'Unknown view.' }, { status: 400, headers: NO_STORE })
    }
  } catch (err) {
    captureError(err, { scope: 'admin.wallet_management', view })
    return NextResponse.json({ error: 'Could not load wallet data. Please try again.' }, { status: 500, headers: NO_STORE })
  }
}
