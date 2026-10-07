// GET  /api/admin/wallet-topups/review?cursor=   — held wallet top-ups awaiting review
// POST /api/admin/wallet-topups/review           — decide one
//
// RD-WALLET-W2.f — Super Admin review of HELD wallet top-ups (lib/wallet/topupReview.ts).
// Authorization: `requireSuperAdmin` (ADMIN_UIDS only) on BOTH methods — a caller holding only the
// legacy `admin: true` claim gets 403 SUPER_ADMIN_REQUIRED, and cannot even list the records.
//
// POST body: { recordId, action: 'credit' | 'resolve', reason, refundReference? }
//   credit  — re-verifies the exact captured payment at the gateway, then credits through the
//             exactly-once wallet transaction; the review record and audit commit with it.
//   resolve — closes the record without credit; a duplicate captured payment requires the external
//             refund reference (no refund is made here).
// Every input is validated here and every rule re-checked server-side; a decision on a record that
// is no longer held is a 409 and changes nothing.

import { NextRequest, NextResponse } from 'next/server'
import { requireSuperAdmin, parseFinancialReason, reasonErrorResponse } from '@/lib/admin/financialGuard'
import { captureFinancialError } from '@/lib/monitoring/sentry'
import {
  creditHeldTopup, resolveHeldTopup, listHeldTopupRecords, parseRefundReference, isReviewRecordId, TopupReviewError,
} from '@/lib/wallet/topupReview'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const NO_STORE = { 'Cache-Control': 'no-store' }

export async function GET(req: NextRequest): Promise<NextResponse> {
  const gate = await requireSuperAdmin(req)
  if (gate.response) return gate.response
  try {
    return NextResponse.json(await listHeldTopupRecords({ cursor: req.nextUrl.searchParams.get('cursor') }), { headers: NO_STORE })
  } catch (err) {
    captureFinancialError(err, { scope: 'admin.wallet_topup_review.list' })
    return NextResponse.json({ error: 'Could not load held top-ups. Please try again.' }, { status: 500, headers: NO_STORE })
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const gate = await requireSuperAdmin(req)
  if (gate.response) return gate.response
  const adminUid = gate.uid

  let body: { recordId?: unknown; action?: unknown; reason?: unknown; refundReference?: unknown }
  try { body = await req.json() as typeof body }
  catch { return NextResponse.json({ error: 'Invalid JSON', code: 'INVALID_JSON' }, { status: 400 }) }

  if (!isReviewRecordId(body.recordId)) {
    return NextResponse.json({ error: 'A valid recordId is required.', code: 'INVALID_RECORD_ID' }, { status: 400 })
  }
  if (body.action !== 'credit' && body.action !== 'resolve') {
    return NextResponse.json({ error: "action must be 'credit' or 'resolve'", code: 'INVALID_ACTION' }, { status: 400 })
  }
  const r = parseFinancialReason(body.reason)
  if (!r.ok) return reasonErrorResponse(r)
  const ref = parseRefundReference(body.refundReference)
  if (!ref.ok) return NextResponse.json({ error: ref.error, code: ref.code }, { status: 400 })
  if (body.action === 'credit' && ref.value) {
    return NextResponse.json({ error: 'A refund reference belongs to a resolution, not a credit.', code: 'REFUND_REFERENCE_NOT_ALLOWED' }, { status: 400 })
  }

  try {
    const outcome = body.action === 'credit'
      ? await creditHeldTopup({ adminUid, recordId: body.recordId, reason: r.reason })
      : await resolveHeldTopup({ adminUid, recordId: body.recordId, reason: r.reason, refundReference: ref.value })
    return NextResponse.json(outcome, { headers: NO_STORE })
  } catch (err) {
    if (err instanceof TopupReviewError) {
      return NextResponse.json({ error: err.message, code: err.code, ...(err.detail ? { detail: err.detail } : {}) }, { status: err.status, headers: NO_STORE })
    }
    captureFinancialError(err, { scope: 'admin.wallet_topup_review.decide', recordId: body.recordId, action: body.action })
    // Not "nothing changed": an interrupted commit can still have applied. A repeat is safe (a decided
    // record answers 409), so the console reloads the list to show the real state.
    return NextResponse.json({ error: 'The decision could not be confirmed. Reload the list to see the record’s current state before trying again.', code: 'REVIEW_FAILED' }, { status: 500, headers: NO_STORE })
  }
}
