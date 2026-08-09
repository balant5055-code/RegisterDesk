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
import { getStoredAttendeeFinancials }   from '@/lib/fees/storedFinancials'
import { buildAttendeeFeeBreakdown }     from '@/lib/fees/attendeeBreakdown'
import type { EventDetailsDraft }        from '@/components/wizard/eventDetailsConfig'
import { SuccessClient, type CalendarData } from './SuccessClient'
import type { Metadata } from 'next'
import { buildMetadata } from '@/lib/marketing/seo'

// RD-LAUNCH-07 — noIndex: the URL carries a registration id and the page shows one
// attendee's ticket code and QR. It must never be indexed.
export const metadata: Metadata = buildMetadata({
  title:       'Registration confirmed | RegisterDesk',
  description: 'Your registration confirmation and ticket.',
  path:        '/events',
  noIndex:     true,
})

// Server-side display formatters (deterministic → passed as strings, no hydration risk).
function fmtDateLabel(d: string): string {
  const [y, m, day] = d.split('-').map(Number)
  if (!y || !m || !day) return d
  return new Date(y, m - 1, day).toLocaleDateString('en-IN', {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
  })
}
// Firestore Timestamp | Date | epoch → milliseconds, defensively (the field is typed
// `unknown` on RegistrationDocument).
function toMillis(v: unknown): number | null {
  if (!v) return null
  if (typeof v === 'number') return v
  if (v instanceof Date) return v.getTime()
  const t = v as { toMillis?: () => number; seconds?: number }
  if (typeof t.toMillis === 'function') return t.toMillis()
  if (typeof t.seconds === 'number')    return t.seconds * 1000
  return null
}

function fmtTimeLabel(t: string): string {
  const [h, m] = t.split(':').map(Number)
  if (Number.isNaN(h)) return t
  const dt = new Date(2000, 0, 1, h, m ?? 0)
  return dt.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true })
}

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

  // RD-RT3.4: registration date, off the record already loaded. Firestore Timestamp →
  // label here (deterministic string) rather than shipping a Date to the client.
  const registeredAtMs = toMillis(registration.registeredAt)
  const registeredAtLabel = registeredAtMs
    ? new Date(registeredAtMs).toLocaleDateString('en-IN', {
        day: 'numeric', month: 'short', year: 'numeric',
      })
    : null

  const isPending = status === 'pending' || status === 'waitlisted'

  // QR — use stored value or derive for legacy registrations
  const qrValue = registration.ticket?.qrValue ?? buildQrValue(slug, id, ticketCode)
  const qrSvg   = await QRCode.toString(qrValue, {
    type:   'svg',
    margin: 1,
    width:  220,   // M-2: consistent QR sizing across ticket surfaces (matches /tickets)
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

  // RD-PAYMENT-05 B1: itemize the charge from the canonical stored financials (attendee_pays
  // only; null for organizer_absorbs / free). Never recomputed — read from the ledger entry.
  const feeBreakdown = isPaidRegistration
    ? buildAttendeeFeeBreakdown(await getStoredAttendeeFinancials(id))
    : null

  // H-1: amount actually paid (registration.amount is in paise). Free ⇒ no charge line.
  const amountLabel = isPaidRegistration
    ? `₹${Math.round((amount ?? 0) / 100).toLocaleString('en-IN')}`
    : null

  // H-1/H-5: load the event once and derive the display summary + action targets.
  // Non-critical — every field falls back to null and the page still renders.
  let calendarData:   CalendarData | undefined = undefined
  let dateLabel:      string | null = null
  let timeLabel:      string | null = null
  let venueLabel:     string | null = null
  let eventTypeLabel: string | null = null
  let directionsUrl:  string | null = null
  let organizerEmail: string | null = null
  let organizerPhone: string | null = null
  let faqUrl:         string | null = null
  try {
    const eventSnap = await adminDb.collection('events').doc(slug).get()
    if (eventSnap.exists) {
      const raw      = eventSnap.data() as Record<string, unknown>
      const ed       = raw.eventDetails as EventDetailsDraft | null
      const et       = typeof raw.eventType === 'string' ? raw.eventType : null
      eventTypeLabel = et && et !== 'custom' ? et.charAt(0).toUpperCase() + et.slice(1) : null

      const schedule = ed?.schedule
      const venue    = ed?.venue
      const support  = ed?.support
      const venueType = venue?.type ?? 'physical'
      const physical  = venue?.physical
      const online    = venue?.online

      const startDate = schedule?.startDate ?? ''
      if (startDate) {
        const endDate   = schedule?.endDate   ?? startDate
        const startTime = schedule?.startTime ?? ''
        const endTime   = schedule?.endTime   ?? ''
        dateLabel = fmtDateLabel(startDate) + (endDate && endDate !== startDate ? ` – ${fmtDateLabel(endDate)}` : '')
        timeLabel = startTime ? fmtTimeLabel(startTime) + (endTime ? ` – ${fmtTimeLabel(endTime)}` : '') : null

        const location = (venueType === 'online' || venueType === 'hybrid')
          ? (online?.platform ? `${online.platform} (Online)` : 'Online')
          : [physical?.name, physical?.city].filter(Boolean).join(', ')
        calendarData = { startDate, endDate, startTime, endTime, location }
      }

      if (venueType === 'online') {
        venueLabel = online?.platform ? `Online · ${online.platform}` : 'Online event'
      } else {
        venueLabel = [physical?.name, physical?.city].filter(Boolean).join(', ') || physical?.addressLine1 || null
        const mapsLink = physical?.mapsLink?.trim()
        if (mapsLink) {
          directionsUrl = mapsLink
        } else {
          const q = [physical?.name, physical?.addressLine1, physical?.addressLine2, physical?.city, physical?.state, physical?.pincode]
            .filter(Boolean).join(', ')
          if (q) directionsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`
        }
      }

      organizerEmail = support?.supportEmail?.trim() || null
      organizerPhone = support?.supportPhone?.trim() || null
      faqUrl         = support?.faqUrl?.trim()       || null
    }
  } catch { /* Event summary is non-critical */ }

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
      amountLabel={amountLabel}
      dateLabel={dateLabel}
      timeLabel={timeLabel}
      venueLabel={venueLabel}
      eventTypeLabel={eventTypeLabel}
      directionsUrl={directionsUrl}
      organizerEmail={organizerEmail}
      organizerPhone={organizerPhone}
      faqUrl={faqUrl}
      paymentStatus={paymentStatus}
      registeredAtLabel={registeredAtLabel}
      shareUrl={`${baseUrl}/events/${slug}`}
      feeBreakdown={feeBreakdown}
    />
  )
}
