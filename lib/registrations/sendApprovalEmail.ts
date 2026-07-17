// Shared approval email sender.
// Extracted from /api/organizer/registrations/[registrationId]/approve so that
// bulk-approve can also use it without duplicating the fetch + send logic.
//
// Never throws: email failures are logged but must never interrupt the action route.

import { FieldValue }                    from 'firebase-admin/firestore'
import { adminDb }                        from '@/lib/firebase/admin'
import { fmtEmailDate }                   from '@/lib/email'
import { notificationEngine, NotificationType, NotificationChannel } from '@/lib/notifications'
import { signTicketToken }                from '@/lib/tickets/generate'
import { signReceiptToken }               from '@/lib/receipts/token'
import { writeEmailLog }                  from '@/lib/email-logs/write'
import { generateIcs }                    from '@/lib/calendar/ics'
import type { RegistrationDocument }      from './types'

export async function sendApprovalEmail(registrationId: string): Promise<void> {
  if (!notificationEngine.isAvailable(NotificationChannel.EMAIL)) return

  const regSnap = await adminDb.collection('registrations').doc(registrationId).get()
  if (!regSnap.exists) return
  const reg = regSnap.data() as RegistrationDocument

  const eventSnap = await adminDb.collection('events').doc(reg.eventSlug).get()
  const event     = eventSnap.exists ? (eventSnap.data() as Record<string, unknown>) : null
  if (!event) return

  const rawDetails  = event.eventDetails as Record<string, unknown> | null
  const rawSchedule = rawDetails?.schedule as Record<string, unknown> | null
  const rawVenue    = rawDetails?.venue    as Record<string, unknown> | null

  const startDate = typeof rawSchedule?.startDate === 'string' ? rawSchedule.startDate : ''
  const startTime = typeof rawSchedule?.startTime === 'string' ? rawSchedule.startTime : ''

  const venueType = typeof rawVenue?.type === 'string' ? rawVenue.type : ''
  const physical  = rawVenue?.physical as Record<string, unknown> | null
  const online    = rawVenue?.online   as Record<string, unknown> | null
  const venueName = venueType === 'online'
    ? (typeof online?.platform === 'string' ? online.platform : 'Online')
    : (typeof physical?.name   === 'string' ? physical.name   : '')
  const venueCity = venueType !== 'online'
    ? (typeof physical?.city   === 'string' ? physical.city   : '')
    : ''

  const baseUrl      = process.env.NEXT_PUBLIC_APP_URL ?? ''
  const pdfToken     = signTicketToken(registrationId)
  const pdfUrl       = `${baseUrl}/api/tickets/${registrationId}/pdf?token=${encodeURIComponent(pdfToken)}`
  const receiptToken = reg.amount > 0 && reg.paymentStatus === 'paid'
    ? signReceiptToken(registrationId)
    : null
  const receiptUrl   = receiptToken
    ? `${baseUrl}/api/receipts/${registrationId}?token=${encodeURIComponent(receiptToken)}`
    : undefined

  // Build ICS attachment if organizer enabled calendarInvite
  const commConfig   = rawDetails?.communication as Record<string, unknown> | null
  const calendarInviteEnabled =
    (commConfig?.confirmation as Record<string, unknown> | null)?.calendarInvite === true

  let icsContent: string | undefined
  if (calendarInviteEnabled && startDate) {
    const endDate    = typeof rawSchedule?.endDate   === 'string' ? rawSchedule.endDate   : startDate
    const endTime    = typeof rawSchedule?.endTime   === 'string' ? rawSchedule.endTime   : ''
    const infoRaw    = rawDetails?.info as Record<string, unknown> | null
    const desc       = typeof infoRaw?.shortDesc === 'string'
      ? infoRaw.shortDesc
      : typeof infoRaw?.fullDesc === 'string' ? infoRaw.fullDesc : ''
    const physicalAddr = [
      typeof physical?.addressLine1 === 'string' ? physical.addressLine1 : '',
      typeof physical?.city         === 'string' ? physical.city         : '',
    ].filter(Boolean).join(', ')
    const onlineRaw  = rawVenue?.online as Record<string, unknown> | null
    const locationStr = venueType === 'online'
      ? (typeof onlineRaw?.platform === 'string' ? `${onlineRaw.platform} (Online)` : 'Online')
      : physicalAddr || venueName
    try {
      icsContent = generateIcs({
        uid:         `${reg.eventSlug}@registerdesk.in`,
        title:       reg.eventName,
        description: desc,
        location:    locationStr,
        url:         `${baseUrl}/events/${reg.eventSlug}`,
        startDate,
        endDate,
        startTime,
        endTime,
      })
    } catch { /* ICS generation failure must not break email sending */ }
  }

  let emailStatus: 'sent' | 'failed' = 'failed'
  let emailFailureReason: string | undefined

  try {
    const result = await notificationEngine.send(NotificationType.REGISTRATION_APPROVED, {
      to:             reg.attendee.email,
      attendeeName:   reg.attendee.name,
      eventName:      reg.eventName,
      eventDate:      fmtEmailDate(startDate) || startDate,
      eventTime:      startTime  || undefined,
      venueName:      venueName  || undefined,
      venueCity:      venueCity  || undefined,
      ticketCode:         reg.ticketCode,
      passName:           reg.passName,
      registrationId,
      ticketPageUrl:      `${baseUrl}/tickets/${registrationId}`,
      pdfDownloadUrl:     pdfUrl,
      receiptDownloadUrl: receiptUrl,
      icsContent,
    })
    emailStatus = result.success ? 'sent' : 'failed'
    if (!result.success) {
      emailFailureReason = result.error
      console.error(`[approve-email] Failed for ${registrationId}:`, result.error)
    }
  } catch (err) {
    emailFailureReason = err instanceof Error ? err.message : 'Unknown error'
    console.error(`[approve-email] Unexpected error for ${registrationId}:`, err)
  }

  adminDb.collection('registrations').doc(registrationId).update({
    emailStatus,
    ...(emailStatus === 'sent'
      ? { emailSentAt: FieldValue.serverTimestamp() }
      : { emailFailureReason }),
  }).catch(e => console.error('[approve-email] Failed to persist emailStatus:', e))

  void writeEmailLog({
    organizerUid:   reg.organizerUid,
    eventId:        reg.eventSlug,
    eventSlug:      reg.eventSlug,
    eventName:      reg.eventName,
    templateKey:    'registration_approved',
    recipientEmail: reg.attendee.email,
    recipientName:  reg.attendee.name,
    subject:        `Your registration for ${reg.eventName} has been approved`,
    status:         emailStatus === 'sent' ? 'sent' : 'failed',
    provider:       'ses',
    error:          emailFailureReason,
    registrationId,
  })
}
