'use client'

// /dashboard/events/[eventId]/checkin — RD-CHECKIN-2.0
//
// A thin frame around the SHARED check-in workspace. The organizer's door and the
// gate operator's door (/ops/checkin/[eventId]) now render the same component, so
// the two can no longer drift: this page previously carried its own event fetch,
// its own lifecycle warning and its own copy of the scan/lookup handlers, and the
// copies had already diverged in what a lookup row did when clicked.
//
// Everything below the back link belongs to CheckinWorkspace: readiness, ownership,
// permissions, attendance, lookup and admission. This file adds navigation and
// nothing else — in particular it no longer re-derives whether the event accepts
// check-ins, because that is the one authoritative resolver's job and answering it
// twice is how the two answers came to disagree.

import Link from 'next/link'
import { ChevronLeft, History } from 'lucide-react'
import CheckinWorkspace from '@/components/checkin/workspace/CheckinWorkspace'

export default function CheckInPageClient({ eventId }: { eventId: string }) {
  return (
    <div className="min-h-screen bg-background">
      <div className="sticky top-0 z-10 border-b border-border bg-background/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-3 sm:px-6">
          <Link
            href={`/dashboard/events/${eventId}`}
            className="inline-flex items-center gap-1 text-fs-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <ChevronLeft className="size-4" aria-hidden /> Back to event
          </Link>

          {/* RD-CHECKIN-04 — the only entry point to the audit trail.
              Shown on the ORGANIZER's check-in page only: /ops has no such link,
              and the route behind it requires `registrations`, which no gate role
              holds. The link is not the control — the route is. */}
          <Link
            href={`/dashboard/events/${eventId}/checkin/history`}
            className="ml-auto inline-flex items-center gap-1.5 text-fs-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <History className="size-4" aria-hidden /> History
          </Link>
        </div>
      </div>

      <div className="px-4 py-6 sm:px-6">
        <CheckinWorkspace eventId={eventId} embedded />
      </div>
    </div>
  )
}
