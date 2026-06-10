// Server-only: Firebase Admin SDK.
// Stores payment intents for paid registrations.
// Written before Razorpay checkout opens; updated atomically with registration creation.

import { FieldValue } from 'firebase-admin/firestore'
import { adminDb }    from '@/lib/firebase/admin'

export type PaymentIntentStatus = 'created' | 'paid' | 'failed' | 'registration_failed'
export type RefundStatus        = 'pending' | 'processed' | 'failed'

export interface PaymentIntentRecord {
  orderId:      string           // Razorpay order ID
  eventSlug:    string
  passId:       string
  passName:     string
  passCapacity: number | null    // null = unlimited — used in verify-payment capacity check
  eventName:    string
  organizerUid: string
  amount:       number           // paise — authoritative server amount, never from client
  currency:     'INR'
  attendee: {
    name:           string
    email:          string
    phone?:         string
    formResponses?: Record<string, unknown>
  }
  uid?:           string         // Firebase Auth uid if signed in
  status:         PaymentIntentStatus
  registrationId?: string        // set atomically when registration is created
  paymentId?:      string        // Razorpay payment ID, set after verification
  // M2: refund tracking — populated when automatic refund is triggered
  refundId?:       string        // Razorpay refund ID
  refundStatus?:   RefundStatus
  refundAmount?:   number        // paise — should equal amount for full refunds
  failureReason?:  string        // why registration creation failed
  createdAt:       unknown       // Firestore Timestamp
  updatedAt:       unknown       // Firestore Timestamp
}

export async function createPaymentIntent(
  data: Omit<PaymentIntentRecord, 'status' | 'createdAt' | 'updatedAt'>,
): Promise<void> {
  await adminDb.collection('paymentIntents').doc(data.orderId).set({
    ...data,
    status:    'created',
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  })
}

export async function getPaymentIntent(orderId: string): Promise<PaymentIntentRecord | null> {
  const snap = await adminDb.collection('paymentIntents').doc(orderId).get()
  if (!snap.exists) return null
  return snap.data() as PaymentIntentRecord
}

export async function markPaymentIntentFailed(
  orderId:       string,
  failureReason?: string,
): Promise<void> {
  await adminDb.collection('paymentIntents').doc(orderId).update({
    status: 'registration_failed',
    ...(failureReason ? { failureReason } : {}),
    updatedAt: FieldValue.serverTimestamp(),
  })
}

// M2: Called after a successful Razorpay refund API call.
export async function updatePaymentIntentRefund(
  orderId:      string,
  refundId:     string,
  refundStatus: RefundStatus,
  refundAmount: number,
): Promise<void> {
  await adminDb.collection('paymentIntents').doc(orderId).update({
    refundId,
    refundStatus,
    refundAmount,
    updatedAt: FieldValue.serverTimestamp(),
  })
}
