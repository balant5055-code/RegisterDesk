// /api/admin/finance/refund-reviews — Phase 3.3 · E: donation refunds whose ACCOUNTING is in `needs_review`
// (retries exhausted, a permanent failure, or contradictory gateway signals).
//
//   GET  ?cursor=<refundId>&limit=<1..100>
//                        → one page, in refund-id order (a stable cursor: no skips, no duplicates);
//                          `nextCursor` is set while more remain
//   POST { refundId, action, attemptId?, reason, confirm: true, requestId }
//                        → resolve ONE refund on fresh read-only gateway evidence
//                          (lib/donations/refundService.ts · resolveDonationRefundReview):
//                          retry_accounting | record_failed | link_attempt. Contradictory or
//                          inconclusive evidence changes nothing.
//   POST { refundId, action: 'resolve_conflict', outcome: 'processed'|'failed',
//          evidence: { source, reference, observation }, reason, confirm: true, requestId }
//                        → Phase 3.4: close a CONTRADICTORY outcome only when Razorpay's own refund record (read
//                          now) and the cited settlement/bank evidence agree (resolveDonationRefundConflict);
//                          a disagreement is recorded and the conflict stays. No force-resolve exists.
//
// Super Admin only (ADMIN_UIDS, server-side — requireSuperAdmin). A 3–500 character reason and
// `confirm: true` are required. Never calls a gateway refund endpoint (only the read-only refund list),
// never lifts a settlement hold, never touches a wallet except through the normal accounting.

import { NextRequest, NextResponse } from 'next/server'
import { FieldPath } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import { requireSuperAdmin, parseFinancialReason, reasonErrorResponse } from '@/lib/admin/financialGuard'
import { resolveDonationRefundReview, resolveDonationRefundConflict, type RefundReviewAction, type ConflictEvidence } from '@/lib/donations/refundService'
import type { DonationRefundDocument } from '@/lib/donations/types'

export const maxDuration = 60

const REFUND_ID_RE  = /^[A-Za-z0-9_-]{1,200}$/
const ATTEMPT_ID_RE = /^att_[A-Za-z0-9_-]{8,80}$/
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,64}$/
const ACTIONS: ReadonlySet<string> = new Set<RefundReviewAction>(['retry_accounting', 'record_failed', 'link_attempt'])
const iso = (v: unknown): string | null => v && typeof (v as { toDate?: () => Date }).toDate === 'function' ? (v as { toDate: () => Date }).toDate().toISOString() : null

