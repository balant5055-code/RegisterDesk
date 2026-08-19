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
import { MarketingPageLayout } from '@/components/marketing/layout/MarketingPageLayout'
import { ToastProvider } from '@/components/ui/Toast'
import { FreshRegistrationToast } from './FreshRegistrationToast'
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
  // RELATIVE, deliberately. These two are browser <a href> downloads on THIS page, so they
  // must resolve against the deployment the attendee is actually on. Built from
  // NEXT_PUBLIC_APP_URL they resolved to the production host instead, which meant a Vercel
  // Preview's "Download PDF"/"Download Receipt" left the preview and was served by
  // production — returning production's older ticket generator, and a 500 for the receipt
  // whose crash fix had not shipped there yet. `shareUrl` below stays absolute: it is shared
  // outside the browser and genuinely needs the canonical host.
  const ticketPdfUrl = `/api/tickets/${id}/pdf?token=${encodeURIComponent(ticketToken)}`

  const isPaidRegistration = paymentStatus === 'paid' && (amount ?? 0) > 0
  const receiptUrl = isPaidRegistration
    ? `/api/receipts/${id}?token=${encodeURIComponent(signReceiptToken(id))}`
    : null

  // NOTE: the itemized fee breakdown and the "amount paid" label were rendered ONLY by the
  // Registration summary card. With that card removed nothing consumes them, so both they
  // and the stored-financials read they required are gone rather than left as dead work.
  // The receipt download below is untouched and remains the record of what was charged.

  // H-1/H-5: load the event once and derive the display summary + action targets.
  // Non-critical — every field falls back to null and the page still renders.
  let calendarData:   CalendarData | undefined = undefined
  let dateLabel:      string | null = null
  let timeLabel:      string | null = null
  let directionsUrl:  string | null = null
  let organizerEmail: string | null = null
  let organizerPhone: string | null = null
  let faqUrl:         string | null = null
  try {
    const eventSnap = await adminDb.collection('events').doc(slug).get()
    if (eventSnap.exists) {
      const raw      = eventSnap.data() as Record<string, unknown>
      const ed       = raw.eventDetails as EventDetailsDraft | null
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

      // Only the physical arm has anything left to do: the venue LABEL is no longer
      // rendered anywhere on this page, so the online arm's body disappeared entirely.
      if (venueType !== 'online') {
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

  // CHROME — the registration funnel itself is deliberately chrome-less (a focused
  // checkout). Success is the END of that funnel: the attendee is done, so they are
  // handed back to the public product with the same navbar and footer every other
  // public page uses. Composed here, exactly as the homepage and /causes do it — this
  // app has no (public) route group, so the shell is opt-in per page.
  return (
    <MarketingPageLayout>
      <ToastProvider>
        <FreshRegistrationToast ticketCode={ticketCode} isPending={isPending} />
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
          dateLabel={dateLabel}
          timeLabel={timeLabel}
          directionsUrl={directionsUrl}
          organizerEmail={organizerEmail}
          organizerPhone={organizerPhone}
          faqUrl={faqUrl}
          shareUrl={`${baseUrl}/events/${slug}`}
        />
      </ToastProvider>
    </MarketingPageLayout>
  )
}
