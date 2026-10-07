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
//
// Presentation (2026-09-23): the editorial language of the public event page — Fraunces
// display, bronze hairlines (--hero-accent-rule), the --action accent, 6px controls. The
// lookup behaviour, the either-field rule and the per-ticket download are unchanged.

import { useState } from 'react'
import Link from 'next/link'
import { Search, Loader2, Download, AlertCircle, ArrowLeft, KeyRound, Smartphone, ShieldCheck } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { marketingButton } from '@/lib/marketing/theme'
import type { TicketLookupResponse, TicketLookupResult } from '@/app/api/events/[slug]/tickets/lookup/route'
import { PAGE_TITLE } from '@/lib/marketing/pageTitle'

const INPUT_CLS =
  'h-11 w-full rounded-[var(--radius-control)] border border-border bg-background px-3.5 text-fs-base text-foreground ' +
  'placeholder:text-muted-foreground/50 transition-[border-color,box-shadow] ' +
  'focus:border-action/60 focus:outline-none focus:shadow-[0_0_0_4px_rgb(var(--action-rgb)_/_0.12)]'

const LABEL_CLS =
  'mb-1.5 block text-fs-2xs font-semibold uppercase tracking-[0.18em] text-hero-eyebrow'

const HINT_CLS = 'mt-1.5 text-fs-xs leading-relaxed text-hero-ink-soft'

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

  const guidance = [
    { Icon: KeyRound,    title: 'Ticket ID is fastest', text: 'The RD- code on your ticket or in your confirmation email finds it exactly.' },
    { Icon: Smartphone,  title: 'Or use your mobile',   text: 'Every confirmed ticket registered with that number is listed.' },
    { Icon: ShieldCheck, title: 'Private by design',    text: 'Only confirmed tickets for this event are shown. Nothing downloads automatically.' },
  ]

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6 sm:py-12 lg:px-8 lg:py-16">
      <Link
        href={`/events/${slug}`}
        className="inline-flex items-center gap-1.5 text-fs-sm text-hero-ink-soft transition-colors hover:text-hero-ink"
      >
        <ArrowLeft className="size-3.5" aria-hidden />
        Back to event
      </Link>

      <div className="mt-6 grid gap-10 lg:mt-8 lg:grid-cols-12 lg:gap-14">
        {/* ── The invitation to find it ─────────────────────────────────── */}
        <div className="lg:col-span-5">
          <p className="flex items-center gap-2.5 text-fs-2xs font-semibold uppercase tracking-[0.22em] text-hero-eyebrow">
            <span aria-hidden className="h-px w-6 shrink-0 bg-hero-accent-rule" />
            Your ticket
          </p>
          <h1 className={`mt-4 ${PAGE_TITLE}`}>
            Download your ticket
          </h1>
          <p className="mt-3 font-display text-fs-lg italic font-light text-hero-ink-soft leading-snug">{eventName}</p>
          <p className="mt-4 max-w-md text-fs-base leading-relaxed text-hero-ink-soft">
            Enter your ticket ID <span className="font-medium text-hero-ink">or</span> the mobile
            number you registered with. Either one is enough.
          </p>

          <ul className="mt-8 hidden space-y-4 border-t border-border/60 pt-6 sm:block">
            {guidance.map(({ Icon, title, text }) => (
              <li key={title} className="flex items-start gap-3">
                <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-full border border-hero-accent-rule/50 text-hero-accent-rule">
                  <Icon className="size-4" aria-hidden />
                </span>
                <div>
                  <p className="text-fs-sm font-medium text-hero-ink">{title}</p>
                  <p className="mt-0.5 text-fs-xs leading-relaxed text-hero-ink-soft">{text}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>

        {/* ── Lookup + results ─────────────────────────────────────────── */}
        <div className="min-w-0 lg:col-span-7">
          <form
            onSubmit={lookup}
            autoComplete="off"
            className="rounded-xl border border-border/70 bg-card p-5 shadow-[0_1px_2px_rgb(15_23_42_/_0.04),0_24px_48px_-36px_rgb(15_23_42_/_0.35)] sm:p-7"
          >
            <div>
              <label htmlFor="dt-id" className={LABEL_CLS}>Ticket ID or Registration ID</label>
              <input
                id="dt-id"
                value={ticketId}
                onChange={e => setTicketId(e.target.value)}
                placeholder="RD-XXXXXXXX"
                inputMode="text"
                autoComplete="off"
                spellCheck={false}
                className={cn(INPUT_CLS, 'font-mono tracking-[0.12em] placeholder:font-sans placeholder:tracking-normal')}
              />
              <p className={HINT_CLS}>The code on your ticket or in your confirmation message.</p>
            </div>

            <div className="my-5 flex items-center gap-3" aria-hidden>
              <span className="h-px flex-1 bg-border/70" />
              <span className="font-display text-fs-sm italic text-hero-accent-rule">or</span>
              <span className="h-px flex-1 bg-border/70" />
            </div>

            <div>
              <label htmlFor="dt-mobile" className={LABEL_CLS}>Registered mobile number</label>
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
              <p className={HINT_CLS}>The number you used when registering. Any format works.</p>
            </div>

            <button
              type="submit"
              disabled={!ready || loading}
              className={cn(marketingButton({ emphasis: 'gradient', variant: 'primary', size: 'lg' }), 'mt-6 h-11 w-full gap-2 rounded-[var(--radius-control)] disabled:opacity-50')}
            >
              {loading
                ? <><Loader2 className="size-4 animate-spin" aria-hidden /> Searching…</>
                : <><Search className="size-4" aria-hidden /> Find my ticket</>}
            </button>

            {!ready && !loading && (
              <p className="mt-3 text-center text-fs-xs text-hero-ink-soft">
                Enter either field to continue.
              </p>
            )}
          </form>

          {error && (
            <div
              role="alert"
              className="mt-5 flex items-start gap-2.5 rounded-[var(--radius-control)] border border-amber-500/30 bg-amber-500/[0.08] px-4 py-3 text-fs-sm leading-relaxed text-amber-800 dark:text-amber-400"
            >
              <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span>{error}</span>
            </div>
          )}

          {tickets.length > 0 && (
            <section className="mt-8" aria-live="polite">
              <h2 className="flex items-center gap-2.5 text-fs-2xs font-semibold uppercase tracking-[0.22em] text-hero-eyebrow">
                <span aria-hidden className="h-px w-6 shrink-0 bg-hero-accent-rule" />
                {tickets.length === 1 ? 'Ticket found' : `Tickets found (${tickets.length})`}
              </h2>

              {tickets.length > 1 && (
                <p className="mt-2 text-fs-xs leading-relaxed text-hero-ink-soft">
                  This mobile number is registered for more than one person. Download each
                  ticket separately.
                </p>
              )}

              <ul className="mt-4 space-y-3">
                {tickets.map(t => (
                  <li key={t.ticketCode || t.downloadUrl} className="overflow-hidden rounded-xl border border-border/70 bg-card">
                    <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
                      <div className="min-w-0">
                        <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/[0.08] px-2 py-0.5 text-fs-2xs font-semibold uppercase tracking-[0.12em] text-emerald-700 dark:text-emerald-400">
                          <span aria-hidden className="size-1.5 rounded-full bg-emerald-500" />
                          Confirmed
                        </span>
                        {/* The NAME leads: with several tickets on screen it is the only thing
                            that tells a parent which child they are downloading for. */}
                        <p className="mt-2.5 font-display text-fs-xl text-hero-ink leading-snug">{t.attendeeName}</p>
                        <dl className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-fs-sm">
                          {([['Ticket', t.ticketCode, true], ['Pass', t.passName, false]] as const)
                            .filter(([, v]) => !!v)
                            .map(([label, value, mono]) => (
                              <div key={label} className="flex items-baseline gap-1.5">
                                <dt className="text-hero-ink-soft">{label}</dt>
                                <dd className={cn('text-hero-ink', mono ? 'font-mono font-semibold tracking-wider' : 'font-medium')}>{value}</dd>
                              </div>
                            ))}
                        </dl>
                      </div>

                      {/* Its OWN capability, scoped to its own registration — see toResult. */}
                      <a
                        href={t.downloadUrl}
                        className={cn(marketingButton({ emphasis: 'gradient', variant: 'primary', size: 'md' }), 'h-10 w-full shrink-0 gap-2 rounded-[var(--radius-control)] sm:w-auto sm:px-5')}
                      >
                        <Download className="size-4" aria-hidden /> Download PDF
                      </a>
                    </div>
                  </li>
                ))}
              </ul>

              <p className="mt-4 text-fs-xs text-hero-ink-soft">
                Having trouble? Contact the event organizer from the{' '}
                <Link href={`/events/${slug}`} className="font-medium text-action underline-offset-4 hover:underline">event page</Link>.
              </p>
            </section>
          )}
        </div>
      </div>
    </div>
  )
}
