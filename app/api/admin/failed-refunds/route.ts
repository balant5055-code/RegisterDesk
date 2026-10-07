// GET /api/admin/failed-refunds
//
// Returns all failed refund records with per-page filtering and global open stats.
// Fetches the entire collection in-memory (small admin-only collection) to avoid
// composite index requirements and serve stats independently of the status filter.
//
// Query params:
//   status   — open | retried | resolved | ignored | review | all  (default: open)
//              'review' = RD-PAY-DUP-HOLD duplicate holds: captured payments deliberately
//              NOT auto-refunded. They are excluded from the open stats on purpose — they
//              are not refunds awaiting retry, they are decisions awaiting a human.
//   page     — 1-based page number  (default: 1)
//   pageSize — records per page     (default: 20, max: 50)

import { NextRequest, NextResponse } from 'next/server'
import { requireSuperAdmin } from '@/lib/admin/financialGuard'
import { adminDb }                   from '@/lib/firebase/admin'

// ─── Response types (imported by admin finance page) ─────────────────────────

export interface FailedRefundSummary {
  id:             string
  orderId:        string
  paymentId:      string
  amountPaise:    number
  reason:         string
  eventSlug:      string
  attendeeEmail:  string
  registrationId: string | null
  status:         'open' | 'retried' | 'resolved' | 'ignored' | 'review'
  /**
   * RD-PAY-DUP-HOLD — 'duplicate_hold' is a captured payment deliberately NOT refunded,
   * parked for manual settlement. Records written before this field existed carry no `kind`
   * and are reported as 'failed_refund', so nothing had to be migrated.
   */
  // RD-FIN-02 · 'duplicate_payment_hold' — a SECOND captured payment on an already-paid order.
  kind:           'failed_refund' | 'duplicate_hold' | 'duplicate_payment_hold'
  createdAt:      string | null
  updatedAt:      string | null
}

export interface FailedRefundsStats {
  openCount:           number
  openAmountPaise:     number
  oldestOpenCreatedAt: string | null
}

export interface FailedRefundsResponse {
  refunds:  FailedRefundSummary[]
  total:    number
  page:     number
  pageSize: number
  stats:    FailedRefundsStats
}

// ─── Internal doc shape ───────────────────────────────────────────────────────

interface FailedRefundDoc {
  orderId:        string
  paymentId:      string
  amountPaise:    number
  reason:         string
  eventSlug:      string
  attendeeEmail:  string
  registrationId: string | null
  status:         string
  kind?:          string   // absent on every pre-RD-PAY-DUP-HOLD record ⇒ 'failed_refund'
  createdAt:      unknown
  updatedAt?:     unknown
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function tsToISO(ts: unknown): string | null {
  if (!ts) return null
  if (typeof (ts as { toDate?: () => Date }).toDate === 'function')
    return (ts as { toDate: () => Date }).toDate().toISOString()
  return null
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest): Promise<NextResponse> {
  // RD-CLOSE — a financial read: Super Admin only (ADMIN_UIDS). A legacy `admin: true` claim
  // alone gets 403 SUPER_ADMIN_REQUIRED (lib/admin/financialGuard.ts).
  const superGate = await requireSuperAdmin(req)
  if (superGate.response) return superGate.response

  const { searchParams } = new URL(req.url)
  const statusFilter = searchParams.get('status') ?? 'open'
  const page     = Math.max(1, Number(searchParams.get('page'))     || 1)
  const pageSize = Math.min(50, Math.max(1, Number(searchParams.get('pageSize')) || 20))

  // Fetch all docs ordered by createdAt desc (single-field index, auto-created by Firestore)
  const allSnap = await adminDb.collection('failedRefunds').orderBy('createdAt', 'desc').get()

  // RD-EVENT-COMMERCE-02 — licensing wrote its failed refunds (coupon-exhausted remainder,
  // stale capacity change) with status 'pending', a value this queue never listed or counted,
  // so they were invisible in the default view and the "require attention" stats. They are open
  // failed refunds; they are READ as 'open' here. Stored records are not rewritten.
  const allDocs = allSnap.docs.map(doc => {
    const d = doc.data() as FailedRefundDoc
    return { id: doc.id, ...d, status: d.status === 'pending' ? 'open' : d.status }
  })

  // Compute stats from open docs only (always global, regardless of filter)
  const openDocs = allDocs.filter(d => d.status === 'open')
  const openAmountPaise = openDocs.reduce((sum, d) => sum + (d.amountPaise ?? 0), 0)
  // allDocs is sorted desc — last open element is the oldest
  const oldestOpenCreatedAt = openDocs.length > 0
    ? tsToISO(openDocs[openDocs.length - 1].createdAt)
    : null

  const stats: FailedRefundsStats = {
    openCount:           openDocs.length,
    openAmountPaise,
    oldestOpenCreatedAt,
  }

  // Filter and paginate in memory
  const filtered  = statusFilter === 'all' ? allDocs : allDocs.filter(d => d.status === statusFilter)
  const total     = filtered.length
  const paginated = filtered.slice((page - 1) * pageSize, page * pageSize)

  const refunds: FailedRefundSummary[] = paginated.map(d => ({
    id:             d.id,
    orderId:        d.orderId        ?? '',
    paymentId:      d.paymentId      ?? '',
    amountPaise:    d.amountPaise    ?? 0,
    reason:         d.reason         ?? '',
    eventSlug:      d.eventSlug      ?? '',
    attendeeEmail:  d.attendeeEmail  ?? '',
    registrationId: d.registrationId ?? null,
    status:         (d.status as FailedRefundSummary['status']) ?? 'open',
    kind:           d.kind === 'duplicate_hold' || d.kind === 'duplicate_payment_hold' ? d.kind : 'failed_refund',
    createdAt:      tsToISO(d.createdAt),
    updatedAt:      tsToISO(d.updatedAt),
  }))

  return NextResponse.json({ refunds, total, page, pageSize, stats } satisfies FailedRefundsResponse)
}
