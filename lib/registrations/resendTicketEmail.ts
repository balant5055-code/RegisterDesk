// Shared ticket-email resend (GA-7E S1). Server-only.
//
// Extracted VERBATIM from the organizer resend-email route so the organizer route AND
// the admin support route share ONE implementation and one send path — reusing the
// notification engine (TICKET_RESENT) and the ticket-token signer. No second mail
// engine. The CALLER handles authorization and its own audit trail; this only performs
// the guards + send + emailStatus persistence.

import { FieldValue } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import { getEventBySlug } from '@/lib/firebase/firestore/events'
import { signTicketToken } from '@/lib/tickets/generate'
import { fmtEmailDate } from '@/lib/email'
import { notificationEngine, NotificationType, NotificationChannel } from '@/lib/notifications'
import type { RegistrationDocument } from '@/lib/registrations/types'

export type ResendResult = { ok: true } | { ok: false; error: string; status: number }

/**
 * Resends the ticket email for a registration. Enforces the same eligibility guards as
 * before (not cancelled/rejected/refunded, email provider configured), sends via the
 * notification engine, and persists emailStatus. Never throws.
 */
export async function resendRegistrationTicketEmail(registrationId: string): Promise<ResendResult> {
  const regSnap = await adminDb.collection('registrations').doc(registrationId).get()
  if (!regSnap.exists) return { ok: false, error: 'Registration not found', status: 404 }
  const reg = regSnap.data() as RegistrationDocument

  if (reg.status === 'cancelled')          return { ok: false, error: 'Cannot resend email for a cancelled registration.', status: 422 }
  if (reg.status === 'rejected')           return { ok: false, error: 'Cannot resend email for a rejected registration.', status: 422 }
  if (reg.paymentStatus === 'refunded')    return { ok: false, error: 'Cannot resend email for a refunded registration.', status: 422 }
  if (!notificationEngine.isAvailable(NotificationChannel.EMAIL)) {
    return { ok: false, error: 'Email provider is not configured. Set SES_FROM_EMAIL and AWS credentials.', status: 503 }
  }

  // Event date/venue details for the email body.
  const event    = await getEventBySlug(reg.eventSlug)
  const rawDet   = (event?.eventDetails as Record<string, unknown> | null) ?? {}
  const schedule = rawDet.schedule as Record<string, unknown> | null
  const startDate = typeof schedule?.startDate === 'string' ? schedule.startDate : ''
  const startTime = typeof schedule?.startTime === 'string' ? schedule.startTime : ''

  const venueRaw  = rawDet.venue as Record<string, unknown> | null
  const venueType = typeof venueRaw?.type === 'string' ? venueRaw.type : ''
  const physical  = venueRaw?.physical as Record<string, unknown> | null
  const online    = venueRaw?.online   as Record<string, unknown> | null
  const venueName = venueType === 'online'
    ? (typeof online?.platform === 'string' ? online.platform : 'Online')
    : (typeof physical?.name === 'string' ? physical.name : '')
  const venueCity = venueType !== 'online'
    ? (typeof physical?.city === 'string' ? physical.city : '')
    : ''

  const baseUrl  = process.env.NEXT_PUBLIC_APP_URL ?? ''
  const pdfToken = signTicketToken(registrationId)
  const pdfUrl   = `${baseUrl}/api/tickets/${registrationId}/pdf?token=${encodeURIComponent(pdfToken)}`

  let emailStatus: 'sent' | 'failed' = 'failed'
  let emailFailureReason: string | undefined
  try {
    const result = await notificationEngine.send(NotificationType.TICKET_RESENT, {
      to:             reg.attendee.email,
      attendeeName:   reg.attendee.name,
      eventName:      reg.eventName,
      eventDate:      fmtEmailDate(startDate) || startDate,
      eventTime:      startTime || undefined,
      venueName:      venueName || undefined,
      venueCity:      venueCity || undefined,
      ticketCode:     reg.ticketCode,
      passName:       reg.passName,
      registrationId,
      ticketPageUrl:  `${baseUrl}/tickets/${registrationId}`,
      pdfDownloadUrl: pdfUrl,
    })
    emailStatus = result.success ? 'sent' : 'failed'
    if (!result.success) emailFailureReason = result.error
  } catch (err) {
    emailFailureReason = err instanceof Error ? err.message : 'Unknown error'
    console.error(`[email] resend-ticket error for ${registrationId}:`, err)
  }

  adminDb.collection('registrations').doc(registrationId).update({
    emailStatus,
    ...(emailStatus === 'sent' ? { emailSentAt: FieldValue.serverTimestamp() } : { emailFailureReason }),
  }).catch(err => console.error(`[email] Failed to persist emailStatus for ${registrationId}:`, err))

  if (emailStatus === 'sent') return { ok: true }
  return { ok: false, error: emailFailureReason ?? 'Email delivery failed.', status: 502 }
}
