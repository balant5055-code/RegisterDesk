'use client'

// "Download Your Ticket" — the attendee-facing identity step.
//
// EITHER identifier is enough. They are not equally strong and the copy does not pretend
// otherwise: a ticket code is crypto-random and unguessable, so possession is proof; a
// mobile number is merely something the attendee knows.
//
// Results are ALWAYS a list. One number legitimately covers a family or a team, and every
// matching confirmed ticket is shown with its own download button — the attendee chooses,
// nothing is picked for them, and nothing downloads automatically.
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
  const [tickets,  setTickets]  = useState<TicketLookupResult[]>([])

  // EITHER field enables the button. Requiring both would block the attendee who has only
  // their ticket code — the exact person this page exists for.
  const ready = ticketId.trim().length > 0 || mobile.trim().length > 0

  async function lookup(e: React.FormEvent) {
    e.preventDefault()
    if (!ready || loading) return
    setLoading(true)
    setError(null)
    setTickets([])
    try {
      const res  = await fetch(`/api/events/${encodeURIComponent(slug)}/tickets/lookup`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ ticketId: ticketId.trim(), mobile: mobile.trim() }),
      })
      const data = await res.json() as TicketLookupResponse
      if (data.success) setTickets(data.tickets)
      // The server decides the wording. The client never invents a reason, so it cannot
      // accidentally distinguish "no such ticket" from "wrong mobile".
      else setError(data.reason)
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

      {tickets.length > 0 && (
        <section className="mt-6" aria-live="polite">
          <h2 className="mb-3 text-fs-md font-semibold text-foreground">
            {tickets.length === 1 ? 'Ticket found' : `Tickets found (${tickets.length})`}
          </h2>

          {tickets.length > 1 && (
            <p className="mb-3 text-fs-2xs leading-relaxed text-muted-foreground">
              This mobile number is registered for more than one person. Download each
              ticket separately.
            </p>
          )}

          <ul className="space-y-3">
            {tickets.map(t => (
              <li key={t.ticketCode || t.downloadUrl} className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
                <div className="flex items-center gap-2 border-b border-border bg-emerald-500/10 px-5 py-2.5 text-fs-2xs font-semibold uppercase tracking-wider text-emerald-700 dark:text-emerald-400">
                  <CheckCircle2 className="size-3.5" aria-hidden /> Confirmed
                </div>

                <div className="px-5 pt-4">
                  {/* The NAME leads: with several tickets on screen it is the only thing
                      that tells a parent which child they are downloading for. */}
                  <p className="text-fs-md font-semibold text-foreground">{t.attendeeName}</p>
                  <dl className="mt-2 space-y-1">
                    {([['Ticket ID', t.ticketCode], ['Pass', t.passName], ['Event', t.eventName]] as const)
                      .filter(([, v]) => !!v)
                      .map(([label, value]) => (
                        <div key={label} className="flex items-baseline gap-2 text-fs-sm">
                          <dt className="text-muted-foreground">{label}:</dt>
                          <dd className="font-medium text-foreground">{value}</dd>
                        </div>
                      ))}
                  </dl>
                </div>

                <div className="px-5 pb-5 pt-4">
                  {/* Its OWN capability, scoped to its own registration — see toResult. */}
                  <a href={t.downloadUrl} className={cn(buttonVariants({ size: 'lg' }), 'w-full gap-2')}>
                    <Download className="size-4" aria-hidden /> Download Ticket
                  </a>
                </div>
              </li>
            ))}
          </ul>

          <p className="mt-3 text-center text-fs-2xs text-muted-foreground">
            Having trouble? Contact the event organizer.
          </p>
        </section>
      )}
    </div>
  )
}
