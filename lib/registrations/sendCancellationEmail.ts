// Shared registration-cancellation email sender.
// Triggered fire-and-forget from /api/organizer/registrations/[registrationId]/cancel.
//
// Note: this is distinct from the event-level cancellation email (sendEventCancelledEmail),
// which goes out to all attendees when an event itself is cancelled.
//
// Never throws.

import { FieldValue }               from 'firebase-admin/firestore'
import { adminDb }                   from '@/lib/firebase/admin'
import { notificationEngine, NotificationType, NotificationChannel } from '@/lib/notifications'
import { resolveEventEmailProvider } from '@/lib/email/resolveEventProvider'
import { writeEmailLog }             from '@/lib/email-logs/write'
import { loadOrganizerEmailBranding, resolveEmailBranding } from '@/lib/email/branding'
import type { RegistrationDocument } from './types'

export async function sendCancellationEmail(
  registrationId: string,
  reason?:        string,
): Promise<void> {
  if (!notificationEngine.isAvailable(NotificationChannel.EMAIL)) return

  const regSnap = await adminDb.collection('registrations').doc(registrationId).get()
  if (!regSnap.exists) return
  const reg = regSnap.data() as RegistrationDocument

  let emailStatus: 'sent' | 'failed' = 'failed'
  let emailFailureReason: string | undefined
  const branding = resolveEmailBranding(await loadOrganizerEmailBranding(reg.organizerUid))   // RD-PRODUCT-01C

  try {
    const result = await notificationEngine.send(NotificationType.REGISTRATION_CANCELLED, {
      to:           reg.attendee.email,
      attendeeName: reg.attendee.name,
      eventName:    reg.eventName,
      ticketCode:   reg.ticketCode,
      reason,
      branding,
    }, await resolveEventEmailProvider(reg.eventSlug))
    emailStatus = result.success ? 'sent' : 'failed'
    if (!result.success) {
      emailFailureReason = result.error
      console.error(`[cancel-email] Failed for ${registrationId}:`, result.error)
    }
  } catch (err) {
    emailFailureReason = err instanceof Error ? err.message : 'Unknown error'
    console.error(`[cancel-email] Unexpected error for ${registrationId}:`, err)
  }

  adminDb.collection('registrations').doc(registrationId).update({
    emailStatus,
    ...(emailStatus === 'sent'
      ? { emailSentAt: FieldValue.serverTimestamp() }
      : { emailFailureReason }),
  }).catch(e => console.error('[cancel-email] Failed to persist emailStatus:', e))

  void writeEmailLog({
    organizerUid:   reg.organizerUid,
    eventId:        reg.eventSlug,
    eventSlug:      reg.eventSlug,
    eventName:      reg.eventName,
    templateKey:    'registration_cancelled',
    recipientEmail: reg.attendee.email,
    recipientName:  reg.attendee.name,
    subject:        `Your registration for ${reg.eventName} has been cancelled`,
    status:         emailStatus === 'sent' ? 'sent' : 'failed',
    provider:       'ses',
    error:          emailFailureReason,
    registrationId,
  })
}
