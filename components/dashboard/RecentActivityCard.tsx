'use client'

// RD-DASH-03 · Recent Activity — the paged half of the dashboard's detail pair.
//
// ═══ WHY THIS IS ITS OWN COMPONENT ═══════════════════════════════════════════
// Paging is state, and that state must reset when the Event Selector moves. Doing that from
// the page meant a `useEffect` that called `setState` on every new payload — the pattern
// React 19 lints against, and for good reason: it renders once with the previous event's feed
// before correcting itself. Owning the state here and keying the element on the scope lets
// React discard it instead, which is both simpler and correct on the first frame.
//
// ═══ PAGE ONE IS A PROP, NOT STATE ═══════════════════════════════════════════
// The dashboard payload already carries page 1. Copying it into state would create a second
// copy free to go stale on refresh, so page 0 is read straight from props and only pages the
// user actually navigates to are stored. Visited pages are cached, so Previous costs no read.

import { memo, useCallback, useMemo, useState } from 'react'
import { Activity, AlertTriangle, ChevronLeft, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { accent } from '@/lib/dashboard/accents'
import { SectionCard } from './SectionCard'
import { ActivityTimeline, type ActivityItem } from './ActivityTimeline'

/** One row as the server sends it. Structural, so this file needs no route import cycle. */
export interface ActivityRow {
  type:          'registration' | 'checkin'
  sourceId:      string
  eventSlug:     string
  /** RD-ANALYTICS-12-17 · null when the caller may not be told who the row is about. */
  attendeeName:  string | null
  eventName:     string
  passName:      string
  timestamp:     string
}

export interface RecentActivityCardProps {
  /** Page 1, straight from the dashboard payload. */
  initialItems:  ActivityRow[]
  initialHasMore: boolean
  initialCursor:  string | null
  pageSize:      number
  /** Null in all-events mode. Also the scope the paging endpoint is asked for. */
  eventId:       string | null
  eventScoped:   boolean
  /** A draft has a different reason for being empty than a quiet live event. */
  draftMode:     boolean
  /** Rows the server could not read. Disclosed rather than silently missing. */
  skipped:       number
  /**
   * RD-DASH-15 · page one could not be read at all.
   *
   * Distinct from an empty feed. Only ever true for the FIRST page, which arrives in the
   * dashboard payload; every later page is fetched by this card and a failure there is
   * already surfaced by the existing error state.
   */
  initialUnavailable?: boolean
  getToken:      () => Promise<string | null | undefined>
}

/**
 * The pager.
 *
 * ═══ WHY PREVIOUS/NEXT AND NOT 1 2 3 ═════════════════════════════════════════
 * The feed is the MERGE of two Firestore streams, paged by a watermark cursor. A cursor steps
 * forward and back; it cannot jump to page 7 without reading the six before it. Numbered pages
 * would be decorative or expensive, so the control offers what the data supports.
 *
 * And no "of N": an exact total needs count() over both streams, and the check-in half has no
 * index that serves one. "Showing 1–10" is what can be proven.
 */
function Pager({ pageIndex, pageSize, shown, hasPrevious, hasNext, loading, onPrevious, onNext }: {
  pageIndex: number; pageSize: number; shown: number
  hasPrevious: boolean; hasNext: boolean; loading: boolean
  onPrevious: () => void; onNext: () => void
}) {
  const from = pageIndex * pageSize + 1
  const to   = pageIndex * pageSize + shown
  const btn  = 'inline-flex items-center gap-0.5 rounded-control border border-border px-2 py-1 ' +
    'text-fs-2xs font-medium text-foreground transition-colors hover:bg-muted ' +
    'disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent ' +
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40'
  return (
    <nav
      aria-label="Recent activity pages"
      className="mt-auto flex items-center justify-between gap-3 border-t border-border px-3.5 py-2"
    >
      <p className="min-w-0 truncate text-fs-2xs tabular-nums text-muted-foreground" aria-live="polite">
        Showing {from}–{to}
      </p>
      <span className="flex shrink-0 items-center gap-1.5">
        <button type="button" onClick={onPrevious} disabled={!hasPrevious || loading} className={btn}>
          <ChevronLeft className="size-3" aria-hidden /> Previous
        </button>
        <button type="button" onClick={onNext} disabled={!hasNext || loading} className={btn}>
          Next <ChevronRight className="size-3" aria-hidden />
        </button>
      </span>
    </nav>
  )
}

function RecentActivityCardImpl({
  initialItems, initialHasMore, initialCursor, pageSize,
  eventId, eventScoped, draftMode, skipped, initialUnavailable = false, getToken,
}: RecentActivityCardProps) {
  // Pages 1..n only — page 0 lives in props. `cursors[i]` ENDS page i, so it is what starts
  // page i+1; keeping them beside the pages is what makes Previous free.
  const [pages,   setPages]   = useState<Record<number, ActivityRow[]>>({})
  const [cursors, setCursors] = useState<Record<number, string | null>>({ 0: initialCursor })
  const [more,    setMore]    = useState<Record<number, boolean>>({ 0: initialHasMore })
  const [index,   setIndex]   = useState(0)
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState(false)

  const hasMore = index === 0 ? initialHasMore : (more[index] ?? false)

  const load = useCallback(async (target: number) => {
    setLoading(true); setError(false)
    try {
      const token = await getToken()
      const url = new URL('/api/organizer/dashboard/activity', window.location.origin)
      if (eventId) url.searchParams.set('eventId', eventId)
      const cursor = target === 1 ? initialCursor : cursors[target - 1]
      if (cursor) url.searchParams.set('cursor', cursor)
      const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } })
      if (!res.ok) throw new Error(String(res.status))
      const json = await res.json() as { items: ActivityRow[]; hasMore: boolean; nextCursor: string | null }
      setPages(p   => ({ ...p, [target]: json.items }))
      setCursors(c => ({ ...c, [target]: json.nextCursor }))
      setMore(m    => ({ ...m, [target]: json.hasMore }))
      setIndex(target)
    } catch {
      setError(true)
    } finally {
      setLoading(false)
    }
  }, [cursors, eventId, getToken, initialCursor])

  const onNext = useCallback(() => {
    const target = index + 1
    if (pages[target]) { setIndex(target); return }   // already visited — no read
    void load(target)
  }, [index, pages, load])

  const onPrevious = useCallback(() => {
    setError(false)
    setIndex(i => (i > 0 ? i - 1 : i))
  }, [])

  const onRetry = useCallback(() => {
    if (index === 0) { setError(false); return }
    void load(index)
  }, [index, load])

  const items = useMemo<ActivityItem[]>(() => {
    // Page 0 is always the prop, so a refreshed payload updates it without a state write.
    const rows = index === 0 ? initialItems : (pages[index] ?? [])
    const regHref = eventScoped && eventId
      ? `/dashboard/registrations?eventId=${encodeURIComponent(eventId)}`
      : '/dashboard/registrations'
    return rows.map(a => ({
      // One registration legitimately produces TWO activities, so identity is type + id.
      id:          `${a.type}:${a.sourceId}`,
      kind:        a.type === 'checkin' ? 'checkin' : 'registration',
      /**
       * RD-ANALYTICS-12-17 · a subject-less title when the name was withheld.
       *
       * The row still says WHAT happened and WHERE — only WHO is missing. The fallback
       * names no one: not an email, not a phone, not the registration id, not a
       * invented name that could be mistaken for a real participant. "A registration" is
       * true of the row and reveals nothing about the person in it.
       */
      title:       a.attendeeName
        ? (a.type === 'checkin' ? `${a.attendeeName} checked in` : `${a.attendeeName} registered`)
        : (a.type === 'checkin' ? 'A check-in' : 'A registration'),
      // Scoped: the pass alone. All events: the event, then the pass.
      description: (eventScoped ? [a.passName] : [a.eventName, a.passName]).filter(Boolean).join(' · '),
      timestamp:   a.timestamp,
      href:        a.type === 'checkin' ? '/dashboard/check-in' : regHref,
    }))
  }, [index, initialItems, pages, eventScoped, eventId])

  return (
    <SectionCard
      title="Recent activity"
      subtitle="Latest activity"
      leading={
        <span className={cn('flex size-7 shrink-0 items-center justify-center rounded-control', accent('people').tile)} aria-hidden>
          <Activity className="size-3.5" />
        </span>
      }
      href={eventScoped && eventId
        ? `/dashboard/registrations?eventId=${encodeURIComponent(eventId)}`
        : '/dashboard/registrations'}
      hrefLabel="View all"
      className="h-full"
      bodyClassName="flex flex-col"
    >
      {error ? (
        // A failed page must not blank the card, and must not take its partner down with it.
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 py-8 text-center">
          <span className={cn('flex size-8 items-center justify-center rounded-control', accent('critical').tile)} aria-hidden>
            <AlertTriangle className="size-4" />
          </span>
          <p className="text-fs-xs font-medium text-foreground">Unable to load recent activity.</p>
          <button
            type="button"
            onClick={onRetry}
            className="rounded-control border border-border px-2.5 py-1 text-fs-2xs font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            Retry
          </button>
        </div>
      ) : items.length === 0 && initialUnavailable && index === 0 ? (
        /* RD-DASH-15 · UNREAD, not quiet. "No recent activity yet" is a claim about the
           event; this is a statement about the query, and the two must not look alike. */
        <div role="status" className="flex flex-1 flex-col items-center justify-center gap-1 px-4 py-8 text-center">
          <span className={cn('flex size-8 items-center justify-center rounded-control', accent('neutral').tile)} aria-hidden>
            <Activity className="size-4" />
          </span>
          <p className="mt-0.5 text-fs-xs font-medium text-foreground">Recent activity unavailable</p>
          <p className="max-w-xs text-fs-2xs text-muted-foreground">
            This feed could not be read just now, so nothing here is shown as empty.
          </p>
        </div>
      ) : items.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-1 px-4 py-8 text-center">
          <span className={cn('flex size-8 items-center justify-center rounded-control', accent('neutral').tile)} aria-hidden>
            <Activity className="size-4" />
          </span>
          <p className="mt-0.5 text-fs-xs font-medium text-foreground">No recent activity yet.</p>
          <p className="max-w-xs text-fs-2xs text-muted-foreground">
            {draftMode
              ? 'Nobody can register until this event is published, so there is nothing to show yet.'
              : 'When participants register or check in, it will appear here.'}
          </p>
        </div>
      ) : (
        <>
          {/* Dimmed rather than replaced while a page loads: swapping ten rows for a spinner
              collapses the card and drags its partner's height with it. */}
          <div className={cn('flex-1 transition-opacity', loading && 'pointer-events-none opacity-50')}>
            <ActivityTimeline items={items} variant="compact" />
          </div>
          {skipped > 0 && (
            <p className="px-3.5 pb-1 pt-2 text-fs-2xs text-muted-foreground">
              {skipped} recent record{skipped === 1 ? '' : 's'} could not be read and {skipped === 1 ? 'is' : 'are'} not shown here.
            </p>
          )}
          <Pager
            pageIndex={index}
            pageSize={pageSize}
            shown={items.length}
            hasPrevious={index > 0}
            hasNext={hasMore}
            loading={loading}
            onPrevious={onPrevious}
            onNext={onNext}
          />
        </>
      )}
    </SectionCard>
  )
}

export const RecentActivityCard = memo(RecentActivityCardImpl)
