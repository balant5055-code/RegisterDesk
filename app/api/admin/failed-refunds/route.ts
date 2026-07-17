// GET /api/admin/failed-refunds
//
// Returns all failed refund records with per-page filtering and global open stats.
// Fetches the entire collection in-memory (small admin-only collection) to avoid
// composite index requirements and serve stats independently of the status filter.
//
// Query params:
//   status   — open | retried | resolved | ignored | all  (default: open)
//   page     — 1-based page number  (default: 1)
//   pageSize — records per page     (default: 20, max: 50)

import { NextRequest, NextResponse } from 'next/server'
import { adminDb }                   from '@/lib/firebase/admin'
import { resolveAdminUid }           from '@/lib/admin/auth'

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
  status:         'open' | 'retried' | 'resolved' | 'ignored'
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
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { searchParams } = new URL(req.url)
  const statusFilter = searchParams.get('status') ?? 'open'
  const page     = Math.max(1, Number(searchParams.get('page'))     || 1)
  const pageSize = Math.min(50, Math.max(1, Number(searchParams.get('pageSize')) || 20))

  // Fetch all docs ordered by createdAt desc (single-field index, auto-created by Firestore)
  const allSnap = await adminDb.collection('failedRefunds').orderBy('createdAt', 'desc').get()

  const allDocs = allSnap.docs.map(doc => ({
    id: doc.id,
    ...(doc.data() as FailedRefundDoc),
  }))

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
    createdAt:      tsToISO(d.createdAt),
    updatedAt:      tsToISO(d.updatedAt),
  }))

  return NextResponse.json({ refunds, total, page, pageSize, stats } satisfies FailedRefundsResponse)
}
