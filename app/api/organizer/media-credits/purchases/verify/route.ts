// POST /api/organizer/media-credits/purchases/verify
//
// Called by the browser after Razorpay Checkout reports success. Verifies the payment
// SERVER-SIDE and grants the credits.
//
// Body: { orderId, paymentId, signature }
//
// ═══ THE CLIENT'S CALLBACK IS NOT EVIDENCE ═══════════════════════════════════
// This route does not believe anything the browser tells it about the outcome. The signature
// is recomputed here, and the payment itself is re-fetched from Razorpay and matched against
// the stored intent. Every check lives in `purchaseService.completePurchase`; this file only
// maps its outcomes onto status codes.
//
// ═══ 202 IS NOT AN ERROR ═════════════════════════════════════════════════════
// If the payment is genuine but the grant transaction failed, the answer is 202 with
// `pending: true` — the money is safe, the debt is recorded, and the client must NOT be
// nudged into paying again. Only a payment that failed verification gets a 4xx.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeWorkspace } from '@/lib/team/workspace'
import { organizerStatusGuard } from '@/lib/admin/organizerStatus'
import { purchaseService } from '@/features/media-credits/services/purchaseService'
import {
  CreditGrantDeferredError, CreditsDisabledError, PaymentVerificationError,
} from '@/features/media-credits/errors'

export async function POST(req: NextRequest): Promise<NextResponse> {
  const authz = await authorizeWorkspace(req, 'wallet')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  const uid = authz.workspaceUid

  const blocked = await organizerStatusGuard(uid)
  if (blocked) return NextResponse.json({ error: blocked.message }, { status: 403 })

  let orderId: string, paymentId: string, signature: string
  try {
    const body = await req.json() as Record<string, unknown>
    orderId   = String(body.orderId   ?? '')
    paymentId = String(body.paymentId ?? '')
    signature = String(body.signature ?? '')
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  if (!orderId || !paymentId || !signature) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
  }

  try {
    const result = await purchaseService.completePurchase({
      organizerUid: uid, orderId, paymentId, signature, actorUid: authz.callerUid,
    })
    return NextResponse.json(
      { success: true, ...result },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (err) {
    if (err instanceof CreditsDisabledError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 403 })
    }
    if (err instanceof PaymentVerificationError) {
      // `err.reason` is logged, never returned: telling a caller WHICH check failed turns
      // this endpoint into an oracle for probing the verifier.
      console.error('[media-credits/verify] rejected:', err.reason, { orderId, uid })
      return NextResponse.json({ error: err.message, code: err.code }, { status: 400 })
    }
    if (err instanceof CreditGrantDeferredError) {
      return NextResponse.json(
        { success: false, pending: true, purchaseId: err.purchaseId, error: err.message },
        { status: 202 },
      )
    }
    console.error('[media-credits/verify] unexpected failure:', err)
    return NextResponse.json(
      { error: 'Could not verify payment. Please try again.' },
      { status: 502 },
    )
  }
}
