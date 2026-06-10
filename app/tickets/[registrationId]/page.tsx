// /tickets/[registrationId]
//
// Public attendee ticket page.  Secured by the non-guessable UUID — knowing
// the URL is equivalent to presenting the ticket.  Never shows financial data.

import type { Metadata }     from 'next'
import { notFound }          from 'next/navigation'
import Link                  from 'next/link'
import QRCode                from 'qrcode'
import { adminDb }           from '@/lib/firebase/admin'
import { getEventBySlug }    from '@/lib/firebase/firestore/events'
import { buildQrValue, signTicketToken } from '@/lib/tickets/generate'
import { getTemplate }       from '@/lib/certificates/firestore'
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

type PageProps = { params: Promise<{ registrationId: string }> }

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

export default async function TicketPage({ params }: PageProps) {
  const { registrationId } = await params

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

  const registeredAt = toIso(reg.registeredAt)
  const checkedInAt  = toIso(reg.checkedInAt)

  const isCancelled = reg.status === 'cancelled'

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
    <div className="min-h-screen bg-[#f7f8fa] font-sans">
      {/* Header strip */}
      <div className="border-b border-border bg-white px-4 py-3">
        <div className="mx-auto flex max-w-lg items-center justify-between">
          <span className="text-[13px] font-bold text-foreground">RegisterDesk</span>
          <Link
            href={`/api/tickets/${registrationId}/pdf${pdfToken ? `?token=${pdfToken}` : ''}`}
            className="rounded-lg bg-primary px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-[#bf1868]"
          >
            Download PDF
          </Link>
        </div>
      </div>

      <div className="mx-auto max-w-lg px-4 py-8">

        {/* ── Cancelled banner ──────────────────────────────────────────── */}
        {isCancelled && (
          <div className="mb-5 rounded-xl border border-red-200 bg-red-50 px-4 py-3">
            <p className="text-[13px] font-semibold text-red-700">This registration has been cancelled</p>
            <p className="mt-0.5 text-[12px] text-red-600">This ticket is no longer valid for entry.</p>
          </div>
        )}

        {/* ── Ticket card ───────────────────────────────────────────────── */}
        <div className={`overflow-hidden rounded-2xl border border-border bg-white shadow-md ${isCancelled ? 'opacity-70' : ''}`}>

          {/* Banner */}
          {bannerUrl ? (
            <div className="relative h-36 overflow-hidden">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={bannerUrl} alt="" className="h-full w-full object-cover" />
              <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent" />
              <div className="absolute bottom-3 left-4 right-4">
                <p className="text-[18px] font-extrabold leading-snug text-white drop-shadow">
                  {reg.eventName}
                </p>
              </div>
            </div>
          ) : (
            <div className="flex h-24 items-end bg-gradient-to-br from-[#fb5a6a]/30 via-[#e5277e]/20 to-transparent px-4 pb-3">
              <p className="text-[18px] font-extrabold text-foreground">{reg.eventName}</p>
            </div>
          )}

          {/* Date + venue */}
          {(startDate || venueName) && (
            <div className="flex flex-wrap gap-x-5 gap-y-1 border-b border-border px-5 py-3">
              {startDate && (
                <span className="text-[12.5px] text-muted-foreground">
                  📅 {fmt(startDate)}{startTime ? ` · ${startTime}` : ''}{endTime ? `–${endTime}` : ''}
                </span>
              )}
              {venueName && (
                <span className="text-[12.5px] text-muted-foreground">
                  📍 {[venueName, venueCity].filter(Boolean).join(', ')}
                </span>
              )}
            </div>
          )}

          {/* QR code + ticket code */}
          <div className="flex flex-col items-center gap-3 px-5 py-6">
            {/* Checked-in badge */}
            {reg.checkedIn && (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-100 px-3 py-1 text-[12px] font-semibold text-emerald-700">
                ✓ Checked In {checkedInAt ? `at ${new Date(checkedInAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}` : ''}
              </span>
            )}

            {/* QR code — inline SVG, server-generated */}
            <div
              className="overflow-hidden rounded-xl border border-border bg-white p-3 shadow-sm"
              // eslint-disable-next-line react/no-danger
              dangerouslySetInnerHTML={{ __html: qrSvg }}
              aria-label={`QR code for ticket ${reg.ticketCode}`}
            />

            {/* Ticket code */}
            <div className="text-center">
              <p className="font-mono text-[26px] font-bold tracking-[0.15em] text-foreground">
                {reg.ticketCode}
              </p>
              <p className="mt-0.5 text-[11.5px] text-muted-foreground">Ticket code</p>
            </div>
          </div>

          {/* Perforated divider */}
          <div className="relative mx-5 border-t border-dashed border-border" aria-hidden>
            <span className="absolute -left-8 top-1/2 size-4 -translate-y-1/2 rounded-full bg-[#f7f8fa]" />
            <span className="absolute -right-8 top-1/2 size-4 -translate-y-1/2 rounded-full bg-[#f7f8fa]" />
          </div>

          {/* Attendee details */}
          <div className="grid grid-cols-2 gap-x-6 gap-y-4 px-5 py-5">
            <Detail label="Attendee"  value={reg.attendee.name} />
            <Detail label="Pass"      value={reg.passName} />
            <Detail label="Status"    value={
              reg.status === 'confirmed' ? 'Confirmed'
              : reg.status === 'cancelled' ? 'Cancelled'
              : reg.status === 'pending'  ? 'Pending'
              : reg.status
            } />
            {registeredAt && (
              <Detail label="Registered" value={new Date(registeredAt).toLocaleDateString('en-IN', {
                day: 'numeric', month: 'short', year: 'numeric',
              })} />
            )}
          </div>

          {/* Footer */}
          <div className="border-t border-border bg-muted/20 px-5 py-3 text-center">
            <p className="text-[10.5px] text-muted-foreground">
              Powered by <span className="font-semibold text-foreground">RegisterDesk</span>
              {' · '}Present this QR code or ticket code at the entry gate
            </p>
          </div>
        </div>

        {/* Certificate section */}
        {certEnabled && (
          <div className="mt-5 overflow-hidden rounded-2xl border border-border bg-white shadow-sm">
            <div className="flex items-center gap-3 border-b border-border px-5 py-4">
              {/* Award icon inline SVG to avoid client component */}
              <svg className="size-5 text-primary" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" aria-hidden>
                <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 18.75h-9m9 0a3 3 0 013 3h-15a3 3 0 013-3m9 0v-3.375c0-.621-.503-1.125-1.125-1.125h-.871M7.5 18.75v-3.375c0-.621.504-1.125 1.125-1.125h.872m5.007 0H9.497m5.007 0a7.454 7.454 0 01-.982-3.172M9.497 14.25a7.454 7.454 0 00.981-3.172M5.25 4.236c-.982.143-1.954.317-2.916.52A6.003 6.003 0 007.73 9.728M5.25 4.236V4.5c0 2.108.966 3.99 2.48 5.228M5.25 4.236V2.721C7.456 2.41 9.71 2.25 12 2.25c2.291 0 4.545.16 6.75.47v1.516M7.73 9.728a6.726 6.726 0 002.748 1.35m8.272-6.842V4.5c0 2.108-.966 3.99-2.48 5.228m2.48-5.492a46.32 46.32 0 012.916.52 6.003 6.003 0 01-5.395 4.972m0 0a6.726 6.726 0 01-2.749 1.35m0 0a6.772 6.772 0 01-3.044 0" />
              </svg>
              <div>
                <p className="text-[14px] font-bold text-foreground">Your Certificate</p>
                <p className="text-[12px] text-muted-foreground">
                  {certTemplate!.type === 'participation'
                    ? 'Certificate of Participation'
                    : 'Certificate of Completion'}
                </p>
              </div>
            </div>

            <div className="px-5 py-4">
              {certEligible ? (
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <p className="text-[13px] text-muted-foreground">
                    Your certificate is ready to download.
                  </p>
                  <a
                    href={`/api/certificates/download/${registrationId}`}
                    className="inline-flex items-center justify-center gap-2 rounded-xl bg-primary px-5 py-2.5 text-[13px] font-semibold text-white transition-opacity hover:opacity-90"
                  >
                    {/* Download icon inline */}
                    <svg className="size-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" aria-hidden>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
                    </svg>
                    Download Certificate
                  </a>
                </div>
              ) : (
                <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
                  {/* Info icon inline */}
                  <svg className="size-4 shrink-0 text-amber-500" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" aria-hidden>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M11.25 11.25l.041-.02a.75.75 0 011.063.852l-.708 2.836a.75.75 0 001.063.853l.041-.021M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-3.75h.008v.008H12V8.25z" />
                  </svg>
                  {certIneligibleReason}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Back to event link */}
        <div className="mt-5 text-center">
          <Link
            href={`/events/${reg.eventSlug}`}
            className="text-[13px] text-primary hover:underline"
          >
            ← Back to event page
          </Link>
        </div>
      </div>
    </div>
  )
}

// ─── Small helper ─────────────────────────────────────────────────────────────

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p className="mt-0.5 text-[13.5px] font-medium text-foreground">{value}</p>
    </div>
  )
}
