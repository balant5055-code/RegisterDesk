// GET /api/organizer/wallet
// Returns the organizer's current wallet balance.

import { NextRequest, NextResponse }  from 'next/server'
import { authorizeWorkspace }         from '@/lib/team/workspace'
import { getWalletBalance }           from '@/lib/firebase/firestore/wallet'
import type { WalletBalanceResponse } from '@/types/events'

export async function GET(req: NextRequest): Promise<NextResponse<WalletBalanceResponse>> {
  const authz = await authorizeWorkspace(req, 'wallet')
  if (!authz.ok) return NextResponse.json({ balancePaise: 0, balanceRupees: 0 }, { status: authz.status })
  const uid = authz.workspaceUid

  const balancePaise = await getWalletBalance(uid)
  return NextResponse.json({ balancePaise, balanceRupees: balancePaise / 100 })
}
