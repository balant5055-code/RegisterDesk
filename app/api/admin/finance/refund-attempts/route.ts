// /api/admin/finance/refund-attempts — Phase 3 · G9: donation refund ATTEMPTS whose gateway outcome is
// unknown, on donations whose settlement was already released (no settlement hold to review).
//
//   GET [?cursor=<donationId>&limit=1..100]
//                        → one page of donations with an unresolved refund attempt, in donation-id order;
//                          `nextCursor` is set while more remain (Phase 3.3 — stable cursor paging)
//   POST { donationId, attemptId, reason, confirm: true, requestId }
//                        → resolve ONE attempt on authoritative evidence (lib/donations/refundService.ts ·
//                          resolveReleasedDonationRefundAttempt): ≥ 15 min old AND Razorpay's refund list read
//                          successfully. A refund carrying the attempt id → linked to it; none, with every
//                          listed refund already recorded → resolved_none (reservation freed, audited);
//                          anything contradictory or unreadable → nothing changes.
//
// Super Admin only (ADMIN_UIDS, server-side — requireSuperAdmin). A 3–500 character reason and
// `confirm: true` are required. Never calls a gateway refund endpoint (only the read-only refund list),
// never retries a refund, never touches a wallet directly.

import { NextRequest, NextResponse } from 'next/server'
import { FieldPath } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import { requireSuperAdmin, parseFinancialReason, reasonErrorResponse } from '@/lib/admin/financialGuard'
import { resolveReleasedDonationRefundAttempt } from '@/lib/donations/refundService'
import type { DonationDocument } from '@/lib/donations/types'

export const maxDuration = 60

const DONATION_ID_RE = /^[A-Za-z0-9_-]{1,200}$/
const ATTEMPT_ID_RE  = /^att_[A-Za-z0-9_-]{8,80}$/
const REQUEST_ID_RE  = /^[A-Za-z0-9_-]{8,64}$/
const iso = (v: unknown): string | null => v && typeof (v as { toDate?: () => Date }).toDate === 'function' ? (v as { toDate: () => Date }).toDate().toISOString() : null

export interface RefundAttemptView {
  donationId: string; attemptId: string; status: string; amountPaise: number; paymentId: string
  by: string; startedAt: string | null; error: string | null
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const guard = await requireSuperAdmin(req)
  if (guard.response) return guard.response
  const cursor = req.nextUrl.searchParams.get('cursor')
  if (cursor !== null && !DONATION_ID_RE.test(cursor)) return NextResponse.json({ error: 'Invalid cursor.' }, { status: 400 })
  const limitRaw = Number(req.nextUrl.searchParams.get('limit') ?? 100)
  const limit = Number.isInteger(limitRaw) && limitRaw >= 1 && limitRaw <= 100 ? limitRaw : 100
  try {
    // Equality + document-id order: the automatic single-field index serves it (no composite index).
    let q = adminDb.collection('donations').where('hasOpenRefundAttempt', '==', true).orderBy(FieldPath.documentId())
    if (cursor) q = q.startAfter(cursor)
    const snap = await q.limit(limit + 1).get()
    const page = snap.docs.slice(0, limit)
    const items: RefundAttemptView[] = []
    for (const doc of page) {
      const d = doc.data() as DonationDocument
      for (const [attemptId, a] of Object.entries(d.refundAttempts ?? {})) {
        if (a.status !== 'submitting' && a.status !== 'unknown') continue
        items.push({ donationId: doc.id, attemptId, status: a.status, amountPaise: a.amountPaise, paymentId: a.paymentId, by: a.by, startedAt: iso(a.startedAt), error: a.error ?? null })
      }
    }
    const more = snap.size > limit
    return NextResponse.json({ items, truncated: more, nextCursor: more ? page[page.length - 1].id : null }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    console.error('[admin/refund-attempts] read failed', err)
    return NextResponse.json({ error: 'Failed to load refund attempts' }, { status: 500 })
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const guard = await requireSuperAdmin(req)
  if (guard.response) return guard.response
  let body: { donationId?: unknown; attemptId?: unknown; reason?: unknown; confirm?: unknown; requestId?: unknown }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid request body' }, { status: 400 }) }
  const reason = parseFinancialReason(body.reason)
  if (!reason.ok) return reasonErrorResponse(reason)
  if (body.confirm !== true) return NextResponse.json({ error: 'Explicit confirmation is required.', code: 'CONFIRMATION_REQUIRED' }, { status: 400 })
  if (typeof body.donationId !== 'string' || !DONATION_ID_RE.test(body.donationId)
    || typeof body.attemptId !== 'string' || !ATTEMPT_ID_RE.test(body.attemptId)
    || typeof body.requestId !== 'string' || !REQUEST_ID_RE.test(body.requestId)) {
    return NextResponse.json({ error: 'donationId, attemptId and requestId are required.', code: 'INVALID_INPUT' }, { status: 400 })
  }
  try {
    const r = await resolveReleasedDonationRefundAttempt({
      donationId: body.donationId, attemptId: body.attemptId, adminUid: guard.uid, reason: reason.reason, requestId: body.requestId,
    })
    if (!r.ok) return NextResponse.json({ error: r.error, code: r.code, ...(r.detail ? { detail: r.detail } : {}) }, { status: r.status })
    return NextResponse.json(r)
  } catch (err) {
    console.error('[admin/refund-attempts] resolve failed', err)
    return NextResponse.json({ error: 'The resolution could not be recorded. Nothing was changed.', code: 'RESOLUTION_FAILED' }, { status: 500 })
  }
}
