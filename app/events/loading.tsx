// Streamed fallback for /events.
//
// The page is ISR (`revalidate = 60`), so most visitors are served the cached HTML and never
// see this. It exists for the requests that DO have to wait: the first render after a deploy,
// and the render that repopulates an expired cache entry — on those, the discovery query runs
// before any markup is sent and mobile sat on a blank document.
//
// Deliberately a Server Component with no imports beyond JSX: a loading UI that ships its own
// JavaScript delays the very thing it is covering for. The card and grid shapes mirror
// `EventCardSkeleton` and the `grid gap-5 sm:grid-cols-2 lg:grid-cols-3` layout in
// DiscoveryClient, so the skeleton collapses into the real grid without a visible reflow.

function CardSkeleton() {
  return (
    <div className="flex flex-col overflow-hidden rounded-2xl border border-border/60 bg-card shadow-sm">
      <div className="aspect-[16/9] animate-pulse bg-muted" />
      <div className="flex flex-1 flex-col p-4">
        <div className="h-4 w-5/6 animate-pulse rounded bg-muted" />
        <div className="mt-2 h-4 w-3/5 animate-pulse rounded bg-muted" />
        <div className="mt-3 space-y-2">
          <div className="h-3 w-2/3 animate-pulse rounded bg-muted" />
          <div className="h-3 w-1/2 animate-pulse rounded bg-muted" />
        </div>
        <div className="mt-3 flex items-center gap-2 border-t border-border/50 pt-3">
          <div className="size-6 animate-pulse rounded-md bg-muted" />
          <div className="h-3 w-1/3 animate-pulse rounded bg-muted" />
        </div>
        <div className="mt-4 h-10 animate-pulse rounded-xl bg-muted" />
      </div>
    </div>
  )
}

export default function EventsDiscoveryLoading() {
  return (
    <div className="min-h-screen bg-background">
      {/* Hero — heading, subheading, search bar */}
      <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6 sm:py-14 lg:px-8">
        <div className="mx-auto max-w-3xl text-center">
          <div className="mx-auto h-9 w-3/4 animate-pulse rounded-lg bg-muted sm:h-11" />
          <div className="mx-auto mt-4 h-4 w-2/3 animate-pulse rounded bg-muted" />
          <div className="mx-auto mt-6 h-12 w-full max-w-2xl animate-pulse rounded-xl bg-muted" />
        </div>

        {/* Category quick-scan chips */}
        <div className="mt-8 flex flex-wrap justify-center gap-2" aria-hidden>
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-8 w-24 animate-pulse rounded-full bg-muted" />
          ))}
        </div>
      </div>

      {/* Card grid — three rows is enough to fill a mobile viewport without
          serialising placeholder markup nobody scrolls to. */}
      <div className="mx-auto max-w-7xl px-4 pb-16 sm:px-6 lg:px-8">
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3" aria-hidden>
          {Array.from({ length: 6 }).map((_, i) => (
            <CardSkeleton key={i} />
          ))}
        </div>
      </div>

      <span className="sr-only" role="status">Loading events…</span>
    </div>
  )
}
