// GET /api/organizer/wallet
// Returns the organizer's current wallet balance.

import { NextRequest, NextResponse }  from 'next/server'
import { adminAuth }                  from '@/lib/firebase/admin'
import { getWalletBalance }           from '@/lib/firebase/firestore/wallet'
import type { WalletBalanceResponse } from '@/types/events'

export async function GET(req: NextRequest): Promise<NextResponse<WalletBalanceResponse>> {
  const token = (req.headers.get('authorization') ?? '').replace('Bearer ', '')
  if (!token) {
    return NextResponse.json({ balancePaise: 0, balanceRupees: 0 }, { status: 401 })
  }

  let uid: string
  try {
    uid = (await adminAuth.verifyIdToken(token)).uid
  } catch {
    return NextResponse.json({ balancePaise: 0, balanceRupees: 0 }, { status: 401 })
  }

  const balancePaise = await getWalletBalance(uid)
  return NextResponse.json({ balancePaise, balanceRupees: balancePaise / 100 })
}