export interface RefundReviewView {
  refundId: string; donationId: string; organizerUid: string; amountPaise: number; status: string; initiatedBy: string
  attempts: number; lastError: string | null; conflict: string | null; gatewayEvidence: string | null
  createdAt: string | null; lastAttemptAt: string | null
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const guard = await requireSuperAdmin(req)
  if (guard.response) return guard.response
  const cursor = req.nextUrl.searchParams.get('cursor')
  if (cursor !== null && !REFUND_ID_RE.test(cursor)) return NextResponse.json({ error: 'Invalid cursor.' }, { status: 400 })
  const limitRaw = Number(req.nextUrl.searchParams.get('limit') ?? 50)
  const limit = Number.isInteger(limitRaw) && limitRaw >= 1 && limitRaw <= 100 ? limitRaw : 50
  try {
    // Equality + document-id order: served by the automatic single-field index (no composite index).
    let q = adminDb.collection('donationRefunds').where('accountingRecovery.state', '==', 'needs_review').orderBy(FieldPath.documentId())
    if (cursor) q = q.startAfter(cursor)
    const snap = await q.limit(limit + 1).get()
    const page = snap.docs.slice(0, limit)
    const items: RefundReviewView[] = page.map(doc => {
      const r = doc.data() as DonationRefundDocument
      const a = r.accountingRecovery
      return {
        refundId: doc.id, donationId: r.donationId, organizerUid: r.organizerUid, amountPaise: r.amountPaise, status: r.status, initiatedBy: r.initiatedBy,
        attempts: a?.attempts ?? 0, lastError: a?.lastError ?? null, conflict: a?.conflict ?? null, gatewayEvidence: a?.gatewayEvidence ?? null,
        createdAt: iso(r.createdAt), lastAttemptAt: iso(a?.lastAttemptAt),
      }
    })
    const nextCursor = snap.size > limit ? page[page.length - 1].id : null
    return NextResponse.json({ items, nextCursor }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    console.error('[admin/refund-reviews] read failed', err)
    return NextResponse.json({ error: 'Failed to load refunds awaiting review' }, { status: 500 })
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const guard = await requireSuperAdmin(req)
  if (guard.response) return guard.response
  let body: { refundId?: unknown; action?: unknown; attemptId?: unknown; reason?: unknown; confirm?: unknown; requestId?: unknown; outcome?: unknown; evidence?: unknown }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid request body' }, { status: 400 }) }
  const reason = parseFinancialReason(body.reason)
  if (!reason.ok) return reasonErrorResponse(reason)
  if (body.confirm !== true) return NextResponse.json({ error: 'Explicit confirmation is required.', code: 'CONFIRMATION_REQUIRED' }, { status: 400 })
  if (body.action === 'resolve_conflict') {
    if (typeof body.refundId !== 'string' || !REFUND_ID_RE.test(body.refundId) || typeof body.requestId !== 'string' || !REQUEST_ID_RE.test(body.requestId)
      || (body.outcome !== 'processed' && body.outcome !== 'failed') || !body.evidence || typeof body.evidence !== 'object') {
      return NextResponse.json({ error: 'refundId, outcome, evidence and requestId are required.', code: 'INVALID_INPUT' }, { status: 400 })
    }
    try {
      const r = await resolveDonationRefundConflict({
        refundId: body.refundId, outcome: body.outcome, evidence: body.evidence as ConflictEvidence, adminUid: guard.uid, reason: reason.reason, requestId: body.requestId,
      })
      if (!r.ok) return NextResponse.json({ error: r.error, code: r.code, ...(r.investigation ? { investigation: r.investigation } : {}), ...(r.detail ? { detail: r.detail } : {}) }, { status: r.status })
      return NextResponse.json(r)
    } catch (err) {
      console.error('[admin/refund-reviews] conflict resolution failed', err)
      return NextResponse.json({ error: 'The resolution could not be recorded. Nothing was changed.', code: 'RESOLUTION_FAILED' }, { status: 500 })
    }
  }
  if (typeof body.refundId !== 'string' || !REFUND_ID_RE.test(body.refundId)
    || typeof body.action !== 'string' || !ACTIONS.has(body.action)
    || typeof body.requestId !== 'string' || !REQUEST_ID_RE.test(body.requestId)
    || (body.attemptId !== undefined && (typeof body.attemptId !== 'string' || !ATTEMPT_ID_RE.test(body.attemptId)))) {
    return NextResponse.json({ error: 'refundId, a valid action and requestId are required.', code: 'INVALID_INPUT' }, { status: 400 })
  }
  try {
    const r = await resolveDonationRefundReview({
      refundId: body.refundId, action: body.action as RefundReviewAction, attemptId: (body.attemptId as string | undefined) ?? null,
      adminUid: guard.uid, reason: reason.reason, requestId: body.requestId,
    })
    if (!r.ok) return NextResponse.json({ error: r.error, code: r.code, ...(r.detail ? { detail: r.detail } : {}) }, { status: r.status })
    return NextResponse.json(r)
  } catch (err) {
    console.error('[admin/refund-reviews] resolve failed', err)
    return NextResponse.json({ error: 'The resolution could not be recorded. Nothing was changed.', code: 'RESOLUTION_FAILED' }, { status: 500 })
  }
}
