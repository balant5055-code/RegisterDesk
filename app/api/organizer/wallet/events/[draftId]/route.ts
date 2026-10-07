// GET /api/organizer/wallet/events/[draftId]
//
// RD-WALLET-EVT-01 — one event's Wallet detail: service cards, its verified licence payments
// (activation, capacity changes, add-ons) and the communication usage / wallet charges that can be
// RELIABLY attributed to it. READ-ONLY. `wallet` permission; the draft must be the workspace's own —
// anything else is a 404, so this cannot be used to probe other workspaces' events.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeWorkspace } from '@/lib/team/workspace'
import { captureError } from '@/lib/monitoring/sentry'
import { getWalletEventDetail } from '@/lib/wallet/eventWalletService'

export const dynamic = 'force-dynamic'
const NO_STORE = { 'Cache-Control': 'no-store' }

export async function GET(req: NextRequest, ctx: { params: Promise<{ draftId: string }> }): Promise<NextResponse> {
  const authz = await authorizeWorkspace(req, 'wallet')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status, headers: NO_STORE })
  const { draftId } = await ctx.params
  try {
    const detail = await getWalletEventDetail(authz.workspaceUid, draftId)
    if (!detail) return NextResponse.json({ error: 'Event not found.' }, { status: 404, headers: NO_STORE })
    return NextResponse.json(detail, { headers: NO_STORE })
  } catch (err) {
    captureError(err, { scope: 'organizer.wallet_events.detail' })
    return NextResponse.json({ error: 'Could not load this event. Please try again.' }, { status: 500, headers: NO_STORE })
  }
}
