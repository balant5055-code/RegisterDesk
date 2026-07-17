// GET /api/admin/transactions
// Returns recent platform transactions across all organizers.
// Query params:
//   limit  = 1–100  (default: 50)
//   cursor = platformTransactions document ID (for next-page)

import { NextRequest, NextResponse }        from 'next/server'
import { adminDb }                          from '@/lib/firebase/admin'
import { resolveAdminUid }                  from '@/lib/admin/auth'
import type { PlatformTransactionDocument } from '@/lib/fees/types'

export interface AdminTransaction {
  id:                      string
  organizerUid:            string
  entityId:                string
  entityType:              string
  payerName:               string
  grossAmountPaise:        number
  platformFeeTotalPaise:   number
  gatewayFeeEstimatePaise: number
  netSettlementPaise:      number
  type:                    string
  category:                string
  feeModel:                string
  status:                  string
  paidAt:                  string | null
}

export interface AdminTransactionsResponse {
  transactions: AdminTransaction[]
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
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { searchParams } = req.nextUrl
  const limit  = Math.min(100, Math.max(1, parseInt(searchParams.get('limit') ?? '50', 10)))
  const cursor = searchParams.get('cursor') ?? ''

  let q = adminDb
    .collection('platformTransactions')
    .orderBy('paidAt', 'desc')
    .limit(limit + 1)

  if (cursor) {
    const cursorSnap = await adminDb.doc(`platformTransactions/${cursor}`).get()
    if (cursorSnap.exists) q = q.startAfter(cursorSnap)
  }

  const snap      = await q.get()
  const hasMore   = snap.docs.length > limit
  const pageDocs  = hasMore ? snap.docs.slice(0, limit) : snap.docs
  const nextCursor = hasMore ? (pageDocs[pageDocs.length - 1]?.id ?? null) : null

  const transactions: AdminTransaction[] = pageDocs.map(doc => {
    const d = doc.data() as PlatformTransactionDocument
    return {
      id:                      doc.id,
      organizerUid:            d.organizerUid,
      entityId:                d.entityId,
      entityType:              d.entityType,
      payerName:               d.payerName,
      grossAmountPaise:        d.grossAmountPaise,
      platformFeeTotalPaise:   d.platformFeeTotalPaise,
      gatewayFeeEstimatePaise: d.gatewayFeeEstimatePaise,
      netSettlementPaise:      d.netSettlementPaise,
      type:                    d.type,
      category:                d.category,
      feeModel:                d.feeModel,
      status:                  d.status,
      paidAt:                  tsToISO(d.paidAt),
    }
  })

  return NextResponse.json({ transactions, hasMore, nextCursor } satisfies AdminTransactionsResponse)
}
