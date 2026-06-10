// POST /api/organizer/registrations/[registrationId]/refund
//
// Issues a full Razorpay refund for a paid registration.
// Idempotent: a second call on an already-refunded registration returns 409.

import { NextRequest, NextResponse }    from 'next/server'
import { FieldValue }                   from 'firebase-admin/firestore'
import { adminAuth, adminDb }           from '@/lib/firebase/admin'
import { razorpay }                     from '@/lib/razorpay/client'
import { updatePaymentIntentRefund }    from '@/lib/firebase/firestore/paymentIntents'
import { writeAuditEntry }              from '@/lib/firebase/firestore/registrations'
import type { RegistrationDocument }    from '@/lib/registrations/types'
import type { PaymentIntentRecord }     from '@/lib/firebase/firestore/paymentIntents'

export interface RefundRegistrationResponse {
  success:      boolean
  refundId?:    string
  refundAmount?: number
  error?:        string
}

export async function POST(
  req:     NextRequest,
  context: { params: Promise<{ registrationId: string }> },
): Promise<NextResponse<RefundRegistrationResponse>> {
  // ── 1. Auth ────────────────────────────────────────────────────────────────
  const token = (req.headers.get('authorization') ?? '').replace(/^Bearer /, '')
  if (!token) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  let uid: string
  try {
    uid = (await adminAuth.verifyIdToken(token)).uid
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid or expired token' }, { status: 401 })
  }

  const { registrationId } = await context.params
  if (!registrationId) {
    return NextResponse.json({ success: false, error: 'registrationId is required' }, { status: 400 })
  }

  // ── 2. Load registration ───────────────────────────────────────────────────
  const regRef  = adminDb.collection('registrations').doc(registrationId)
  const regSnap = await regRef.get()
  if (!regSnap.exists) {
    return NextResponse.json({ success: false, error: 'Registration not found' }, { status: 404 })
  }

  const reg = regSnap.data() as RegistrationDocument
  if (reg.organizerUid !== uid) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  // ── 3. Guard: only paid registrations can be refunded ─────────────────────
  if (reg.paymentStatus === 'refunded') {
    return NextResponse.json(
      { success: false, error: 'Registration has already been refunded' },
      { status: 409 },
    )
  }
  if (reg.paymentStatus !== 'paid') {
    return NextResponse.json(
      { success: false, error: 'Only paid registrations can be refunded' },
      { status: 400 },
    )
  }

  // ── 4. Find the payment intent for this registration ──────────────────────
  const piSnap = await adminDb
    .collection('paymentIntents')
    .where('registrationId', '==', registrationId)
    .limit(1)
    .get()

  if (piSnap.empty) {
    return NextResponse.json(
      { success: false, error: 'Payment record not found — cannot issue refund' },
      { status: 422 },
    )
  }

  const pi = piSnap.docs[0].data() as PaymentIntentRecord
  const { paymentId, amount: refundAmount, orderId } = pi

  if (!paymentId) {
    return NextResponse.json(
      { success: false, error: 'Razorpay payment ID not recorded — cannot issue refund' },
      { status: 422 },
    )
  }

  // ── 5. Issue refund via Razorpay ───────────────────────────────────────────
  let refundId: string
  try {
    const refund = await razorpay.payments.refund(paymentId, { amount: refundAmount, speed: 'optimum' })
    refundId = refund.id
  } catch (err) {
    console.error('[refund] Razorpay API error:', { registrationId, paymentId, err })
    return NextResponse.json(
      { success: false, error: 'Razorpay refund failed. Please try again or contact support.' },
      { status: 502 },
    )
  }

  // ── 6. Persist refund state ────────────────────────────────────────────────
  // Update registration: paymentStatus → 'refunded', store refundId + refundAmount
  await regRef.update({
    paymentStatus: 'refunded',
    refundId,
    refundAmount,
    refundedAt: FieldValue.serverTimestamp(),
    updatedAt:  FieldValue.serverTimestamp(),
  })

  // Update paymentIntents (best-effort — Razorpay refund already succeeded)
  updatePaymentIntentRefund(orderId, refundId, 'processed', refundAmount).catch(err =>
    console.error('[refund] Failed to update paymentIntents:', err),
  )

  // ── 7. Audit entry (fire-and-forget) ──────────────────────────────────────
  writeAuditEntry(registrationId, 'refunded', uid, 'organizer').catch(err =>
    console.error('[refund] Failed to write audit entry:', err),
  )

  return NextResponse.json({ success: true, refundId, refundAmount })
}
