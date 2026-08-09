// /api/organizer/media-credits/refunds
//
//   POST — request a refund for one fully-unused purchase
//   GET  — this workspace's refund history
//
// An organizer may REQUEST ONLY. Nothing here approves, and no wallet or ledger is touched
// by either verb — the request is a record, and only an admin approval moves money.
//
// Authorization is `wallet`, matching the purchase endpoints: asking for money back is the
// same financial concern as spending it.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeWorkspace } from '@/lib/team/workspace'
import { organizerStatusGuard } from '@/lib/admin/organizerStatus'
import { checkRateLimit } from '@/lib/rateLimit'
import { refundService } from '@/features/media-credits/services/refundService'
import {
  CreditsDisabledError, InsufficientCreditsError, InvalidCreditOperationError,
  RefundNotAllowedError,
} from '@/features/media-credits/errors'

export async function POST(req: NextRequest): Promise<NextResponse> {
  const authz = await authorizeWorkspace(req, 'wallet')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  const uid = authz.workspaceUid

  const blocked = await organizerStatusGuard(uid)
  if (blocked) return NextResponse.json({ error: blocked.message }, { status: 403 })

  const rl = checkRateLimit(uid, 'media-credit-refund', 10, 60 * 60 * 1000)
  if (rl.limited) {
    return NextResponse.json(
      { error: 'Too many refund requests. Please try again later.' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil((rl.resetAt - Date.now()) / 1000)) } },
    )
  }

  let purchaseId: string, reason: string
  try {
    const body = await req.json() as Record<string, unknown>
    purchaseId = String(body.purchaseId ?? '').trim()
    reason     = String(body.reason ?? '').trim().slice(0, 500)
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }
  if (!purchaseId) return NextResponse.json({ error: 'purchaseId is required' }, { status: 400 })

  try {
    const refund = await refundService.createRefundRequest({
      organizerUid: uid, purchaseId, reason, requestedBy: authz.callerUid,
    })
    return NextResponse.json({ refund }, { status: 201, headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    if (err instanceof CreditsDisabledError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 403 })
    }
    if (err instanceof RefundNotAllowedError) {
      // `reason` IS returned here, unlike payment verification: these are policy outcomes the
      // organizer needs in order to act ("outside the refund window"), not signals that would
      // help someone probe a verifier.
      return NextResponse.json(
        { error: err.message, code: err.code, reason: err.reason }, { status: 409 },
      )
    }
    if (err instanceof InsufficientCreditsError) {
      return NextResponse.json(
        { error: err.message, code: err.code, required: err.required, available: err.available },
        { status: 409 },
      )
    }
    if (err instanceof InvalidCreditOperationError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 400 })
    }
    console.error('[media-credits/refunds] request failed:', err)
    return NextResponse.json({ error: 'Could not submit this refund request.' }, { status: 503 })
  }
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const authz = await authorizeWorkspace(req, 'wallet')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })

  const url    = new URL(req.url)
  const limit  = Number(url.searchParams.get('limit') ?? '25')
  const cursor = url.searchParams.get('cursor')

  const page = await refundService.listRefundRequests(
    authz.workspaceUid, Number.isFinite(limit) ? limit : 25, cursor,
  )
  return NextResponse.json(page, { headers: { 'Cache-Control': 'no-store' } })
}
