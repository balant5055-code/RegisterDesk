'use client'

// RD-EVENT-02 §16 · Route-level error boundary.
//
// This is the LAST resort, not the fetch error UI. A failed list request is handled
// inside EventsClient, which keeps the header, search and tabs on screen and replaces
// only the grid (§H3). This boundary exists for the case that one cannot catch: a render
// or route-segment failure, where there is no page left to scope an error into.
//
// Without it such a failure escalates to the app-wide boundary and takes the dashboard
// shell down with it; with it, the navigation stays and only this pane is lost.

import { useEffect } from 'react'
import { ErrorState } from '@/components/ui'

export default function EventsError({ error, reset }: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    // The digest is the server-side correlation id; the organizer never sees either.
    console.error('[events] route error', error)
  }, [error])

  return (
    <div className="p-4 sm:p-6">
      <ErrorState
        message="Something went wrong while loading your events."
        onRetry={reset}
        className="rounded-surface border border-dashed border-border"
      />
    </div>
  )
}
