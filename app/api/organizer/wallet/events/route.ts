// GET /api/organizer/wallet/events?phase=&search=&cursor=&limit=
//
// RD-WALLET-EVT-01 — the organizer's event-wise Wallet: each event's registrations, prepaid
// services (WhatsApp, certificates, extra photos), photo capacity and what was paid for it.
// READ-ONLY (lib/wallet/eventWalletService.ts). Same authorization as every wallet route: the
// workspace `wallet` permission; only the workspace's own events are read, and nothing the client
// sends (ids, amounts, usage) is trusted — every figure is derived here from server records.
//
//   phase   live | upcoming | completed | cancelled (absent = all)
//   search  substring over name / slug / organizer / venue (as the Events listing)
//   cursor  the previous page's `nextCursor`
//   limit   1–15 (default 10)

import { NextRequest, NextResponse } from 'next/server'
import { authorizeWorkspace } from '@/lib/team/workspace'
import { captureError } from '@/lib/monitoring/sentry'
import { listWalletEvents } from '@/lib/wallet/eventWalletService'
import { parseWalletEventPhase } from '@/lib/wallet/eventWalletView'

export const dynamic = 'force-dynamic'
const NO_STORE = { 'Cache-Control': 'no-store' }

export async function GET(req: NextRequest): Promise<NextResponse> {
  const authz = await authorizeWorkspace(req, 'wallet')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status, headers: NO_STORE })
  const p = req.nextUrl.searchParams
  const limit = Number(p.get('limit'))
  try {
    const page = await listWalletEvents(authz.workspaceUid, {
      phase:  parseWalletEventPhase(p.get('phase')),
      search: p.get('search'),
      cursor: p.get('cursor'),
      limit:  Number.isFinite(limit) && limit > 0 ? limit : undefined,
    })
    return NextResponse.json(page, { headers: NO_STORE })
  } catch (err) {
    captureError(err, { scope: 'organizer.wallet_events.list' })
    return NextResponse.json({ error: 'Could not load your events. Please try again.' }, { status: 500, headers: NO_STORE })
  }
}
