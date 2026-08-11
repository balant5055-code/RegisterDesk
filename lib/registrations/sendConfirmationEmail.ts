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
import { resolveEventEmailProvider } from '@/lib/email/resolveEventProvider'
import { signTicketToken }                 from '@/lib/tickets/generate'
import { signReceiptToken }                from '@/lib/receipts/token'
import { writeEmailLog }                   from '@/lib/email-logs/write'
import { generateIcs }                     from '@/lib/calendar/ics'
import { loadOrganizerEmailBranding, resolveEmailBranding } from '@/lib/email/branding'
import { sendWhatsAppConfirmation }         from './sendWhatsAppConfirmation'
import { sendRegistrationSms }              from './sendRegistrationSms'
import { getEmailAppUrl } from '@/lib/email/appUrl'

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
  // Attendee SMS confirmation (MSG91) — deliberately ABOVE the email-availability guard
  // below. SMS is an independent channel: an event whose EMAIL transport is unconfigured
  // must still get its confirmation SMS, and the early `return` on that guard would
  // otherwise silently swallow it.
  //
  // Still invoked from HERE rather than from the routes, because this function is already
  // the single convergence of submit, verify-payment, the Razorpay webhook and the
  // reconciliation sweep — moving the call out would create a second trigger and defeat
  // the idempotency claim inside sendRegistrationSms. Fire-and-forget, never throws, and a
  // failure changes nothing about the registration, the payment or the email.
  //
  // The ticket URL is resolved defensively: getEmailAppUrl() throws on a deployment whose
  // base URL is misconfigured, and that must degrade the SMS link, not cancel the SMS.
  let smsTicketUrl = ''
  try { smsTicketUrl = `${getEmailAppUrl()}/tickets/${args.registrationId}` } catch { /* link omitted */ }
  void sendRegistrationSms({
    registrationId: args.registrationId,
    organizerUid:   args.organizerUid,
    eventSlug:      args.eventSlug,
    eventName:      args.eventName,
    attendeeName:   args.attendeeName,
    attendeeEmail:  args.attendeeEmail,
    ticketUrl:      smsTicketUrl,
  }).catch(err => console.error(`[sms] confirmation dispatch failed for ${args.registrationId}:`, err))

  // Attendee WhatsApp confirmation (Phase G3.4) — paid channel, sent only when the
  // organizer enabled WhatsApp AND the wallet is funded (both gates live inside the
  // sender, unchanged).
  //
  // Also deliberately ABOVE the email-availability guard below. WhatsApp is an independent
  // channel with its own provider, its own enablement and its own billing; it was
  // previously invoked at the END of this function, so an event whose EMAIL transport was
  // unconfigured silently lost its WhatsApp confirmation too — a channel the organizer had
  // enabled and pre-paid for.
  //
  // Still the SAME single call site, just moved: this function remains the one convergence
  // of submit, verify-payment, the Razorpay webhook and the reconciliation sweep, so the
  // `whatsappStatus === 'sent'` duplicate guard inside the sender is unaffected.
  // Fire-and-forget and never throws, exactly as before.
  void sendWhatsAppConfirmation({
    registrationId: args.registrationId,
    organizerUid:   args.organizerUid,
    eventSlug:      args.eventSlug,
    attendeeName:   args.attendeeName,
    eventName:      args.eventName,
    ticketCode:     args.ticketCode,
  })

  // RD-EMAIL-PROVIDER — resolved once: the transport used AND the transport logged.
  const emailProviderName = await resolveEventEmailProvider(args.eventSlug)

  if (!notificationEngine.isAvailable(NotificationChannel.EMAIL, emailProviderName)) return  // email not configured — skip silently

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

  const baseUrl = getEmailAppUrl()
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

  // RD-PRODUCT-01C — white-label the confirmation email with the organizer's saved
  // branding. Absent/disabled → undefined → default RegisterDesk shell (unchanged).
  const eventLogo = ((rawDetails.media as Record<string, unknown> | null)?.logo as Record<string, unknown> | null)?.value
  const branding = resolveEmailBranding(
    await loadOrganizerEmailBranding(organizerUid),
    { logoUrl: typeof eventLogo === 'string' ? eventLogo : null },
  )

  let emailStatus: 'sent' | 'failed' = 'failed'
  let emailFailureReason: string | undefined

  try {
    const result = await notificationEngine.send(NotificationType.REGISTRATION_CONFIRMATION, {
      to:             attendeeEmail,
      attendeeName,
      eventName,
      branding,
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
    }, emailProviderName)

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
    provider:       emailProviderName,
    error:          emailFailureReason,
    registrationId,
  })

}
