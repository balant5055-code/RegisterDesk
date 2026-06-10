// Server-side only. Called from the Razorpay webhook handler after payment verification.
// Records that communication billing is paid.
//
// IMPORTANT: Razorpay webhook signature MUST be verified before calling this function.
//
// INTENTIONALLY INCOMPLETE: This function only updates the billing record.
// It does NOT publish the event.  Publishing must go through the full
// /api/events/publish flow which creates the public events/{slug} document,
// initialises the registration counter, and validates the draft atomically.
// Calling ref.update({ status: 'published' }) here would mark the draft as
// published without creating that document — producing a permanently broken event.

import { FieldValue } from 'firebase-admin/firestore'
import { adminDb }    from '@/lib/firebase/admin'

interface CompletePaymentInput {
  uid:       string
  draftId:   string
  paymentId: string   // Razorpay payment_id from the verified webhook payload
}

interface CompletePaymentResult {
  success:   boolean
  published: boolean
  error?:    string
}

export async function completeCommunicationPayment(
  input: CompletePaymentInput,
): Promise<CompletePaymentResult> {
  const { uid, draftId, paymentId } = input
  const ref = adminDb.doc(`users/${uid}/eventDrafts/${draftId}`)

  // Load the current draft
  const snap = await ref.get()
  if (!snap.exists) {
    return { success: false, published: false, error: 'Draft not found' }
  }

  const data    = snap.data() as Record<string, unknown>
  const billing = data.communicationBilling as Record<string, unknown> | null | undefined

  // Safety: only process if a pending billing record exists
  if (!billing || billing.status !== 'pending') {
    return { success: false, published: false, error: 'No pending payment record found' }
  }

  // Mark billing as paid
  await ref.update({
    'communicationBilling.status':      'paid',
    'communicationBilling.paymentId':   paymentId,
    'communicationBilling.purchasedAt': FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  })

  // Billing recorded successfully.  The organizer must now publish the event
  // through the normal publish flow (/api/events/publish), which will pass
  // validateEventPublish (communication billing status is now 'paid') and
  // create the public events/{slug} document atomically.
  return { success: true, published: false }
}
