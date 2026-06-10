// POST /api/organizer/wallet/topup/verify
//
// Called by the client immediately after Razorpay checkout succeeds.
// Verifies the HMAC signature, then credits the organizer wallet.
//
// Body: { orderId, paymentId, signature }

import crypto                                 from 'crypto'
import { NextRequest, NextResponse }          from 'next/server'
import { FieldValue }                         from 'firebase-admin/firestore'
import { adminAuth, adminDb }                 from '@/lib/firebase/admin'
import { creditWallet }                       from '@/lib/firebase/firestore/wallet'
import type { WalletTopupVerifyResponse }     from '@/types/events'

const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET ?? ''

interface TopupRecord {
  uid:         string
  amountPaise: number
  status:      string
}

export async function POST(req: NextRequest): Promise<NextResponse<WalletTopupVerifyResponse>> {
  // ── Auth ──────────────────────────────────────────────────────────────────────
  const token = (req.headers.get('authorization') ?? '').replace('Bearer ', '')
  if (!token) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  let uid: string
  try {
    uid = (await adminAuth.verifyIdToken(token)).uid
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid or expired token' }, { status: 401 })
  }

  // ── Parse body ────────────────────────────────────────────────────────────────
  let orderId: string, paymentId: string, signature: string
  try {
    const body = await req.json() as Record<string, unknown>
    orderId   = String(body.orderId   ?? '')
    paymentId = String(body.paymentId ?? '')
    signature = String(body.signature ?? '')
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid request body' }, { status: 400 })
  }

  if (!orderId || !paymentId || !signature) {
    return NextResponse.json({ success: false, error: 'Missing required fields' }, { status: 400 })
  }

  // ── Verify HMAC signature ─────────────────────────────────────────────────────
  const expected = crypto
    .createHmac('sha256', KEY_SECRET)
    .update(`${orderId}|${paymentId}`)
    .digest('hex')

  const sigBuffer = Buffer.from(signature, 'hex')
  const expBuffer = Buffer.from(expected,  'hex')
  const valid     = sigBuffer.length === expBuffer.length &&
                    crypto.timingSafeEqual(sigBuffer, expBuffer)

  if (!valid) {
    return NextResponse.json({ success: false, error: 'Payment signature verification failed' }, { status: 400 })
  }

  // ── Load topup record ─────────────────────────────────────────────────────────
  const topupRef  = adminDb.collection('walletTopups').doc(orderId)
  const topupSnap = await topupRef.get()

  if (!topupSnap.exists) {
    return NextResponse.json({ success: false, error: 'Topup order not found' }, { status: 404 })
  }

  const topup = topupSnap.data() as TopupRecord

  // Ownership check
  if (topup.uid !== uid) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  // Idempotency — already credited
  if (topup.status === 'credited') {
    const balance = await import('@/lib/firebase/firestore/wallet').then(m => m.getWalletBalance(uid))
    return NextResponse.json({ success: true, newBalance: balance })
  }

  // ── Credit wallet ─────────────────────────────────────────────────────────────
  const newBalance = await creditWallet(uid, topup.amountPaise)

  // Mark topup record as credited
  await topupRef.update({
    status:    'credited',
    paymentId,
    updatedAt: FieldValue.serverTimestamp(),
  })

  return NextResponse.json({ success: true, newBalance })
}
