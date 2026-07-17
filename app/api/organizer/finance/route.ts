// GET /api/organizer/finance
// Returns the organizer's revenue wallet balances and lifetime totals.
// Used by /dashboard/finance to populate KPI cards.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeWorkspace }        from '@/lib/team/workspace'
import { adminDb }                   from '@/lib/firebase/admin'
import type { OrganizerRevenueWallet } from '@/lib/fees/types'

export interface FinanceOverview {
  wallet: {
    pendingPaise:       number
    availablePaise:     number
    inTransitPaise:     number
    settledPaise:       number
    lifetimeGrossPaise: number
    lifetimeFeesPaise:  number
    lifetimeNetPaise:   number
    currency:   'INR'
    planTier:   string
    updatedAt:  string | null
  }
}

function tsToISO(ts: unknown): string | null {
  if (!ts) return null
  if (typeof (ts as { toDate?: () => Date }).toDate === 'function')
    return (ts as { toDate: () => Date }).toDate().toISOString()
  return null
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const authz = await authorizeWorkspace(req, 'transactions')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  const uid = authz.workspaceUid

  const walletSnap = await adminDb.doc(`organizerRevenueWallets/${uid}`).get()
  const w = walletSnap.exists ? (walletSnap.data() as OrganizerRevenueWallet) : null

  const wallet: FinanceOverview['wallet'] = {
    pendingPaise:       w?.pendingPaise       ?? 0,
    availablePaise:     w?.availablePaise     ?? 0,
    inTransitPaise:     w?.inTransitPaise     ?? 0,
    settledPaise:       w?.settledPaise       ?? 0,
    lifetimeGrossPaise: w?.lifetimeGrossPaise ?? 0,
    lifetimeFeesPaise:  w?.lifetimeFeesPaise  ?? 0,
    lifetimeNetPaise:   w?.lifetimeNetPaise   ?? 0,
    currency:  'INR',
    planTier:  w?.planTier ?? 'starter',
    updatedAt: w ? tsToISO(w.updatedAt) : null,
  }

  const data: FinanceOverview = { wallet }
  return NextResponse.json(data)
}
