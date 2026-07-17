// Never throws — email failures are logged but must not block the promote flow.

import { notificationEngine, NotificationType, NotificationChannel } from '@/lib/notifications'
import { writeEmailLog }    from '@/lib/email-logs/write'
import type { WaitlistDocument } from './types'

export async function sendSpotAvailableEmail(
  entry:       WaitlistDocument,
  registerUrl: string,
): Promise<void> {
  if (!notificationEngine.isAvailable(NotificationChannel.EMAIL)) return

  let emailStatus: 'sent' | 'failed' = 'failed'
  let emailFailureReason: string | undefined

  try {
    const result = await notificationEngine.send(NotificationType.WAITLIST_SPOT_AVAILABLE, {
      to:           entry.attendee.email,
      attendeeName: entry.attendee.name,
      eventName:    entry.eventName,
      passName:     entry.passName,
      registerUrl,
    })
    emailStatus = result.success ? 'sent' : 'failed'
    if (!result.success) emailFailureReason = result.error
  } catch (err) {
    emailFailureReason = err instanceof Error ? err.message : 'Unknown error'
    console.error(`[spot-available-email] Unexpected error for ${entry.id}:`, err)
  }

  void writeEmailLog({
    organizerUid:   entry.organizerUid,
    eventId:        entry.eventSlug,
    eventSlug:      entry.eventSlug,
    eventName:      entry.eventName,
    templateKey:    'spot_available',
    recipientEmail: entry.attendee.email,
    recipientName:  entry.attendee.name,
    subject:        `A spot is available for ${entry.eventName}`,
    status:         emailStatus === 'sent' ? 'sent' : 'failed',
    provider:       'ses',
    error:          emailFailureReason,
  })
}
