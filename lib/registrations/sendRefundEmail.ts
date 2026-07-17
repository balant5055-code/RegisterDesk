// Shared refund confirmation email sender.
// Triggered fire-and-forget from /api/organizer/registrations/[registrationId]/refund
// after the Razorpay refund is persisted (step 7).
//
// Reads refundAmount and refundId from the registration doc which has already been
// updated before this function is called.
//
// Never throws.

import { adminDb }                   from '@/lib/firebase/admin'
import { notificationEngine, NotificationType, NotificationChannel } from '@/lib/notifications'
import { writeEmailLog }             from '@/lib/email-logs/write'
import type { RegistrationDocument } from './types'

export async function sendRefundEmail(registrationId: string): Promise<void> {
  if (!notificationEngine.isAvailable(NotificationChannel.EMAIL)) return

  const regSnap = await adminDb.collection('registrations').doc(registrationId).get()
  if (!regSnap.exists) return
  const reg = regSnap.data() as RegistrationDocument

  if (!reg.refundId || reg.refundAmount == null) {
    console.warn(`[refund-email] Missing refundId or refundAmount for ${registrationId} — skipping`)
    return
  }

  let emailStatus: 'sent' | 'failed' = 'failed'

  try {
    const result = await notificationEngine.send(NotificationType.REFUND_SUCCESS, {
      to:           reg.attendee.email,
      attendeeName: reg.attendee.name,
      eventName:    reg.eventName,
      ticketCode:   reg.ticketCode,
      passName:     reg.passName,
      refundAmount: reg.refundAmount,
      refundId:     reg.refundId,
    })
    emailStatus = result.success ? 'sent' : 'failed'
    if (!result.success) {
      console.error(`[refund-email] Failed for ${registrationId}:`, result.error)
    }
  } catch (err) {
    console.error(`[refund-email] Unexpected error for ${registrationId}:`, err)
  }

  void writeEmailLog({
    organizerUid:   reg.organizerUid,
    eventId:        reg.eventSlug,
    eventSlug:      reg.eventSlug,
    eventName:      reg.eventName,
    templateKey:    'refund_confirmed',
    recipientEmail: reg.attendee.email,
    recipientName:  reg.attendee.name,
    subject:        `Refund confirmed for ${reg.eventName}`,
    status:         emailStatus === 'sent' ? 'sent' : 'failed',
    provider:       'ses',
    registrationId,
  })
}
