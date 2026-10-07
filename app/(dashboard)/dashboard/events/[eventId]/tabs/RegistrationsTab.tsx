'use client'

// RD-EVENT-12 · The Registrations tab — an entry surface, not a second list.
//
// ═══ WHAT THIS REPLACED ══════════════════════════════════════════════════════
// A five-row preview table showing each attendee's NAME and EMAIL ADDRESS, under the
// caption "Showing 5 of 2,329 registrations", above a button to the real workspace.
//
// Three things were wrong with it. It put attendee PII on a page nobody opens to read
// PII. It forced the shell to fetch a fifty-document page — fifty people's contact
// details — to render five decorative rows. And it was a second, worse registration
// list one click away from the real one, which is the duplication this platform keeps
// paying for.
//
// The tab now answers one question — "what is the state of registrations, and where do
// I go to act on it" — from counters alone. Zero registration documents are read.
//
// The Event Command Header directly above already owns the event's identity, its
// headline figures and its actions; none of that is repeated here.

import Link from 'next/link'
import { ArrowRight, ExternalLink, Users } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { accent } from '@/lib/dashboard/accents'
import type { RegistrationsApiResponse } from '@/app/api/organizer/events/[eventId]/registrations/route'

/** The em dash every RegisterDesk surface uses for "we could not read this". */
const UNAVAILABLE = '—'

const n = (v: number) => v.toLocaleString('en-IN')

export default function RegistrationsTab({ data, eventId }: {
  /** From the shell. `null` when the dataset could not be read — NOT zero. */
  data:    RegistrationsApiResponse | null
  eventId: string
}) {
  const managerUrl = `/dashboard/events/${encodeURIComponent(eventId)}/registrations`
  const stats = data?.stats ?? null

  // Every figure on this page is counter-backed and whole-dataset. None of it is
  // derived by counting rows: a page holds at most a hundred of them, and a metric
  // measured off a page is wrong the moment an event outgrows one.
  const rows = [
    { key: 'confirmed', label: 'Confirmed', tone: 'verify'   as const, value: stats?.confirmed,
      hint: 'Registered and ticketed' },
    { key: 'pending',   label: 'Pending',   tone: 'pending'  as const, value: stats?.pending,
      hint: 'Awaiting your approval' },
    { key: 'cancelled', label: 'Cancelled', tone: 'critical' as const, value: stats?.cancelled,
      hint: 'Withdrawn or cancelled' },
  ]

  return (
    <div className="space-y-6">
      {/* ── The one figure worth leading with, and the way in ─────────────── */}
      <section aria-labelledby="reg-summary" className="min-w-0">
        <h2 id="reg-summary" className="sr-only">Registration summary</h2>

        <div className="rounded-surface border border-border bg-card p-4">
          <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
            <div className="min-w-0">
              <p className={cn(
                'text-fs-2xl font-semibold leading-none tabular-nums',
                stats ? 'text-foreground' : 'text-muted-foreground',
              )}>
                {stats
                  ? n(stats.total)
                  : <><span aria-hidden>{UNAVAILABLE}</span><span className="sr-only">Unavailable</span></>}
              </p>
              <p className="mt-1.5 text-fs-xs text-muted-foreground">
                {stats
                  ? 'Registrations in total'
                  : "Registration figures couldn't be loaded — they are unavailable, not zero."}
              </p>
            </div>

            <Link
              href={managerUrl}
              className={cn(
                'inline-flex h-11 shrink-0 items-center gap-1.5 rounded-control px-3.5 text-fs-sm font-semibold',
                'bg-primary/[0.08] text-[color:var(--primary-text)] transition-colors hover:bg-primary/[0.14]',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
              )}
            >
              Open Registration Manager
              <ArrowRight className="size-4" aria-hidden />
            </Link>
          </div>

          <dl className="mt-4 grid gap-x-6 gap-y-3 border-t border-border pt-4 sm:grid-cols-3">
            {rows.map(r => (
              <div key={r.key} className="flex min-w-0 items-baseline gap-2.5">
                <span className={cn('size-2 shrink-0 rounded-pill', accent(r.tone).bar)} aria-hidden />
                <dt className="min-w-0 flex-1">
                  <span className="block truncate text-fs-sm text-foreground">{r.label}</span>
                  <span className="block truncate text-fs-2xs text-muted-foreground">{r.hint}</span>
                </dt>
                <dd className={cn(
                  'shrink-0 text-fs-sm font-semibold tabular-nums',
                  r.value === undefined ? 'text-muted-foreground' : 'text-foreground',
                )}>
                  {r.value === undefined
                    ? <><span aria-hidden>{UNAVAILABLE}</span><span className="sr-only">Unavailable</span></>
                    : n(r.value)}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      {/* ── The one thing that is genuinely ACTIONABLE from here ──────────── */}
      {/* Pending approvals are the only registration state that needs a decision from
          the organizer rather than an observation, so it is the only one promoted to a
          call to action — and it links straight into the Manager already filtered. */}
      {stats && stats.pending > 0 && (
        <section aria-labelledby="reg-pending" className="min-w-0">
          <div className="flex flex-col gap-3 rounded-surface border border-warning/30 bg-warning/[0.06] p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <h2 id="reg-pending" className="text-fs-sm font-semibold text-foreground">
                {n(stats.pending)} {stats.pending === 1 ? 'registration is' : 'registrations are'} waiting for approval
              </h2>
              <p className="mt-0.5 text-fs-xs text-muted-foreground">
                {stats.pending === 1 ? 'This person has' : 'These people have'} not been confirmed
                and {stats.pending === 1 ? 'has' : 'have'} not received a ticket yet.
              </p>
            </div>
            <Link
              href={`${managerUrl}?status=pending`}
              className="inline-flex h-11 shrink-0 items-center gap-1.5 rounded-control border border-border bg-card px-3.5 text-fs-sm font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            >
              Review pending
              <ArrowRight className="size-3.5" aria-hidden />
            </Link>
          </div>
        </section>
      )}

      {/* ── Nothing yet ──────────────────────────────────────────────────── */}
      {stats && stats.total === 0 && (
        <section aria-labelledby="reg-empty" className="min-w-0">
          <div className="rounded-surface border border-border bg-card px-4 py-12 text-center">
            <span className="mx-auto flex size-10 items-center justify-center rounded-pill bg-muted" aria-hidden>
              <Users className="size-5 text-muted-foreground" />
            </span>
            <h2 id="reg-empty" className="mt-3 text-fs-md font-semibold text-foreground">
              No registrations yet
            </h2>
            <p className="mx-auto mt-1 max-w-sm text-fs-sm text-muted-foreground">
              Share your event page to start collecting them. They will appear here and in
              the Registration Manager as they arrive.
            </p>
            <Link
              href={`/dashboard/events/${encodeURIComponent(eventId)}?tab=setup`}
              className="mt-4 inline-flex h-11 items-center gap-1.5 rounded-control border border-border px-3.5 text-fs-sm font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            >
              Open setup <ExternalLink className="size-3.5" aria-hidden />
            </Link>
          </div>
        </section>
      )}
    </div>
  )
}
