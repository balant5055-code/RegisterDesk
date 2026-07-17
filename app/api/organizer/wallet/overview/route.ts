// GET /api/organizer/wallet/overview
// Returns wallet balance + communication usage summary for the current month.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeWorkspace }        from '@/lib/team/workspace'
import { adminDb }                   from '@/lib/firebase/admin'
import { getWalletBalance }          from '@/lib/firebase/firestore/wallet'
import type { WalletOverview }       from '@/lib/wallet/types'

export type GetWalletOverviewResponse =
  | { success: true;  overview: WalletOverview }
  | { success: false; error: string }

export async function GET(req: NextRequest): Promise<NextResponse<GetWalletOverviewResponse>> {
  const authz = await authorizeWorkspace(req, 'wallet')
  if (!authz.ok) return NextResponse.json({ success: false, error: authz.error }, { status: authz.status })
  const uid = authz.workspaceUid

  // Month boundary for "this month spend"
  const now        = new Date()
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)

  const [balancePaise, usageSnap] = await Promise.all([
    getWalletBalance(uid),
    adminDb.collection('communicationUsage')
      .where('organizerUid', '==', uid)
      .where('createdAt', '>=', monthStart)
      .get(),
  ])

  let emailsSent        = 0
  let smsSent           = 0
  let whatsappSent      = 0
  let thisMonthSpendPaise = 0

  usageSnap.docs.forEach(doc => {
    const d = doc.data() as { channel?: string; quantity?: number; costPaise?: number }
    const qty  = typeof d.quantity  === 'number' ? d.quantity  : 0
    const cost = typeof d.costPaise === 'number' ? d.costPaise : 0
    thisMonthSpendPaise += cost
    if      (d.channel === 'email')     emailsSent   += qty
    else if (d.channel === 'sms')       smsSent      += qty
    else if (d.channel === 'whatsapp')  whatsappSent += qty
  })

  const overview: WalletOverview = {
    balancePaise,
    emailsSent,
    smsSent,
    whatsappSent,
    thisMonthSpendPaise,
  }

  return NextResponse.json({ success: true, overview })
}
