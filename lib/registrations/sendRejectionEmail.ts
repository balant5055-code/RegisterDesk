// Shared rejection email sender.
// Triggered fire-and-forget from /api/organizer/registrations/[registrationId]/reject
// and /api/organizer/registrations/bulk-reject.
//
// Never throws.

import { FieldValue }               from 'firebase-admin/firestore'
import { adminDb }                   from '@/lib/firebase/admin'
import { notificationEngine, NotificationType, NotificationChannel } from '@/lib/notifications'
import { writeEmailLog }             from '@/lib/email-logs/write'
import type { RegistrationDocument } from './types'

export async function sendRejectionEmail(
  registrationId: string,
  reason?:        string,
): Promise<void> {
  if (!notificationEngine.isAvailable(NotificationChannel.EMAIL)) return

  const regSnap = await adminDb.collection('registrations').doc(registrationId).get()
  if (!regSnap.exists) return
  const reg = regSnap.data() as RegistrationDocument

  let emailStatus: 'sent' | 'failed' = 'failed'
  let emailFailureReason: string | undefined

  try {
    const result = await notificationEngine.send(NotificationType.REGISTRATION_REJECTED, {
      to:           reg.attendee.email,
      attendeeName: reg.attendee.name,
      eventName:    reg.eventName,
      ticketCode:   reg.ticketCode,
      reason,
    })
    emailStatus = result.success ? 'sent' : 'failed'
    if (!result.success) {
      emailFailureReason = result.error
      console.error(`[reject-email] Failed for ${registrationId}:`, result.error)
    }
  } catch (err) {
    emailFailureReason = err instanceof Error ? err.message : 'Unknown error'
    console.error(`[reject-email] Unexpected error for ${registrationId}:`, err)
  }

  adminDb.collection('registrations').doc(registrationId).update({
    emailStatus,
    ...(emailStatus === 'sent'
      ? { emailSentAt: FieldValue.serverTimestamp() }
      : { emailFailureReason }),
  }).catch(e => console.error('[reject-email] Failed to persist emailStatus:', e))

  void writeEmailLog({
    organizerUid:   reg.organizerUid,
    eventId:        reg.eventSlug,
    eventSlug:      reg.eventSlug,
    eventName:      reg.eventName,
    templateKey:    'registration_rejected',
    recipientEmail: reg.attendee.email,
    recipientName:  reg.attendee.name,
    subject:        `Registration update for ${reg.eventName}`,
    status:         emailStatus === 'sent' ? 'sent' : 'failed',
    provider:       'ses',
    error:          emailFailureReason,
    registrationId,
  })
}
