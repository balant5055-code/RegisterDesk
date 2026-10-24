// /api/admin/finance/refund-holds — Super Admin review of settlement holds caused by refunds.
//
//   GET [?cursor=ptx_…&limit=1..200]
//                       → one page of settlement transactions carrying a refund hold, in id order;
//                         `nextCursor` is set while more remain (Phase 3.3 — stable cursor paging).
//   GET ?id=ptx_…       → one hold, with its audit history.
//   POST { ptxId, outcome, reason, confirm: true, expectedRefundIds, requestId }
//                       → ONE explicit decision. Outcomes (lib/settlements/refundHoldReview.ts):
//                           record_review        — a review note; the hold STAYS
//                           lift_hold_no_refund  — only on verified evidence that no refund money left
//                         Anything else (debit the organizer, absorb the loss, "release anyway") is NOT
//                         offered: those need a business decision this workflow does not invent (400).
//
// Super Admin only (ADMIN_UIDS, server-side — requireSuperAdmin). A 3–500 character reason and
// `confirm: true` are required before anything is read for a decision. Never moves money, never calls a
// gateway refund endpoint (a lift only reads Razorpay's refund list), never changes a wallet.

import { NextRequest, NextResponse } from 'next/server'
import { adminDb } from '@/lib/firebase/admin'
import { requireSuperAdmin, parseFinancialReason, reasonErrorResponse } from '@/lib/admin/financialGuard'
import {
  listRefundHolds, getRefundHold, resolveRefundHold,
  type RefundHoldView,
} from '@/lib/settlements/refundHoldReview'
import { isRefundHoldOutcome, REFUND_HOLD_OUTCOMES } from '@/lib/settlements/refundHoldRules'

export interface RefundHoldsListResponse { items: RefundHoldView[]; truncated: boolean; nextCursor: string | null }
export interface RefundHoldDetailResponse {
  hold: RefundHoldView
  audit: Array<{ id: string; action: string; adminUid: string | null; reason: string | null; at: string | null; outcome: string | null }>
}

const iso = (v: unknown): string | null => v && typeof (v as { toDate?: () => Date }).toDate === 'function' ? (v as { toDate: () => Date }).toDate().toISOString() : null

export async function GET(req: NextRequest): Promise<NextResponse> {
  const guard = await requireSuperAdmin(req)
  if (guard.response) return guard.response
  const id = req.nextUrl.searchParams.get('id')
  try {
    if (!id) {
      const cursor = req.nextUrl.searchParams.get('cursor')
      if (cursor !== null && !/^ptx_[A-Za-z0-9_-]{1,200}$/.test(cursor)) return NextResponse.json({ error: 'Invalid cursor.' }, { status: 400 })
      const limitRaw = Number(req.nextUrl.searchParams.get('limit') ?? 100)
      const list = await listRefundHolds(Number.isInteger(limitRaw) && limitRaw >= 1 && limitRaw <= 200 ? limitRaw : 100, cursor)
      return NextResponse.json(list satisfies RefundHoldsListResponse, { headers: { 'Cache-Control': 'no-store' } })
    }
    const hold = await getRefundHold(id)
    if (!hold) return NextResponse.json({ error: 'No refund hold on this settlement transaction.' }, { status: 404 })
    const auditSnap = await adminDb.collection('adminAuditLogs').where('entityId', '==', id).limit(100).get()
    const audit = auditSnap.docs
      .map(d => {
        const a = d.data() as { action?: unknown; adminUid?: unknown; reason?: unknown; createdAt?: unknown; metadata?: { outcome?: unknown } }
        return { id: d.id, action: String(a.action ?? ''), adminUid: typeof a.adminUid === 'string' ? a.adminUid : null,
          reason: typeof a.reason === 'string' ? a.reason : null, at: iso(a.createdAt),
          outcome: typeof a.metadata?.outcome === 'string' ? a.metadata.outcome : null }
      })
      .filter(a => a.action.startsWith('settlement.refund_hold_'))
      .sort((a, b) => (a.at ?? '').localeCompare(b.at ?? ''))
    return NextResponse.json({ hold, audit } satisfies RefundHoldDetailResponse, { headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    console.error('[admin/refund-holds] read failed', err)
    return NextResponse.json({ error: 'Failed to load refund holds' }, { status: 500 })
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const guard = await requireSuperAdmin(req)
  if (guard.response) return guard.response

  let body: { ptxId?: unknown; outcome?: unknown; reason?: unknown; confirm?: unknown; expectedRefundIds?: unknown; requestId?: unknown }
  try { body = await req.json() as typeof body } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  if (!isRefundHoldOutcome(body.outcome)) {
    return NextResponse.json({
      error: `Unsupported outcome. Offered: ${REFUND_HOLD_OUTCOMES.join(', ')}. Releasing a partially refunded settlement (debiting the organizer, absorbing the loss or releasing anyway) needs a business decision and is not offered.`,
      code: 'UNSUPPORTED_OUTCOME',
    }, { status: 400 })
  }
  const r = parseFinancialReason(body.reason)
  if (!r.ok) return reasonErrorResponse(r)
  if (body.confirm !== true) return NextResponse.json({ error: 'Explicit confirmation is required.', code: 'CONFIRMATION_REQUIRED' }, { status: 400 })
  if (typeof body.ptxId !== 'string' || !Array.isArray(body.expectedRefundIds) || typeof body.requestId !== 'string') {
    return NextResponse.json({ error: 'ptxId, expectedRefundIds and requestId are required.', code: 'INVALID_REQUEST' }, { status: 400 })
  }

  try {
    const res = await resolveRefundHold({
      ptxId: body.ptxId, outcome: body.outcome, reason: r.reason, adminUid: guard.uid,
      expectedRefundIds: body.expectedRefundIds.filter((x): x is string => typeof x === 'string'), requestId: body.requestId,
    })
    if (!res.ok) return NextResponse.json({ error: res.error, code: res.code, ...(res.why ? { why: res.why } : {}) }, { status: res.status })
    return NextResponse.json(res, { headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    // The decision and its audit row commit together: a failure here means NOTHING was decided.
    console.error('[admin/refund-holds] decision failed', err)
    return NextResponse.json({ error: 'The decision could not be recorded. Nothing was changed — try again.', code: 'DECISION_FAILED' }, { status: 500 })
  }
}
