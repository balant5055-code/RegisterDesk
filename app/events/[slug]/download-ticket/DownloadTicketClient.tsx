'use client'

// "Download Your Ticket" — the attendee-facing identity step.
//
// EITHER identifier is enough. They are not equally strong and the copy does not pretend
// otherwise: a ticket code is crypto-random and unguessable, so possession is proof; a
// mobile number is merely something the attendee knows. When one number covers several
// registrations the server refuses to guess and asks for the Ticket ID — handled below as
// a first-class state rather than an error, because it is the common family case.
//
// Everything rendered here comes from the lookup API's six-field projection. No email,
// phone, payment or organizer field is available to this component even if it wanted one.

import { useState } from 'react'
import { Search, Loader2, Ticket, Download, AlertCircle, CheckCircle2 } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { buttonVariants } from '@/components/ui/button'
import type { TicketLookupResponse, TicketLookupResult } from '@/app/api/events/[slug]/tickets/lookup/route'

const INPUT_CLS =
  'w-full rounded-xl border border-border bg-background px-3.5 py-2.5 text-fs-sm text-foreground ' +
  'placeholder:text-muted-foreground/50 focus:border-primary/50 focus:outline-none focus:ring-2 focus:ring-primary/20'

const LABEL_CLS =
  'mb-1.5 block text-fs-2xs font-semibold uppercase tracking-wider text-muted-foreground'

