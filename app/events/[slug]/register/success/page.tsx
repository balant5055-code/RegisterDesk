// /events/[slug]/register/success?id=<registrationId>
//
// Server component — loads registration from Firestore using Admin SDK.
// The registrationId is treated as a non-guessable UUID bearer token.
// An extra check (eventSlug === slug) prevents cross-event leakage.

import { notFound }         from 'next/navigation'
import Link                 from 'next/link'
import QRCode               from 'qrcode'
import { getRegistration }  from '@/lib/firebase/firestore/registrations'
import { buildQrValue }     from '@/lib/tickets/generate'

// ─── Ticket Block ─────────────────────────────────────────────────────────────

async function TicketBlock({
  code, qrValue, registrationId,
}: {
  code: string; qrValue: string; registrationId: string
}) {
  const qrSvg = await QRCode.toString(qrValue, {
    type:   'svg',
    margin: 1,
    width:  180,
    color:  { dark: '#000000', light: '#ffffff' },
  })

  return (
    <div className="flex flex-col items-center gap-4 rounded-2xl border border-border bg-card px-6 py-6 shadow-sm">
      {/* QR code */}
      <div>
        <p className="mb-3 text-center text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
          Your QR Code
        </p>
        <div
          className="overflow-hidden rounded-xl border border-border bg-white p-2"
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{ __html: qrSvg }}
          aria-label={`QR code for ticket ${code}`}
        />
      </div>

      {/* Ticket code */}
      <div className="text-center">
        <p className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
          Ticket Code
        </p>
        <p
          className="mt-2 font-mono text-[26px] font-bold tracking-[0.15em] text-foreground"
          aria-label={`Ticket code: ${code}`}
        >
          {code}
        </p>
        <p className="mt-1 text-[11.5px] text-muted-foreground">
          Show this QR code or ticket code at the entry gate
        </p>
      </div>

      {/* Full ticket link */}
      <Link
        href={`/tickets/${registrationId}`}
        className="w-full rounded-xl border border-border bg-muted/30 px-4 py-2.5 text-center text-[13px] font-semibold text-foreground transition-colors hover:bg-muted/60"
      >
        View Full Ticket →
      </Link>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

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

  // Verify this registration belongs to this event (cross-event guard)
  if (!registration || registration.eventSlug !== slug) notFound()

  const { ticketCode, eventName, passName, attendee, status } = registration

  const isPending = status === 'pending' || status === 'waitlisted'

  // QR value — use stored value or derive for legacy registrations
  const qrValue = registration.ticket?.qrValue ?? buildQrValue(slug, id, ticketCode)

  return (
    <div className="mx-auto max-w-md px-4 py-12 text-center">
      {/* Success icon */}
      <div className="mx-auto mb-6 flex size-16 items-center justify-center rounded-full bg-emerald-100">
        {isPending ? (
          <svg className="size-8 text-amber-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        ) : (
          <svg className="size-8 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        )}
      </div>

      {/* Status heading */}
      <h1 className="text-[24px] font-bold text-foreground">
        {isPending ? 'Registration Received' : "You're Registered!"}
      </h1>
      <p className="mt-2 text-[14px] text-muted-foreground">
        {isPending
          ? "Your registration is under review. We'll notify you once it's confirmed."
          : `Welcome, ${attendee.name}. Your registration is confirmed.`}
      </p>

      {/* Attendee + pass summary */}
      <div className="mt-6 rounded-xl border border-border bg-card p-4 text-left">
        <div className="grid grid-cols-2 gap-3 text-[13px]">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Event</p>
            <p className="mt-0.5 font-medium text-foreground">{eventName}</p>
          </div>
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Pass</p>
            <p className="mt-0.5 font-medium text-foreground">{passName}</p>
          </div>
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Name</p>
            <p className="mt-0.5 font-medium text-foreground">{attendee.name}</p>
          </div>
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Email</p>
            <p className="mt-0.5 truncate font-medium text-foreground">{attendee.email}</p>
          </div>
        </div>
      </div>

      {/* QR + ticket code — only for confirmed registrations */}
      {!isPending && (
        <div className="mt-5">
          <TicketBlock code={ticketCode} qrValue={qrValue} registrationId={id} />
        </div>
      )}

      {/* Registration status badge */}
      <div className="mt-5">
        <span className={`inline-flex rounded-full px-3 py-1 text-[12px] font-semibold ${
          status === 'confirmed'
            ? 'bg-emerald-100 text-emerald-700'
            : status === 'pending'
              ? 'bg-amber-100 text-amber-700'
              : 'bg-muted text-muted-foreground'
        }`}>
          {status === 'confirmed' ? 'Confirmed' : status === 'pending' ? 'Pending Approval' : status}
        </span>
      </div>

      {/* Actions */}
      <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:justify-center">
        <Link
          href={`/events/${slug}`}
          className="rounded-xl border border-border bg-card px-5 py-2.5 text-[13px] font-semibold text-foreground hover:bg-muted/50"
        >
          Back to Event
        </Link>
        <Link
          href="/"
          className="rounded-xl bg-primary px-5 py-2.5 text-[13px] font-semibold text-primary-foreground hover:opacity-90"
        >
          Explore Events
        </Link>
      </div>
    </div>
  )
}
