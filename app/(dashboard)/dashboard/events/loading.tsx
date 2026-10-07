import { EventsPageSkeleton } from './EventsPageSkeleton'

// Route-level loading UI. It covers the navigation into /dashboard/events (and the
// hydration gap), NOT the data fetch — that happens client-side after Firebase auth
// resolves, and EventsClient renders its own skeleton grid for it.
export default function Loading() {
  return <EventsPageSkeleton />
}
