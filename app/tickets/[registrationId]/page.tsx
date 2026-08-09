// /tickets/[registrationId]
//
// Public attendee ticket page.  Secured by the non-guessable UUID — knowing the URL is
// equivalent to presenting the ticket.  Shows no financial figures inline; a paid receipt
// is offered only as a signed, gated download (same trust model as the ticket PDF).

import type { Metadata }     from 'next'
import { notFound }          from 'next/navigation'
import Link                  from 'next/link'
import { Calendar, MapPin, Clock, Check } from 'lucide-react'
import QRCode                from 'qrcode'
import { adminDb }           from '@/lib/firebase/admin'
import { getEventBySlug }    from '@/lib/firebase/firestore/events'
import { buildQrValue, signTicketToken } from '@/lib/tickets/generate'
import { signReceiptToken }  from '@/lib/receipts/token'
import { getTemplate }       from '@/lib/certificates/firestore'
import { MarketingPageLayout } from '@/components/marketing/layout/MarketingPageLayout'
import { TicketActions, type TicketCalendar } from './TicketActions'
import { TicketSuccessBanner } from './TicketSuccessBanner'
import type { RegistrationDocument } from '@/lib/registrations/types'
import type { EventDetailsDraft }    from '@/components/wizard/eventDetailsConfig'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(dateStr: string | undefined | null): string {
  if (!dateStr) return ''
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-IN', {
    weekday: 'short', day: 'numeric', month: 'long', year: 'numeric',
  })
}

function toIso(val: unknown): string | null {
  if (!val) return null
  if (typeof val === 'object' && 'toDate' in (val as object)) {
    return (val as { toDate: () => Date }).toDate().toISOString()
  }
  return null
}

// ─── Metadata ─────────────────────────────────────────────────────────────────

