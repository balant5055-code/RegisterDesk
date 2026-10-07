'use client'

// RD-DASHBOARD-02 · Upcoming events.
//
// Deadlines are the organizer's actual job, so this panel is built around TIME LEFT
// rather than around the event record. Each row answers three things at a glance:
// when is it, how full is it, and is it ready.
//
// Clicking a row enters that event's canonical Event Overview — the same destination
// the Events page and the header selector use. No second event page, and no
// event-scoped dashboard.

import Link from 'next/link'
import { ArrowRight, CalendarDays } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { StateBlock } from '@/components/dashboard/StateBlock'
import { accent, capacityTone, type AccentTone } from '@/lib/dashboard/accents'
import type { UpcomingEvent } from '@/lib/dashboard/insights'

function formatDate(iso: string | null): string {
  if (!iso) return 'No date set'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return 'No date set'
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
}

/** Day + month for the date tile. Null when the event has no start date. */
function splitDate(iso: string | null): { day: string; month: string } | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return {
    day:   String(d.getDate()),
    month: d.toLocaleDateString('en-IN', { month: 'short' }),
  }
}

/** "Today" / "Tomorrow" / "in N days" — the phrasing an organizer actually uses. */
function countdown(daysLeft: number | null): string | null {
  if (daysLeft === null) return null
  if (daysLeft === 0) return 'Today'
  if (daysLeft === 1) return 'Tomorrow'
  return `in ${daysLeft} days`
}

function FillBar({ pct }: { pct: number }) {
  // Colour is derived from the SAME threshold function the attention rules use, so a
  // 96%-full event shows amber here and raises an amber warning above — the bar and
  // the alert can never disagree. Never the only signal: the count sits beside it.
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-pill bg-muted" role="presentation">
      <div
        className={cn('h-full rounded-pill transition-[width] duration-500 ease-out', accent(capacityTone(pct)).bar)}
        style={{ width: `${Math.min(100, pct)}%` }}
      />
    </div>
  )
}

/** Countdown urgency, so "Tomorrow" reads differently from "in 45 days". */
function countdownTone(daysLeft: number | null): AccentTone {
  if (daysLeft === null) return 'neutral'
  if (daysLeft <= 1) return 'critical'
  if (daysLeft <= 7) return 'pending'
  return 'event'
}

export function UpcomingEvents({ events }: { events: UpcomingEvent[] }) {
  return (
    <section aria-labelledby="upcoming-heading" className="flex h-full flex-col overflow-hidden rounded-surface border border-border bg-card">
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2.5">
        <h2 id="upcoming-heading" className="text-fs-sm font-semibold text-foreground">Upcoming events</h2>
        <Link
          href="/dashboard/events"
          className="rounded-control text-fs-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
        >
          All events
        </Link>
      </div>

      {events.length === 0 ? (
        <StateBlock
          kind="empty"
          title="Nothing scheduled"
          description="Events with a future start date will appear here."
          action={{ label: 'Create an event', href: '/dashboard/events/new/visibility' }}
          className="flex flex-1 flex-col justify-center border-0 py-6"
        />
      ) : (
        <ul className="flex-1 divide-y divide-border">
          {events.map(e => {
            const when = countdown(e.daysLeft)
            const startDay = splitDate(e.startDate)
            return (
              <li key={e.draftId}>
                <Link
                  href={`/dashboard/events/${encodeURIComponent(e.draftId)}`}
                  className="group flex items-start gap-3 px-4 py-3 transition-colors hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40"
                >
                  {/* Date tile — the deadline is what this panel is FOR, so it leads
                      rather than being buried in a metadata line. */}
                  <span
                    className={cn('flex size-9 shrink-0 flex-col items-center justify-center rounded-control leading-none',
                      accent(countdownTone(e.daysLeft)).tile)}
                    aria-hidden
                  >
                    {startDay ? (
                      <>
                        <span className="text-fs-2xs font-semibold">{startDay.day}</span>
                        <span className="mt-px text-[9px] font-medium uppercase opacity-80">{startDay.month}</span>
                      </>
                    ) : <CalendarDays className="size-4" />}
                  </span>

                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-baseline gap-1.5">
                      <p className="truncate text-fs-sm font-medium text-foreground">{e.name}</p>
                      {when && (
                        <span className={cn('shrink-0 text-fs-2xs font-semibold', accent(countdownTone(e.daysLeft)).fg)}>
                          {when}
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 truncate text-fs-2xs text-muted-foreground">{formatDate(e.startDate)}</p>

                    {e.fillPct !== null ? (
                      <div className="mt-1.5">
                        <FillBar pct={e.fillPct} />
                        <p className="mt-1 flex items-center justify-between gap-2 text-fs-2xs text-muted-foreground">
                          <span className="tabular-nums">
                            {e.registered.toLocaleString('en-IN')} of {(e.capacity ?? 0).toLocaleString('en-IN')}
                          </span>
                          <span className={cn('shrink-0 font-semibold tabular-nums', accent(capacityTone(e.fillPct)).fg)}>
                            {e.fillPct}%
                          </span>
                        </p>
                      </div>
                    ) : (
                      // Explicit, per the brief: never imply a capacity that is not set.
                      <p className="mt-1.5 text-fs-2xs text-muted-foreground">
                        {e.registered.toLocaleString('en-IN')} registered · no capacity limit
                      </p>
                    )}
                  </div>

                  <ArrowRight className="mt-1 size-3.5 shrink-0 text-muted-foreground/35 transition-transform group-hover:translate-x-0.5" aria-hidden />
                </Link>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
