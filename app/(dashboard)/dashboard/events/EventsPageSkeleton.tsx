// RD-EVENT-02 §15 · The events page shell, before there is anything to put in it.
//
// Shared by `loading.tsx` and the page's own Suspense boundary so both show the same
// thing. It mirrors the real page's geometry — header block, search field, tab bar, card
// grid, pager rail — because a skeleton whose boxes sit somewhere else than the content
// is a layout shift with extra steps.
//
// Note this cannot fix first paint on its own: the page fetches after Firebase auth
// resolves in the browser, so the SKELETON INSIDE EventsClient is what covers that wait.
// This one covers route transition and hydration.

import { EventCardSkeleton, EVENTS_GRID_CLASS } from './EventCard'
import { DEFAULT_PAGE_SIZE } from './urlState'

export function EventsPageSkeleton() {
  return (
    <div className="space-y-5 p-4 sm:p-6" aria-busy>
      {/* Header: title + subtitle left, primary action right */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-2">
          <div className="h-7 w-32 animate-pulse rounded bg-muted" />
          <div className="h-4 w-56 animate-pulse rounded bg-muted" />
        </div>
        <div className="h-9 w-32 animate-pulse rounded-control bg-muted" />
      </div>

      {/* Toolbar: segmented tabs left, search right (search first on a phone) */}
      <div className="flex flex-col-reverse gap-3 border-b border-border/70 pb-4 md:flex-row md:items-center md:justify-between">
        <div className="h-[46px] w-full max-w-[330px] animate-pulse rounded-control bg-muted" />
        <div className="h-11 w-full animate-pulse rounded-control bg-muted md:h-10 md:max-w-xs" />
      </div>

      <div className={EVENTS_GRID_CLASS}>
        {Array.from({ length: DEFAULT_PAGE_SIZE }).map((_, i) => <EventCardSkeleton key={i} />)}
      </div>

      {/* Pager rail */}
      <div className="flex items-center justify-between border-t border-border pt-4">
        <div className="h-4 w-40 animate-pulse rounded bg-muted" />
        <div className="h-9 w-36 animate-pulse rounded-control bg-muted" />
      </div>

      <span className="sr-only">Loading events…</span>
    </div>
  )
}