type PageProps = {
  params: Promise<{ registrationId: string }>
  /** `?success=1` is set by the post-registration CTA. Absent on a cold URL. */
  searchParams: Promise<{ success?: string }>
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { registrationId } = await params
  const snap = await adminDb.collection('registrations').doc(registrationId).get()
  if (!snap.exists) return { title: 'Ticket Not Found – RegisterDesk' }
  const reg = snap.data() as RegistrationDocument
  return {
    title:       `Ticket – ${reg.eventName} – RegisterDesk`,
    description: `${reg.attendee.name}'s ticket for ${reg.eventName}`,
    robots:      { index: false, follow: false },  // don't index individual tickets
  }
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default async function TicketPage({ params, searchParams }: PageProps) {
  const { registrationId } = await params
  // Presentation-only flag. It grants no access and is never trusted for anything:
  // the ticket renders identically with or without it.
  const justRegistered = (await searchParams).success === '1'

  // ── Load registration ─────────────────────────────────────────────────────
  const regSnap = await adminDb.collection('registrations').doc(registrationId).get()
  if (!regSnap.exists) notFound()

  const reg = regSnap.data() as RegistrationDocument

  // ── Signed download token (null when TICKET_SECRET is not configured) ─────
  const pdfToken = signTicketToken(registrationId)

  // ── QR value (fall back for legacy registrations without ticket.qrValue) ──
  const qrValue = reg.ticket?.qrValue ?? buildQrValue(reg.eventSlug, registrationId, reg.ticketCode)

  // ── Generate QR SVG server-side ───────────────────────────────────────────
  const qrSvg = await QRCode.toString(qrValue, {
    type:   'svg',
    margin: 1,
    width:  220,
    color:  { dark: '#000000', light: '#ffffff' },
  })

  // ── Load event details ────────────────────────────────────────────────────
  const event = await getEventBySlug(reg.eventSlug)
  const ed    = event?.eventDetails as EventDetailsDraft | undefined

  const bannerUrl  = ed?.media?.coverBanner?.value?.trim() ?? ''
  const startDate  = ed?.schedule?.startDate ?? ''
  const startTime  = ed?.schedule?.startTime ?? ''
  const endTime    = ed?.schedule?.endTime   ?? ''
  const venueType  = ed?.venue?.type
  const venueName  = venueType === 'online'
    ? (ed?.venue?.online?.platform ?? 'Online')
    : (ed?.venue?.physical?.name ?? '')
  const venueCity  = venueType !== 'online' ? (ed?.venue?.physical?.city ?? '') : ''

  // H-6: full address, organizer, directions + contact targets, calendar, receipt (paid).
  const physical      = ed?.venue?.physical
  const fullAddress   = venueType !== 'online'
    ? [physical?.addressLine1, physical?.addressLine2, physical?.city, physical?.state, physical?.pincode].filter(Boolean).join(', ')
    : ''
  const organizerName = ed?.organizer?.name?.trim() ?? ''
  const directionsUrl = venueType !== 'online'
    ? (physical?.mapsLink?.trim()
        || (fullAddress ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([physical?.name, fullAddress].filter(Boolean).join(', '))}` : null))
    : null
  const orgEmail       = ed?.organizer?.email?.trim() || ed?.support?.supportEmail?.trim() || ''
  const orgPhone       = ed?.organizer?.phone?.trim() || ed?.support?.supportPhone?.trim() || ''
  const contactHref    = orgEmail ? `mailto:${orgEmail}` : orgPhone ? `tel:${orgPhone}` : null
  const contactIsEmail = !!orgEmail

  const baseUrl   = process.env.NEXT_PUBLIC_APP_URL ?? ''
  const shareUrl  = `${baseUrl}/tickets/${registrationId}`
  const pdfUrl    = `/api/tickets/${registrationId}/pdf${pdfToken ? `?token=${pdfToken}` : ''}`
  const isPaid    = reg.paymentStatus === 'paid' && (reg.amount ?? 0) > 0
  const receiptUrl = isPaid
    ? `${baseUrl}/api/receipts/${registrationId}?token=${encodeURIComponent(signReceiptToken(registrationId))}`
    : null
  const calendar: TicketCalendar | null = startDate
    ? {
        startDate,
        endDate:   ed?.schedule?.endDate ?? startDate,
        startTime,
        endTime,
        location:  (venueType === 'online' || venueType === 'hybrid')
          ? (ed?.venue?.online?.platform ? `${ed.venue.online.platform} (Online)` : 'Online')
          : [venueName, venueCity].filter(Boolean).join(', '),
      }
    : null

  const registeredAt = toIso(reg.registeredAt)
  const checkedInAt  = toIso(reg.checkedInAt)

  const isCancelled  = reg.status === 'cancelled'
  const statusLabel  = reg.status === 'confirmed' ? 'Confirmed'
    : reg.status === 'cancelled' ? 'Cancelled'
      : reg.status === 'pending' ? 'Pending'
        : reg.status === 'waitlisted' ? 'Waitlisted'
          : reg.status === 'rejected' ? 'Not approved'
            : reg.status
  const timeLabel = startTime ? `${startTime}${endTime ? `–${endTime}` : ''}` : ''

  // ── Certificate eligibility ───────────────────────────────────────────────
  // Find eventId by scanning organizer drafts for matching slug
  let certEventId: string | null = null
  if (reg.organizerUid) {
    const draftsSnap = await adminDb.collection(`users/${reg.organizerUid}/eventDrafts`).get()
    for (const d of draftsSnap.docs) {
      const data    = d.data() as Record<string, unknown>
      const details = (data.eventDetails as Record<string, unknown>) ?? {}
      const seo     = (details.seo as Record<string, unknown>) ?? {}
      if (seo.urlSlug === reg.eventSlug) { certEventId = d.id; break }
    }
  }

  const certTemplate = certEventId ? await getTemplate(certEventId) : null
  const certEnabled  = !!(certTemplate?.enabled && reg.status === 'confirmed')
  const certEligible = certEnabled && (
    certTemplate!.type === 'participation' || reg.checkedIn
  )
  const certIneligibleReason: string | null = !certEnabled
    ? 'Certificate not available for this event'
    : certTemplate!.type === 'completion' && !reg.checkedIn
      ? 'Check-in required to download certificate'
      : null

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <MarketingPageLayout>
      {/*
        LAYOUT — the ticket is the primary artifact, so it owns the wide main column and
        the QR keeps its full size at every breakpoint. Supporting material (actions,
        certificate) sits in a sticky rail on desktop and simply stacks underneath on
        mobile. The page previously used max-w-lg, which rendered a phone-width card
        centred in a desktop viewport; the grid is what fixes that, not extra decoration.
      */}
      <div className="h-full bg-[#f7f8fa] font-sans print:bg-white">
        <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6 sm:py-10 lg:py-12">

          {justRegistered && <TicketSuccessBanner eventName={reg.eventName} />}

          {/* ── Cancelled banner ──────────────────────────────────────────── */}
          {isCancelled && (
            <div className="mb-6 rounded-xl border border-red-200 bg-red-50 px-4 py-3">
              <p className="text-[13px] font-semibold text-red-700">This registration has been cancelled</p>
              <p className="mt-0.5 text-[12px] text-red-600">This ticket is no longer valid for entry.</p>
            </div>
          )}

          <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-12 lg:gap-8">

            {/* ══ Main column — the ticket itself ══════════════════════════ */}
            <div className="lg:col-span-7 xl:col-span-8">
              <div className={`overflow-hidden rounded-2xl border border-border bg-white shadow-md print:break-inside-avoid print:shadow-none ${isCancelled ? 'opacity-70' : ''}`}>

                {/* Banner */}
                {bannerUrl ? (
                  <div className="relative h-40 overflow-hidden sm:h-52">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={bannerUrl} alt="" className="h-full w-full object-cover" />
                    <div className="absolute inset-0 bg-gradient-to-t from-black/65 to-transparent" />
                    <div className="absolute bottom-4 left-5 right-5">
                      <h1 className="text-[20px] font-extrabold leading-snug text-white drop-shadow sm:text-[24px]">
                        {reg.eventName}
                      </h1>
                    </div>
                  </div>
                ) : (
                  <div className="flex h-28 items-end bg-gradient-to-br from-[var(--primary-from)]/30 via-[var(--primary)]/20 to-transparent px-5 pb-4 sm:h-36">
                    <h1 className="text-[20px] font-extrabold text-foreground sm:text-[24px]">{reg.eventName}</h1>
                  </div>
                )}

                {/* Date + time + venue (quick glance) */}
                {(startDate || venueName) && (
                  <div className="flex flex-wrap gap-x-6 gap-y-2 border-b border-border px-5 py-3.5 sm:px-6">
                    {startDate && (
                      <span className="inline-flex items-center gap-1.5 text-[13px] text-muted-foreground">
                        <Calendar className="size-4 shrink-0" aria-hidden /> {fmt(startDate)}
                      </span>
                    )}
                    {timeLabel && (
                      <span className="inline-flex items-center gap-1.5 text-[13px] text-muted-foreground">
                        <Clock className="size-4 shrink-0" aria-hidden /> {timeLabel}
                      </span>
                    )}
                    {venueName && (
                      <span className="inline-flex items-center gap-1.5 text-[13px] text-muted-foreground">
                        <MapPin className="size-4 shrink-0" aria-hidden /> {[venueName, venueCity].filter(Boolean).join(', ')}
                      </span>
                    )}
                  </div>
                )}

                {/* QR code + ticket code — the scannable core, unchanged in size */}
                <div className="flex flex-col items-center gap-4 px-5 py-8 sm:px-6">
                  {reg.checkedIn && (
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-100 px-3 py-1 text-[12px] font-semibold text-emerald-700">
                      <Check className="size-3.5" aria-hidden /> Checked In {checkedInAt ? `at ${new Date(checkedInAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}` : ''}
                    </span>
                  )}

                  {/* QR — inline SVG, server-generated. QR payload semantics untouched. */}
                  <div
                    className="overflow-hidden rounded-xl border border-border bg-white p-3.5 shadow-sm"
                    dangerouslySetInnerHTML={{ __html: qrSvg }}
                    role="img"
                    aria-label={`QR code for ticket ${reg.ticketCode}`}
                  />

                  <div className="text-center">
                    <p className="font-mono text-[26px] font-bold tracking-[0.15em] text-foreground sm:text-[30px]">
                      {reg.ticketCode}
                    </p>
                    <p className="mt-1 text-[11.5px] uppercase tracking-wider text-muted-foreground">Ticket code</p>
                  </div>
                </div>

                {/* Perforated divider — the notch colour matches the page canvas */}
                <div className="relative mx-5 border-t border-dashed border-border sm:mx-6" aria-hidden>
                  <span className="absolute -left-8 top-1/2 size-4 -translate-y-1/2 rounded-full bg-[#f7f8fa]" />
                  <span className="absolute -right-8 top-1/2 size-4 -translate-y-1/2 rounded-full bg-[#f7f8fa]" />
                </div>

                {/* Ticket details (semantic definition list) */}
                <dl className="grid grid-cols-1 gap-x-8 gap-y-5 px-5 py-6 sm:grid-cols-2 sm:px-6">
                  <Detail label="Attendee"        value={reg.attendee.name} />
                  <Detail label="Pass"            value={reg.passName} />
                  <Detail label="Status"          value={statusLabel} />
                  {organizerName && <Detail label="Organizer" value={organizerName} />}
                  {fullAddress   && <Detail label="Address" value={fullAddress} full />}
                  <Detail label="Registration ID" value={registrationId} mono full />
                  <Detail label="Ticket ID"       value={reg.ticketCode} mono />
                  {registeredAt && (
                    <Detail label="Registered" value={new Date(registeredAt).toLocaleDateString('en-IN', {
                      day: 'numeric', month: 'short', year: 'numeric',
                    })} />
                  )}
                </dl>

                <div className="border-t border-border bg-muted/20 px-5 py-3.5 text-center sm:px-6">
                  <p className="text-[11px] text-muted-foreground">
                    Powered by <span className="font-semibold text-foreground">RegisterDesk</span>
                    {' · '}Present this QR code or ticket code at the entry gate
                  </p>
                </div>
              </div>
            </div>

            {/* ══ Sidebar — actions and certificate ════════════════════════ */}
            {/* Sticky only from lg up, where there is vertical room for it to help. */}
            <aside className="lg:col-span-5 lg:sticky lg:top-24 xl:col-span-4">
              <div className="space-y-5">

                <TicketActions
                  eventName={reg.eventName}
                  eventSlug={reg.eventSlug}
                  pdfUrl={pdfUrl}
                  receiptUrl={receiptUrl}
                  directionsUrl={directionsUrl}
                  contactHref={contactHref}
                  contactIsEmail={contactIsEmail}
                  shareUrl={shareUrl}
                  calendar={calendar}
                  cancelled={isCancelled}
                />

                {/* Certificate section */}
                {certEnabled && (
                  <section aria-labelledby="ticket-cert-h" className="overflow-hidden rounded-2xl border border-border bg-white shadow-sm">
                    <div className="flex items-center gap-3 border-b border-border px-5 py-4">
                      {/* Award icon inline SVG to avoid pulling in a client component */}
                      <svg className="size-5 shrink-0 text-primary" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" aria-hidden>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 18.75h-9m9 0a3 3 0 013 3h-15a3 3 0 013-3m9 0v-3.375c0-.621-.503-1.125-1.125-1.125h-.871M7.5 18.75v-3.375c0-.621.504-1.125 1.125-1.125h.872m5.007 0H9.497m5.007 0a7.454 7.454 0 01-.982-3.172M9.497 14.25a7.454 7.454 0 00.981-3.172M5.25 4.236c-.982.143-1.954.317-2.916.52A6.003 6.003 0 007.73 9.728M5.25 4.236V4.5c0 2.108.966 3.99 2.48 5.228M5.25 4.236V2.721C7.456 2.41 9.71 2.25 12 2.25c2.291 0 4.545.16 6.75.47v1.516M7.73 9.728a6.726 6.726 0 002.748 1.35m8.272-6.842V4.5c0 2.108-.966 3.99-2.48 5.228m2.48-5.492a46.32 46.32 0 012.916.52 6.003 6.003 0 01-5.395 4.972m0 0a6.726 6.726 0 01-2.749 1.35m0 0a6.772 6.772 0 01-3.044 0" />
                      </svg>
                      <div className="min-w-0">
                        <h2 id="ticket-cert-h" className="text-[14px] font-bold text-foreground">Your Certificate</h2>
                        <p className="text-[12px] text-muted-foreground">
                          {certTemplate!.type === 'participation'
                            ? 'Certificate of Participation'
                            : 'Certificate of Completion'}
                        </p>
                      </div>
                    </div>

                    <div className="px-5 py-4">
                      {certEligible ? (
                        <div className="space-y-3">
                          <p className="text-[13px] text-muted-foreground">
                            Your certificate is ready to download.
                          </p>
                          <a
                            href={`/api/certificates/download/${registrationId}`}
                            className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-5 py-2.5 text-[13px] font-semibold text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                          >
                            <svg className="size-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" aria-hidden>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
                            </svg>
                            Download Certificate
                          </a>
                        </div>
                      ) : (
                        <div className="flex items-start gap-2 text-[13px] text-muted-foreground">
                          <svg className="mt-0.5 size-4 shrink-0 text-amber-500" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" aria-hidden>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M11.25 11.25l.041-.02a.75.75 0 011.063.852l-.708 2.836a.75.75 0 001.063.853l.041-.021M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-3.75h.008v.008H12V8.25z" />
                          </svg>
                          {certIneligibleReason}
                        </div>
                      )}
                    </div>
                  </section>
                )}

                {/* Back to event link (chrome — hidden when printing) */}
                <div className="text-center print:hidden">
                  <Link
                    href={`/events/${reg.eventSlug}`}
                    className="inline-block rounded-md text-[13px] text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  >
                    &larr; Back to event page
                  </Link>
                </div>
              </div>
            </aside>
          </div>
        </div>
      </div>
    </MarketingPageLayout>
  )
}

// ─── Small helper ─────────────────────────────────────────────────────────────

function Detail({ label, value, full, mono }: { label: string; value: string; full?: boolean; mono?: boolean }) {
  return (
    <div className={full ? 'sm:col-span-2' : ''}>
      <dt className="text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </dt>
      <dd className={`mt-0.5 text-[13.5px] font-medium text-foreground${mono ? ' break-all font-mono text-[11.5px]' : ''}`}>
        {value}
      </dd>
    </div>
  )
}
