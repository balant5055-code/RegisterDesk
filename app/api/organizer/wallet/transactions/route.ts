// GET /api/organizer/wallet/transactions
// Returns paginated wallet transaction history for the organizer.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeWorkspace }        from '@/lib/team/workspace'
import { adminDb }                   from '@/lib/firebase/admin'
import type { WalletTransaction, WalletTxnType, WalletTxnStatus, WalletTxnReferenceType, WalletTxnMetadata } from '@/lib/wallet/types'

function tsToIso(ts: unknown): string {
  if (!ts) return new Date().toISOString()
  if (typeof (ts as { toDate?: () => Date }).toDate === 'function') {
    return (ts as { toDate: () => Date }).toDate().toISOString()
  }
  return new Date().toISOString()
}

function docToTxn(id: string, d: Record<string, unknown>): WalletTransaction {
  return {
    id,
    organizerUid:  typeof d.organizerUid  === 'string' ? d.organizerUid  : '',
    type:          (d.type as WalletTxnType) ?? 'adjustment',
    amountPaise:   typeof d.amountPaise   === 'number' ? d.amountPaise   : 0,
    balancePaise:  typeof d.balancePaise  === 'number' ? d.balancePaise  : 0,
    status:        (d.status as WalletTxnStatus) ?? 'completed',
    referenceType: (d.referenceType as WalletTxnReferenceType) ?? 'manual',
    referenceId:   typeof d.referenceId   === 'string' ? d.referenceId   : '',
    description:   typeof d.description   === 'string' ? d.description   : '',
    metadata:      (d.metadata as WalletTxnMetadata) ?? {},
    createdAt:     tsToIso(d.createdAt),
  }
}

export type GetWalletTransactionsResponse =
  | { success: true;  transactions: WalletTransaction[] }
  | { success: false; error: string }

export async function GET(req: NextRequest): Promise<NextResponse<GetWalletTransactionsResponse>> {
  const authz = await authorizeWorkspace(req, 'wallet')
  if (!authz.ok) return NextResponse.json({ success: false, error: authz.error }, { status: authz.status })
  const uid = authz.workspaceUid

  const { searchParams } = new URL(req.url)
  const limitParam = parseInt(searchParams.get('limit') ?? '50', 10)
  const limit      = Math.min(Math.max(limitParam, 1), 200)

  const snap = await adminDb.collection('walletTransactions')
    .where('organizerUid', '==', uid)
    .orderBy('createdAt', 'desc')
    .limit(limit)
    .get()

  const transactions = snap.docs.map(doc => docToTxn(doc.id, doc.data() as Record<string, unknown>))
  return NextResponse.json({ success: true, transactions })
}
