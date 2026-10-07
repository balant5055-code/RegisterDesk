// GET /api/admin/wallet-topups
//
// Admin-only, cursor-paginated list of wallet top-ups (walletTopups), for
// finance visibility. Lightweight: createdAt-desc base query, organizer name
// resolved per row; optional status filter applied in memory.
//
// RD-WALLET-W2.c — with a status filter, filtering ONE page of the newest rows could return
// "nothing" while older needs_review / abandoned orders exist. The filter now keeps reading the
// SAME createdAt-desc query (no new index, same order) until it has a page of matches or has
// examined STATUS_SCAN_LIMIT rows; the cursor is the last row EXAMINED, so "Load more" resumes
// exactly there and no row is skipped. Without a filter the behaviour is unchanged.
//
// RD-WALLET-W2.f.1 — top-up amounts, payments and organizers are financial data: Super Admin only
// (`requireSuperAdmin`, ADMIN_UIDS). A caller holding only the legacy `admin: true` claim gets
// 403 SUPER_ADMIN_REQUIRED; anyone else 403.

import { NextRequest, NextResponse } from 'next/server'
import { adminDb }                   from '@/lib/firebase/admin'
import { requireSuperAdmin }         from '@/lib/admin/financialGuard'

export interface AdminWalletTopupItem {
  orderId:       string
  uid:           string
  organizerName: string
  amountPaise:   number
  currency:      string
  status:        string          // pending | credited | needs_review | abandoned (RD-WALLET-W2.c) | failed (legacy)
  paymentId:     string | null
  createdAt:     string | null   // ISO 8601
  /** RD-WALLET-W2.f — a 'needs_review' order whose review a Super Admin has closed. */
  holdResolved:  boolean
}

export interface AdminWalletTopupsResponse {
  items:      AdminWalletTopupItem[]
  nextCursor: string | null
}

/** Rows examined per request when a status filter is set (bounded; the rest via the cursor). */
const STATUS_SCAN_LIMIT = 500
const STATUS_SCAN_BATCH = 100

function tsToISO(ts: unknown): string | null {
  if (ts && typeof (ts as { toDate?: () => Date }).toDate === 'function') {
    return (ts as { toDate: () => Date }).toDate().toISOString()
  }
  return null
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const gate = await requireSuperAdmin(req)
  if (gate.response) return gate.response

  const { searchParams } = req.nextUrl
  const pageSize = Math.min(100, Math.max(1, parseInt(searchParams.get('pageSize') ?? '25', 10)))
  const cursor   = searchParams.get('cursor') ?? ''
  const status   = (searchParams.get('status') ?? '').trim()

  const base = adminDb.collection('walletTopups').orderBy('createdAt', 'desc')
  let startSnap: FirebaseFirestore.DocumentSnapshot | null = null
  if (cursor) {
    const curSnap = await adminDb.collection('walletTopups').doc(cursor).get()
    if (curSnap.exists) startSnap = curSnap
  }
  const statusOf = (d: FirebaseFirestore.DocumentSnapshot) => {
    const s = (d.data() as { status?: unknown } | undefined)?.status
    return typeof s === 'string' ? s : 'pending'
  }

  let pageDocs: FirebaseFirestore.QueryDocumentSnapshot[]
  let nextCursor: string | null
  if (!status) {
    let query = base.limit(pageSize + 1)
    if (startSnap) query = query.startAfter(startSnap) as typeof query
    const snap    = await query.get()
    const hasMore = snap.docs.length > pageSize
    pageDocs   = hasMore ? snap.docs.slice(0, pageSize) : snap.docs
    nextCursor = hasMore ? pageDocs[pageDocs.length - 1].id : null
  } else {
    pageDocs = []
    let last: FirebaseFirestore.QueryDocumentSnapshot | null = null
    let examined = 0
    let exhausted = false
    while (pageDocs.length < pageSize && examined < STATUS_SCAN_LIMIT) {
      const n = Math.min(STATUS_SCAN_BATCH, STATUS_SCAN_LIMIT - examined)
      let query = base.limit(n)
      const from = last ?? startSnap
      if (from) query = query.startAfter(from) as typeof query
      const snap = await query.get()
      for (const d of snap.docs) {
        examined++
        last = d
        if (statusOf(d) === status) pageDocs.push(d)
        if (pageDocs.length === pageSize) break
      }
      if (pageDocs.length < pageSize && snap.docs.length < n) { exhausted = true; break }
    }
    nextCursor = exhausted || !last ? null : last.id
  }

  const items: AdminWalletTopupItem[] = await Promise.all(pageDocs.map(async doc => {
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
      holdResolved:  !!d.holdResolvedAt,
    }
  }))

  return NextResponse.json({ items, nextCursor } satisfies AdminWalletTopupsResponse)
}
