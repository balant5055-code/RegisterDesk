import { Suspense } from 'react'
import EventsClient from './EventsClient'
import { EventsPageSkeleton } from './EventsPageSkeleton'

// `useSearchParams` opts its subtree into client-side rendering, so the boundary is
// required — and it is the one that decides what the page looks like before React has
// booted. Without it Next would refuse to build this route.
export default function EventsPage() {
  return (
    <Suspense fallback={<EventsPageSkeleton />}>
      <EventsClient />
    </Suspense>
  )
}
