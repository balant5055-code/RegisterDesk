// GET /api/organizer/finance/transactions
// Query params:
//   filter  = all | tickets | donations | refunds  (default: all)
//   limit   = 1–100                                (default: 50)
//   cursor  = platformTransactions document ID     (for next-page)
//
// Composite indexes required in Firestore:
//   platformTransactions: (organizerUid ASC, paidAt DESC)
//   platformTransactions: (organizerUid ASC, category ASC, paidAt DESC)
//   platformTransactions: (organizerUid ASC, status ASC,   paidAt DESC)

import { NextRequest, NextResponse }        from 'next/server'
import { authorizeWorkspace }               from '@/lib/team/workspace'
import { adminDb }                          from '@/lib/firebase/admin'
import type { PlatformTransactionDocument } from '@/lib/fees/types'

export interface FinanceTransaction {
  id:                      string
  type:                    string
  category:                string
  entityId:                string
  entityType:              string
  payerName:               string
  payerEmail:              string
  grossAmountPaise:        number
  platformFeeTotalPaise:   number
  gatewayFeeEstimatePaise: number
  netSettlementPaise:      number
  feeModel:                string
  status:                  string
  paidAt:                  string | null
}

export interface FinanceTransactionsResponse {
  transactions: FinanceTransaction[]
  hasMore:      boolean
  nextCursor:   string | null
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

  const { searchParams } = req.nextUrl
  const filter = searchParams.get('filter') ?? 'all'
  const limit  = Math.min(100, Math.max(1, parseInt(searchParams.get('limit') ?? '50', 10)))
  const cursor = searchParams.get('cursor') ?? ''

  const baseQ = adminDb
    .collection('platformTransactions')
    .where('organizerUid', '==', uid)

  const filteredQ =
    filter === 'tickets'   ? baseQ.where('category', '==', 'ticketed') :
    filter === 'donations' ? baseQ.where('category', '==', 'donation') :
    filter === 'refunds'   ? baseQ.where('status',   '==', 'refunded') :
    baseQ

  let q = filteredQ.orderBy('paidAt', 'desc').limit(limit + 1)

  if (cursor) {
    const cursorSnap = await adminDb.doc(`platformTransactions/${cursor}`).get()
    if (cursorSnap.exists) q = q.startAfter(cursorSnap)
  }

  const snap      = await q.get()
  const hasMore   = snap.docs.length > limit
  const pageDocs  = hasMore ? snap.docs.slice(0, limit) : snap.docs
  const nextCursor = hasMore ? (pageDocs[pageDocs.length - 1]?.id ?? null) : null

  const transactions: FinanceTransaction[] = pageDocs.map(doc => {
    const d = doc.data() as PlatformTransactionDocument
    return {
      id:                      doc.id,
      type:                    d.type,
      category:                d.category,
      entityId:                d.entityId,
      entityType:              d.entityType,
      payerName:               d.payerName,
      payerEmail:              d.payerEmail,
      grossAmountPaise:        d.grossAmountPaise,
      platformFeeTotalPaise:   d.platformFeeTotalPaise,
      gatewayFeeEstimatePaise: d.gatewayFeeEstimatePaise,
      netSettlementPaise:      d.netSettlementPaise,
      feeModel:                d.feeModel,
      status:                  d.status,
      paidAt:                  tsToISO(d.paidAt),
    }
  })

  const response: FinanceTransactionsResponse = { transactions, hasMore, nextCursor }
  return NextResponse.json(response)
}