export function DownloadTicketClient({ slug, eventName }: { slug: string; eventName: string }) {
  const [ticketId, setTicketId] = useState('')
  const [mobile,   setMobile]   = useState('')
  const [loading,  setLoading]  = useState(false)
  const [error,    setError]    = useState<string | null>(null)
  const [ticket,   setTicket]   = useState<TicketLookupResult | null>(null)
  /** Set when one mobile number covers several registrations — ask for the Ticket ID. */
  const [needsId,  setNeedsId]  = useState(false)

  // EITHER field enables the button. Requiring both would block the attendee who has only
  // their ticket code — the exact person this page exists for.
  const ready = ticketId.trim().length > 0 || mobile.trim().length > 0

  async function lookup(e: React.FormEvent) {
    e.preventDefault()
    if (!ready || loading) return
    setLoading(true)
    setError(null)
    setTicket(null)
    setNeedsId(false)
    try {
      const res  = await fetch(`/api/events/${encodeURIComponent(slug)}/tickets/lookup`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ ticketId: ticketId.trim(), mobile: mobile.trim() }),
      })
      const data = await res.json() as TicketLookupResponse
      if (data.success) setTicket(data.ticket)
      // The server decides the wording. The client never invents a reason, so it cannot
      // accidentally distinguish "no such ticket" from "wrong mobile".
      else {
        setError(data.reason)
        if ('ambiguous' in data && data.ambiguous) setNeedsId(true)
      }
    } catch {
      setError('Something went wrong. Please check your connection and try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="mx-auto w-full max-w-xl px-4 py-10 sm:px-6 sm:py-14">
      <div className="text-center">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-[rgb(var(--primary-rgb)_/_0.08)] px-3 py-1 text-fs-2xs font-bold uppercase tracking-[0.14em] text-primary">
          <Ticket className="size-3.5" aria-hidden /> Ticket Download
        </span>
        <h1 className="mt-4 text-fs-2xl font-bold tracking-tight text-foreground">
          Download Your Ticket
        </h1>
        <p className="mt-2 text-fs-md font-semibold text-foreground">{eventName}</p>
        <p className="mx-auto mt-2 max-w-md text-fs-sm leading-relaxed text-muted-foreground">
          Enter your ticket ID <span className="font-medium text-foreground">or</span> the
          mobile number you registered with. Either one is enough.
        </p>
      </div>

      <form onSubmit={lookup} autoComplete="off" className="mt-8 rounded-2xl border border-border bg-card p-5 shadow-sm sm:p-6">
        <div>
          <label htmlFor="dt-id" className={LABEL_CLS}>Ticket ID or Registration ID</label>
          <input
            id="dt-id"
            value={ticketId}
            onChange={e => setTicketId(e.target.value)}
            placeholder="RD-XXXXXXXX"
            inputMode="text"
            autoComplete="off"
            className={INPUT_CLS}
          />
          <p className="mt-1.5 text-fs-2xs text-muted-foreground">
            The code on your ticket or in your confirmation message. Fastest and most exact.
          </p>
        </div>

        <div className="my-4 flex items-center gap-3" aria-hidden>
          <span className="h-px flex-1 bg-border" />
          <span className="text-fs-2xs font-semibold uppercase tracking-wider text-muted-foreground">or</span>
          <span className="h-px flex-1 bg-border" />
        </div>

        <div>
          <label htmlFor="dt-mobile" className={LABEL_CLS}>Registered Mobile Number</label>
          <input
            id="dt-mobile"
            value={mobile}
            onChange={e => setMobile(e.target.value)}
            placeholder="98765 43210"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            className={INPUT_CLS}
          />
          <p className="mt-1.5 text-fs-2xs text-muted-foreground">
            The number you used when registering. Any format works.
          </p>
        </div>

        <button
          type="submit"
          disabled={!ready || loading}
          className={cn(buttonVariants({ size: 'lg' }), 'mt-5 w-full gap-2 disabled:opacity-50')}
        >
          {loading
            ? <><Loader2 className="size-4 animate-spin" aria-hidden /> Searching…</>
            : <><Search className="size-4" aria-hidden /> Find My Ticket</>}
        </button>

        {!ready && !loading && (
          <p className="mt-3 text-center text-fs-2xs text-muted-foreground">
            Enter either field to continue.
          </p>
        )}

        {needsId && (
          <p className="mt-3 rounded-lg bg-[rgb(var(--primary-rgb)_/_0.06)] px-3 py-2 text-center text-fs-2xs leading-relaxed text-foreground">
            That number is used by more than one registration. Add your Ticket ID above and
            search again.
          </p>
        )}
      </form>

      {error && (
        <div
          role="alert"
          className="mt-5 flex items-start gap-2.5 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-fs-sm leading-relaxed text-amber-700 dark:text-amber-400"
        >
          <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>{error}</span>
        </div>
      )}

      {ticket && (
        <div className="mt-6 overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
          <div className="flex items-center gap-2 border-b border-border bg-emerald-500/10 px-5 py-3 text-fs-sm font-semibold text-emerald-700 dark:text-emerald-400">
            <CheckCircle2 className="size-4" aria-hidden /> Ticket found
          </div>

          <dl className="divide-y divide-border">
            {([
              ['Name',   ticket.attendeeName],
              ['Ticket', ticket.ticketCode],
              ['Pass',   ticket.passName],
              ['Event',  ticket.eventName],
            ] as const).filter(([, v]) => !!v).map(([label, value]) => (
              <div key={label} className="flex items-baseline justify-between gap-4 px-5 py-3">
                <dt className="text-fs-2xs font-semibold uppercase tracking-wider text-muted-foreground">{label}</dt>
                <dd className="text-right text-fs-sm font-medium text-foreground">{value}</dd>
              </div>
            ))}
          </dl>

          <div className="px-5 pb-5 pt-4">
            {/* Points at the EXISTING ticket PDF route, carrying the capability the server
                minted. No second ticket renderer, and no download path that skips the
                identity check that produced this token. */}
            <a
              href={ticket.downloadUrl}
              className={cn(buttonVariants({ size: 'lg' }), 'w-full gap-2')}
            >
              <Download className="size-4" aria-hidden /> Download Ticket (PDF)
            </a>
            <p className="mt-2.5 text-center text-fs-2xs text-muted-foreground">
              Having trouble? Contact the event organizer.
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
