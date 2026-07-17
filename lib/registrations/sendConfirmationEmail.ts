// Shared confirmation email sender.
//
// Used by three callers:
//   - /api/registrations/submit        (free passes, auto-confirmed)
//   - /api/registrations/verify-payment (paid passes, client-side verification)
//   - /api/webhooks/razorpay            (paid passes, server-side recovery)
//
// Never throws: email failures are logged and stored in Firestore but must never
// interrupt the registration or webhook-recovery flow.

import { FieldValue }                     from 'firebase-admin/firestore'
import { adminDb }                         from '@/lib/firebase/admin'
import { fmtEmailDate }                    from '@/lib/email'
import { notificationEngine, NotificationType, NotificationChannel } from '@/lib/notifications'
import { signTicketToken }                 from '@/lib/tickets/generate'
import { signReceiptToken }                from '@/lib/receipts/token'
import { writeEmailLog }                   from '@/lib/email-logs/write'
import { generateIcs }                     from '@/lib/calendar/ics'
import { sendWhatsAppConfirmation }         from './sendWhatsAppConfirmation'

// ─── Args ─────────────────────────────────────────────────────────────────────

export interface ConfirmationEmailArgs {
  registrationId: string
  ticketCode:     string
  attendeeName:   string
  attendeeEmail:  string
  eventName:      string
  passName:       string
  /** Full EventDetailsDraft object stored in Firestore under eventDetails. */
  rawDetails:     Record<string, unknown>
  organizerUid:   string
  eventSlug:      string
  /** Paise amount paid — when > 0, a receipt download link is included in the email. */
  amountPaid?:    number
}

// ─── Sender ───────────────────────────────────────────────────────────────────

export async function sendConfirmationEmail(args: ConfirmationEmailArgs): Promise<void> {
  if (!notificationEngine.isAvailable(NotificationChannel.EMAIL)) return  // email not configured — skip silently

  const {
    registrationId, ticketCode, attendeeName, attendeeEmail,
    eventName, passName, rawDetails, organizerUid, eventSlug, amountPaid,
  } = args

  // Extract schedule + venue from the denormalised EventDetailsDraft
  const schedule  = rawDetails.schedule as Record<string, unknown> | null
  const startDate = typeof schedule?.startDate === 'string' ? schedule.startDate : ''
  const startTime = typeof schedule?.startTime === 'string' ? schedule.startTime : ''

  const venueRaw  = rawDetails.venue as Record<string, unknown> | null
  const venueType = typeof venueRaw?.type === 'string' ? venueRaw.type : ''
  const physical  = venueRaw?.physical as Record<string, unknown> | null
  const online    = venueRaw?.online   as Record<string, unknown> | null
  const venueName = venueType === 'online'
    ? (typeof online?.platform === 'string' ? online.platform : 'Online')
    : (typeof physical?.name   === 'string' ? physical.name   : '')
  const venueCity = venueType !== 'online'
    ? (typeof physical?.city === 'string' ? physical.city : '')
    : ''

  const baseUrl      = process.env.NEXT_PUBLIC_APP_URL ?? ''
  const pdfToken     = signTicketToken(registrationId)
  const pdfUrl       = `${baseUrl}/api/tickets/${registrationId}/pdf?token=${encodeURIComponent(pdfToken)}`
  const receiptToken = amountPaid && amountPaid > 0 ? signReceiptToken(registrationId) : null
  const receiptUrl   = receiptToken
    ? `${baseUrl}/api/receipts/${registrationId}?token=${encodeURIComponent(receiptToken)}`
    : undefined

  // Build ICS attachment if organizer enabled calendarInvite
  const commConfig   = rawDetails.communication as Record<string, unknown> | null
  const calendarInviteEnabled =
    (commConfig?.confirmation as Record<string, unknown> | null)?.calendarInvite === true

  let icsContent: string | undefined
  if (calendarInviteEnabled && startDate) {
    const endDate    = typeof schedule?.endDate   === 'string' ? schedule.endDate   : startDate
    const endTime    = typeof schedule?.endTime   === 'string' ? schedule.endTime   : ''
    const description = (rawDetails.info as Record<string, unknown> | null)
    const desc       = typeof description?.shortDesc === 'string'
      ? description.shortDesc
      : typeof description?.fullDesc === 'string' ? description.fullDesc : ''
    const physicalAddr = [
      typeof physical?.addressLine1 === 'string' ? physical.addressLine1 : '',
      typeof physical?.city         === 'string' ? physical.city         : '',
    ].filter(Boolean).join(', ')
    const locationStr = venueType === 'online'
      ? (typeof online?.platform === 'string' ? `${online.platform} (Online)` : 'Online')
      : physicalAddr || venueName
    try {
      icsContent = generateIcs({
        uid:         `${eventSlug}@registerdesk.in`,
        title:       eventName,
        description: desc,
        location:    locationStr,
        url:         `${baseUrl}/events/${eventSlug}`,
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
    const result = await notificationEngine.send(NotificationType.REGISTRATION_CONFIRMATION, {
      to:             attendeeEmail,
      attendeeName,
      eventName,
      eventDate:      fmtEmailDate(startDate) || startDate,
      eventTime:      startTime  || undefined,
      venueName:      venueName  || undefined,
      venueCity:      venueCity  || undefined,
      ticketCode,
      passName,
      registrationId,
      ticketPageUrl:      `${baseUrl}/tickets/${registrationId}`,
      pdfDownloadUrl:     pdfUrl,
      receiptDownloadUrl: receiptUrl,
      icsContent,
    })

    emailStatus = result.success ? 'sent' : 'failed'
    if (!result.success) {
      emailFailureReason = result.error
      console.error(`[email] Registration email failed for ${registrationId}:`, result.error)
    }
  } catch (err) {
    emailFailureReason = err instanceof Error ? err.message : 'Unknown error'
    console.error(`[email] Unexpected error sending registration email for ${registrationId}:`, err)
  }

  // Persist email status on the registration doc — fire-and-forget (non-critical).
  adminDb.collection('registrations').doc(registrationId).update({
    emailStatus,
    ...(emailStatus === 'sent'
      ? { emailSentAt: FieldValue.serverTimestamp() }
      : { emailFailureReason }),
  }).catch(updateErr =>
    console.error(`[email] Failed to persist emailStatus for ${registrationId}:`, updateErr),
  )

  // Write email log entry — fire-and-forget.
  void writeEmailLog({
    organizerUid,
    eventId:        eventSlug,
    eventSlug,
    eventName,
    templateKey:    'registration_submitted',
    recipientEmail: attendeeEmail,
    recipientName:  attendeeName,
    subject:        `Registration confirmation for ${eventName}`,
    status:         emailStatus === 'sent' ? 'sent' : 'failed',
    provider:       'ses',
    error:          emailFailureReason,
    registrationId,
  })

  // Attendee WhatsApp confirmation (Phase G3.4) — paid channel, applied AFTER the
  // free email and only when the organizer enabled WhatsApp + the wallet is funded.
  // Fire-and-forget: it never throws and never affects the registration or email.
  void sendWhatsAppConfirmation({
    registrationId,
    organizerUid,
    eventSlug,
    attendeeName,
    eventName,
    ticketCode,
  })
}
