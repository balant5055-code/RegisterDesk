// POST /api/licensing/verify — Event License payment VERIFICATION only (Phase D4.5).
//
// Verifies the authenticity of a Razorpay payment for a license purchase and does
// NOTHING else. It reuses the existing shared Razorpay signature verifier
// (RazorpayDonationGateway.verifySignature — a generic order|payment HMAC check);
// it does NOT duplicate the crypto.
//
// STRICT SCOPE: no license document is created, no order/history is written, no
// license is activated, no event is published, and nothing touches wallet,
// billing, or registration. This endpoint only answers "is this payment genuine?".

import { NextRequest, NextResponse } from 'next/server'
import { RazorpayDonationGateway }   from '@/lib/razorpay/donationGateway'
import { authorizeWorkspace } from '@/lib/team/workspace'

const NO_STORE = { 'Cache-Control': 'no-store' } as const

// Reuse the existing shared Razorpay signature verifier (order|payment HMAC).
const razorpaySignatureVerifier = new RazorpayDonationGateway()

export async function POST(req: NextRequest): Promise<NextResponse> {
  // RD-CE-FIX M5 · the same gate as the rest of licensing (capacity/*, checkout/confirm): verified
  // token, the workspace it acts for, suspension of caller OR owner, and the `events` permission —
  // a check-in-only or finance member, or a suspended workspace, cannot buy or read licences here.
  const authz = await authorizeWorkspace(req, 'events')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })

  let body: {
    razorpay_order_id?:   unknown
    razorpay_payment_id?: unknown
    razorpay_signature?:  unknown
    tier?:                unknown
  }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  // Every paid tier (Growth / Professional / Enterprise) is purchased via Razorpay
  // and verified identically here — there is no contact-sales exception.
  const orderId   = typeof body.razorpay_order_id   === 'string' ? body.razorpay_order_id   : ''
  const paymentId = typeof body.razorpay_payment_id === 'string' ? body.razorpay_payment_id : ''
  const signature = typeof body.razorpay_signature  === 'string' ? body.razorpay_signature  : ''
  if (!orderId || !paymentId || !signature) {
    return NextResponse.json(
      { ok: false, verified: false, error: 'razorpay_order_id, razorpay_payment_id and razorpay_signature are required' },
      { status: 400, headers: NO_STORE },
    )
  }

  const verified = razorpaySignatureVerifier.verifySignature({ orderId, paymentId, signature })
  if (!verified) {
    return NextResponse.json(
      { ok: false, verified: false, error: 'Invalid payment signature' },
      { status: 400, headers: NO_STORE },
    )
  }

  // Verification ONLY — no business action follows.
  return NextResponse.json({ ok: true, verified: true }, { status: 200, headers: NO_STORE })
}
