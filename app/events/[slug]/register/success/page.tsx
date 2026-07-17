// /events/[slug]/register/success?id=<registrationId>
//
// Server component — loads registration from Firestore, generates signed PDF URLs,
// then hands off to SuccessClient for animated presentation.

import { notFound }        from 'next/navigation'
import QRCode              from 'qrcode'
import { adminDb }         from '@/lib/firebase/admin'
import { getRegistration } from '@/lib/firebase/firestore/registrations'
import { buildQrValue, signTicketToken } from '@/lib/tickets/generate'
import { signReceiptToken }              from '@/lib/receipts/token'
import type { EventDetailsDraft }        from '@/components/wizard/eventDetailsConfig'
import { SuccessClient, type CalendarData } from './SuccessClient'

export default async function RegistrationSuccessPage({
  params,
  searchParams,
}: {
  params:       Promise<{ slug: string }>
  searchParams: Promise<{ id?: string }>
}) {
  const { slug } = await params
  const { id }   = await searchParams

  if (!id) notFound()

  const registration = await getRegistration(id)
  if (!registration || registration.eventSlug !== slug) notFound()

  const { ticketCode, eventName, passName, attendee, status, amount, paymentStatus } = registration

  const isPending = status === 'pending' || status === 'waitlisted'

  // QR — use stored value or derive for legacy registrations
  const qrValue = registration.ticket?.qrValue ?? buildQrValue(slug, id, ticketCode)
  const qrSvg   = await QRCode.toString(qrValue, {
    type:   'svg',
    margin: 1,
    width:  180,
    color:  { dark: '#000000', light: '#ffffff' },
  })

  // Signed PDF download URLs (server-side only)
  const baseUrl      = process.env.NEXT_PUBLIC_APP_URL ?? ''
  const ticketToken  = signTicketToken(id)
  const ticketPdfUrl = `${baseUrl}/api/tickets/${id}/pdf?token=${encodeURIComponent(ticketToken)}`

  const isPaidRegistration = paymentStatus === 'paid' && (amount ?? 0) > 0
  const receiptUrl = isPaidRegistration
    ? `${baseUrl}/api/receipts/${id}?token=${encodeURIComponent(signReceiptToken(id))}`
    : null

  // Load event data for Add To Calendar — non-critical, falls back gracefully
  let calendarData: CalendarData | undefined = undefined
  try {
    const eventSnap = await adminDb.collection('events').doc(slug).get()
    if (eventSnap.exists) {
      const ed       = (eventSnap.data() as Record<string, unknown>).eventDetails as EventDetailsDraft | null
      const schedule = ed?.schedule
      const venue    = ed?.venue
      const startDate = schedule?.startDate ?? ''
      if (startDate) {
        const endDate   = schedule?.endDate   ?? startDate
        const startTime = schedule?.startTime ?? ''
        const endTime   = schedule?.endTime   ?? ''
        const venueType = venue?.type ?? 'physical'
        const physical  = venue?.physical
        const online    = venue?.online
        let location = ''
        if (venueType === 'online' || venueType === 'hybrid') {
          location = online?.platform ? `${online.platform} (Online)` : 'Online'
        } else {
          location = [physical?.name, physical?.city].filter(Boolean).join(', ')
        }
        calendarData = { startDate, endDate, startTime, endTime, location }
      }
    }
  } catch { /* Calendar data is non-critical */ }

  return (
    <SuccessClient
      registrationId={id}
      ticketCode={ticketCode}
      eventName={eventName}
      passName={passName}
      attendeeName={attendee.name}
      attendeeEmail={attendee.email}
      status={status}
      isPending={isPending}
      qrSvg={qrSvg}
      ticketPdfUrl={ticketPdfUrl}
      receiptUrl={receiptUrl}
      eventSlug={slug}
      calendarData={calendarData}
    />
  )
}
