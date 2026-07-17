// GET /api/admin/wallet-topups
//
// Admin-only, cursor-paginated list of wallet top-ups (walletTopups), for
// finance visibility. Lightweight: createdAt-desc base query, organizer name
// resolved per row; optional status filter applied in memory.

import { NextRequest, NextResponse } from 'next/server'
import { adminDb }                   from '@/lib/firebase/admin'
import { resolveAdminUid }           from '@/lib/admin/auth'

export interface AdminWalletTopupItem {
  orderId:       string
  uid:           string
  organizerName: string
  amountPaise:   number
  currency:      string
  status:        string          // pending | credited | failed
  paymentId:     string | null
  createdAt:     string | null   // ISO 8601
}

export interface AdminWalletTopupsResponse {
  items:      AdminWalletTopupItem[]
  nextCursor: string | null
}

function tsToISO(ts: unknown): string | null {
  if (ts && typeof (ts as { toDate?: () => Date }).toDate === 'function') {
    return (ts as { toDate: () => Date }).toDate().toISOString()
  }
  return null
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { searchParams } = req.nextUrl
  const pageSize = Math.min(100, Math.max(1, parseInt(searchParams.get('pageSize') ?? '25', 10)))
  const cursor   = searchParams.get('cursor') ?? ''
  const status   = (searchParams.get('status') ?? '').trim()

  let query = adminDb.collection('walletTopups')
    .orderBy('createdAt', 'desc')
    .limit(pageSize + 1)

  if (cursor) {
    const curSnap = await adminDb.collection('walletTopups').doc(cursor).get()
    if (curSnap.exists) query = query.startAfter(curSnap) as typeof query
  }

  const snap     = await query.get()
  const hasMore  = snap.docs.length > pageSize
  const pageDocs = hasMore ? snap.docs.slice(0, pageSize) : snap.docs

  let items: AdminWalletTopupItem[] = await Promise.all(pageDocs.map(async doc => {
    const d   = doc.data() as Record<string, unknown>
    const uid = typeof d.uid === 'string' ? d.uid : ''
    let organizerName = uid
    if (uid) {
      try {
        const us = await adminDb.doc(`users/${uid}`).get()
        if (us.exists) organizerName = (us.data() as { name?: string }).name ?? uid
      } catch { /* non-fatal */ }
    }
    return {
      orderId:       doc.id,
      uid,
      organizerName,
      amountPaise:   typeof d.amountPaise === 'number' ? d.amountPaise : 0,
      currency:      typeof d.currency === 'string' ? d.currency : 'INR',
      status:        typeof d.status === 'string' ? d.status : 'pending',
      paymentId:     typeof d.paymentId === 'string' ? d.paymentId : null,
      createdAt:     tsToISO(d.createdAt),
    }
  }))

  if (status) items = items.filter(i => i.status === status)

  const nextCursor = hasMore ? pageDocs[pageDocs.length - 1].id : null
  return NextResponse.json({ items, nextCursor } satisfies AdminWalletTopupsResponse)
}
