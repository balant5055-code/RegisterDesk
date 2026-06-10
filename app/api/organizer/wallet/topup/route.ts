// POST /api/organizer/wallet/topup
// Creates a Razorpay order for wallet top-up and stores a topup record.
//
// Body: { amountPaise: number }   — minimum 100 paise (₹1)
//
// Returns: { orderId, amount, currency }
//
// Flow:
//   1. Client calls this endpoint to get a Razorpay order.
//   2. Client opens Razorpay checkout.
//   3. On success client calls POST /api/organizer/wallet/topup/verify.
//   4. Webhook (razorpay) handles recovery if client never called verify.

import { NextRequest, NextResponse }         from 'next/server'
import { FieldValue }                         from 'firebase-admin/firestore'
import { adminAuth, adminDb }                 from '@/lib/firebase/admin'
import { razorpay }                           from '@/lib/razorpay/client'
import type { WalletTopupOrderResponse }      from '@/types/events'

const MIN_TOPUP_PAISE = 100   // ₹1 minimum

export async function POST(req: NextRequest): Promise<NextResponse<WalletTopupOrderResponse | { error: string }>> {
  // ── Auth ──────────────────────────────────────────────────────────────────────
  const token = (req.headers.get('authorization') ?? '').replace('Bearer ', '')
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let uid: string
  try {
    uid = (await adminAuth.verifyIdToken(token)).uid
  } catch {
    return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
  }

  // ── Parse body ────────────────────────────────────────────────────────────────
  let amountPaise: number
  try {
    const body = await req.json() as Record<string, unknown>
    amountPaise = typeof body.amountPaise === 'number' ? Math.round(body.amountPaise) : 0
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  if (amountPaise < MIN_TOPUP_PAISE) {
    return NextResponse.json({ error: `Minimum top-up is ₹${MIN_TOPUP_PAISE / 100}` }, { status: 400 })
  }

  // ── Create Razorpay order ──────────────────────────────────────────────────────
  let order: { id: string; amount: number; currency: string }
  try {
    order = await razorpay.orders.create({
      amount:   amountPaise,
      currency: 'INR',
      receipt:  `wallet_${uid.slice(-8)}_${Date.now()}`.slice(0, 40),
      notes:    { purpose: 'wallet_topup', uid },
    }) as { id: string; amount: number; currency: string }
  } catch (err) {
    console.error('[wallet/topup] Razorpay order creation failed:', err)
    return NextResponse.json({ error: 'Payment service unavailable. Please try again.' }, { status: 503 })
  }

  // ── Persist topup record ──────────────────────────────────────────────────────
  await adminDb.collection('walletTopups').doc(order.id).set({
    orderId:     order.id,
    uid,
    amountPaise,
    currency:    'INR',
    status:      'pending',
    createdAt:   FieldValue.serverTimestamp(),
    updatedAt:   FieldValue.serverTimestamp(),
  })

  return NextResponse.json({
    orderId:  order.id,
    amount:   amountPaise,
    currency: 'INR',
  })
}
