// POST /api/organizer/wallet/topup — RETIRED (RD-COMMS-P1, 410).
//
// This used to create a Razorpay order to add money to the organizer's communication balance
// (organizerWallets/{uid}). Communication capacity is now bought ONLY on the event's License &
// Services step, as an event-scoped allowance — so no NEW money can be added to the balance.
//
// What still works, deliberately (existing customer money is never stranded):
//   • POST /api/organizer/wallet/topup/verify, GET …/topup/status, the Razorpay payment.captured
//     webhook, the wallet-reconciliation cron and the Super Admin top-up review all keep settling
//     top-up orders that were CREATED BEFORE retirement (they credit exactly once, as before);
//   • the existing balance keeps funding WhatsApp messages an event's capacity does not cover,
//     until it reaches ₹0 (controlled drain — lib/communications/capacity).
//
// Same auth gates as before (a non-member learns nothing); then 410 before any read or write.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeWorkspace }        from '@/lib/team/workspace'

const COMMUNICATION_TOPUP_RETIRED_MESSAGE =
  'Adding funds is no longer available. Purchase communication capacity for your event in License & Services.'

export async function POST(req: NextRequest): Promise<NextResponse<{ error: string; code: string } | { error: string }>> {
  const authz = await authorizeWorkspace(req, 'wallet')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  return NextResponse.json(
    { error: COMMUNICATION_TOPUP_RETIRED_MESSAGE, code: 'COMMUNICATION_TOPUP_RETIRED' },
    { status: 410, headers: { 'Cache-Control': 'no-store' } },
  )
}
