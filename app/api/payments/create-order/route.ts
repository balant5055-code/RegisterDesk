// POST /api/payments/create-order
//
// Creates a Razorpay order for communication billing (WhatsApp / SMS add-ons
// on free events).
//
// STATUS: Razorpay integration for communication billing is NOT YET LIVE.
// This route returns 503 to prevent mock/placeholder orders from reaching
// production.  Organizers who need WhatsApp/SMS must disable those features
// to publish; or contact support once the feature is available.
//
// When Razorpay keys for this flow are ready:
//   1. Remove the 503 guard below.
//   2. Restore the billing-record write (commented out for reference).
//   3. Uncomment and wire up the Razorpay SDK call.

import { NextRequest, NextResponse } from 'next/server'
import { adminAuth } from '@/lib/firebase/admin'

export async function POST(req: NextRequest): Promise<NextResponse> {
  // ── 1. Verify Firebase ID token (auth check still runs to avoid leaking info) ──
  const authHeader = req.headers.get('authorization') ?? ''
  const token      = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''

  if (!token) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    await adminAuth.verifyIdToken(token)
  } catch {
    return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
  }

  // ── C-2: Feature not yet available ───────────────────────────────────────
  // Razorpay integration for communication billing has not been completed.
  // Returning 503 instead of a mock order prevents placeholder payment flows
  // from reaching Firestore or the client checkout widget.
  return NextResponse.json(
    {
      error: 'Communication billing is not yet available. To publish your event, ' +
             'please disable WhatsApp and SMS features in the event settings, ' +
             'or contact support.',
    },
    { status: 503 },
  )

  // ── Reference implementation (restore when Razorpay keys are ready) ──────
  //
  // const body = await req.json().catch(() => null)
  // const draftId = (body as Record<string, unknown> | null)?.draftId
  // if (typeof draftId !== 'string' || !draftId) {
  //   return NextResponse.json({ error: 'draftId is required' }, { status: 400 })
  // }
  //
  // const draftRef = adminDb.doc(`users/${uid}/eventDrafts/${draftId}`)
  // const snap     = await draftRef.get()
  // if (!snap.exists) return NextResponse.json({ error: 'Draft not found' }, { status: 404 })
  //
  // const data    = snap.data() as Record<string, unknown>
  // const pricing = data.pricing as Record<string, unknown> | null
  // const isFreeEvent     = pricing?.eventType === 'free'
  // const whatsappEnabled = !!(pricing?.whatsappEnabled)
  // const smsEnabled      = !!(pricing?.smsEnabled)
  //
  // if (!isFreeEvent || (!whatsappEnabled && !smsEnabled)) {
  //   return NextResponse.json({ error: 'Communication payment not required' }, { status: 400 })
  // }
  //
  // const passes = Array.isArray(pricing?.passes) ? (pricing!.passes as Array<...>) : []
  // const estimatedCapacity = passes.reduce((s, p) => s + (p.unlimited ? 100 : (p.quantity ?? 0)), 0) || 100
  // const cost = calculateCommunicationCost({ estimatedCapacity, whatsappEnabled, smsEnabled })
  //
  // await draftRef.update({
  //   communicationBilling: { required: true, amount: cost.totalPaise, status: 'pending',
  //                           paymentId: null, purchasedAt: null },
  //   updatedAt: FieldValue.serverTimestamp(),
  // })
  //
  // const razorpay = new Razorpay({ key_id: RAZORPAY_KEY_ID!, key_secret: RAZORPAY_KEY_SECRET! })
  // const order    = await razorpay.orders.create({ amount: cost.totalPaise, currency: 'INR',
  //                                                 receipt: `comm_${draftId}` })
  //
  // return NextResponse.json({ orderId: order.id, amount: cost.totalPaise,
  //                            currency: 'INR', draftId, breakdown: cost })
}
