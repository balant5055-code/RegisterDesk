// GET  /api/admin/wallet-service-requests/[id]   — one request + its CURRENT figures (re-derived)
// POST /api/admin/wallet-service-requests/[id]   — decide it
//
// RD-WALLET-REQ — Super Admin decisions (lib/wallet/serviceRequests.ts). `requireSuperAdmin` on both.
// POST body: { action: 'approve' | 'reject' | 'mark_processed', reason, approvedAmountPaise?, externalReference? }
//   approve         refund: units leave the ledger and `approvedAmountPaise` (≤ the server's upper
//                   bound) is recorded — NO money moves. carry-forward: units move to the destination.
//   reject          nothing changes but the request.
//   mark_processed  refunds only, after an APPROVED refund was made outside this system: requires the
//                   external refund reference, recorded as entered (not verified or invented here).
// Every decision needs a reason, is re-checked in one transaction with its audit row, and a repeat
// of a decision already made changes nothing.

import { NextRequest, NextResponse } from 'next/server'
import { requireSuperAdmin, parseFinancialReason, reasonErrorResponse } from '@/lib/admin/financialGuard'
import { captureFinancialError } from '@/lib/monitoring/sentry'
import { getAdminRequest, decideServiceRequest, ServiceRequestError } from '@/lib/wallet/serviceRequests'
import { isServiceRequestAction, parseExternalReference } from '@/lib/wallet/serviceRequestRules'

export const dynamic = 'force-dynamic'
const NO_STORE = { 'Cache-Control': 'no-store' }
const bad = (error: string, code: string, status = 400) => NextResponse.json({ error, code }, { status, headers: NO_STORE })

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const gate = await requireSuperAdmin(req)
  if (gate.response) return gate.response
  const { id } = await ctx.params
  try {
    const r = await getAdminRequest(id)
    if (!r) return NextResponse.json({ error: 'Request not found.' }, { status: 404, headers: NO_STORE })
    return NextResponse.json(r, { headers: NO_STORE })
  } catch (err) {
    captureFinancialError(err, { scope: 'admin.wallet_service_requests.get' })
    return NextResponse.json({ error: 'Could not load the request. Please try again.' }, { status: 500, headers: NO_STORE })
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const gate = await requireSuperAdmin(req)
  if (gate.response) return gate.response
  const { id } = await ctx.params
  let body: Record<string, unknown>
  try { body = await req.json() as Record<string, unknown> }
  catch { return bad('Invalid JSON', 'INVALID_JSON') }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return bad('Invalid JSON', 'INVALID_JSON')

  if (!isServiceRequestAction(body.action)) return bad("action must be 'approve', 'reject' or 'mark_processed'", 'INVALID_ACTION')
  const r = parseFinancialReason(body.reason)
  if (!r.ok) return reasonErrorResponse(r)
  let externalReference: string | null = null
  if (body.action === 'mark_processed') {
    const ref = parseExternalReference(body.externalReference)
    if (!ref.ok) return bad(ref.error, 'EXTERNAL_REFERENCE_INVALID')
    externalReference = ref.value
  } else if (body.externalReference !== undefined && body.externalReference !== null && body.externalReference !== '') {
    return bad('An external reference is recorded only when marking a refund processed.', 'EXTERNAL_REFERENCE_NOT_ALLOWED')
  }
  const amt = body.approvedAmountPaise
  if (amt !== undefined && amt !== null && body.action !== 'approve') return bad('An amount is set only when approving a refund.', 'AMOUNT_NOT_ALLOWED')
  if (amt !== undefined && amt !== null && typeof amt !== 'number') return bad('The amount must be a number of paise.', 'AMOUNT_INVALID')
  // S2 — the amount ACTUALLY refunded outside RegisterDesk, recorded only with "mark processed".
  const refunded = body.refundedAmountPaise
  if (refunded !== undefined && refunded !== null && body.action !== 'mark_processed') return bad('The refunded amount is recorded only when marking a refund processed.', 'REFUNDED_AMOUNT_NOT_ALLOWED')
  if (body.action === 'mark_processed' && (typeof refunded !== 'number' || !Number.isInteger(refunded))) return bad('Enter the amount actually refunded (whole paise).', 'REFUNDED_AMOUNT_REQUIRED')
  try {
    const outcome = await decideServiceRequest({
      adminUid: gate.uid, id, action: body.action, reason: r.reason,
      approvedAmountPaise: typeof amt === 'number' ? amt : null, externalReference,
      refundedAmountPaise: typeof refunded === 'number' ? refunded : null,
    })
    return NextResponse.json(outcome, { headers: NO_STORE })
  } catch (err) {
    if (err instanceof ServiceRequestError) return bad(err.message, err.code, err.status)
    captureFinancialError(err, { scope: 'admin.wallet_service_requests.decide', id, action: body.action })
    return NextResponse.json({ error: 'The decision could not be confirmed. Reload the request to see its current state before trying again.', code: 'DECISION_FAILED' }, { status: 500, headers: NO_STORE })
  }
}
