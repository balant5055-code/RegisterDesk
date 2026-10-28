'use client'

// RD-EVENT-02 · The events landing page.
//
// What changed structurally: the card, its menu, the tab bar and every presentation
// decision moved into their own modules, and the URL became the durable state. What is
// left here is orchestration — fetching, mutating, and deciding what the content region
// shows. The page shell (header, search, tabs) is rendered unconditionally, so an error
// or an empty tab replaces the GRID and never the page.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { Plus, Search, X, ChevronLeft, ChevronRight, TrendingUp, FileText, Archive, AlertTriangle } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { auth } from '@/lib/firebase/auth'
import { useAuth } from '@/components/auth/AuthProvider'
import { cn } from '@/lib/utils/cn'
import { EmptyState, ErrorState, PageHeader, buttonVariants, useToast, useConfirm } from '@/components/ui'
import { PERMANENT_DELETE_TITLE, PERMANENT_DELETE_DESCRIPTION } from '@/lib/events/permanentDeleteCopy'
import type { EventListItem, EventsListResponse } from '@/app/api/organizer/events/route'
import type { EventListingTabKey } from '@/lib/events/listingTabs'
import { CLOSURE_SERVICES_DETAIL } from '@/lib/notifications/reviewDeadlineAlerts'
import { EventCard, EventCardSkeleton, EVENTS_GRID_CLASS, type PendingAction } from './EventCard'
import { EventsTabs, tabId, tabPanelId, type EventsTab } from './EventsTabs'
import {
  PAGE_SIZE_OPTIONS, eventsHref, nextUrlState, parseUrlState,
  type EventsUrlState,
} from './urlState'

const TABS: readonly EventsTab[] = [
  { key: 'active',    label: 'Active'    },
  { key: 'published', label: 'Published' },
  { key: 'drafts',    label: 'Drafts'    },
  // RD-REVIEW-03 — events the Super Admin returned for changes (with the request and time left).
  { key: 'action_required', label: 'Action Required' },
  { key: 'archived',  label: 'Archived'  },
]

const EMPTY: Record<EventListingTabKey, {
  icon: LucideIcon; title: string; desc: string; action?: boolean
}> = {
  active:    { icon: TrendingUp, title: 'No active events',    desc: 'Publish an event to start accepting registrations.' },
  published: { icon: TrendingUp, title: 'No published events', desc: 'Published events with open registration appear here.' },
  drafts:    { icon: FileText,   title: 'No draft events',     desc: "Events you're working on appear here.", action: true },
  action_required: { icon: AlertTriangle, title: 'Nothing needs action', desc: 'Events returned to you for changes appear here, with the Super Admin’s request and the time left to resubmit.' },
  archived:  { icon: Archive,    title: 'No archived events',  desc: 'Completed, cancelled, and archived events appear here.' },
}

const SEARCH_DEBOUNCE_MS = 350

export default function EventsClient() {
  const { user, getToken } = useAuth()
  const router       = useRouter()
  const searchParams = useSearchParams()
  const { showToast } = useToast()
  const { confirm }  = useConfirm()

  // ── URL is the durable state; everything below mirrors it ──────────────────
  const urlState: EventsUrlState = useMemo(
    () => parseUrlState(new URLSearchParams(searchParams.toString())),
    [searchParams],
  )
  const { tab: activeTab, search: urlSearch, page: urlPage, pageSize } = urlState

  // The input is the one piece of local state that legitimately leads the URL: it has to
  // echo every keystroke, while the URL (and the fetch) should only move once typing
  // settles. `urlSearch` remains the source of truth for what is actually being queried.
  const [searchInput, setSearchInput] = useState(urlSearch)
  const searchInputRef = useRef<HTMLInputElement>(null)

  // Back/Forward changes the URL without touching the box, so re-sync when it moves
  // underneath us — but not while the user is mid-word, or their typing would fight it.
  useEffect(() => {
    if (document.activeElement !== searchInputRef.current) setSearchInput(urlSearch)
  }, [urlSearch])

  const [events,      setEvents]      = useState<EventListItem[]>([])
  const [loading,     setLoading]     = useState(true)
  const [error,       setError]       = useState<string | null>(null)
  const [cursor,      setCursor]      = useState<string | null>(null)
  const [hasMore,     setHasMore]     = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [pendingByEvent, setPendingByEvent] = useState<Record<string, PendingAction>>({})
  // Bumped to force a refetch of the current query after a mutation, WITHOUT touching the
  // URL — which is exactly how the tab, search and page survive an archive or a duplicate.
  const [reloadKey, setReloadKey] = useState(0)
  const autoSwitchedRef = useRef(false)

  const navigate = useCallback((patch: Partial<EventsUrlState>) => {
    router.push(eventsHref(nextUrlState(urlState, patch)), { scroll: false })
  }, [router, urlState])

  // ── Search debounce → URL ──────────────────────────────────────────────────
  useEffect(() => {
    const trimmed = searchInput.trim()
    if (trimmed === urlSearch) return
    const t = setTimeout(() => navigate({ search: trimmed }), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [searchInput, urlSearch, navigate])

  // ── Authoritative first page for the current (tab, search, size) ───────────
  useEffect(() => {
    if (user === undefined) return
    let cancelled = false

    const run = async () => {
      if (user === null) {
        setError('You must be signed in to view events.')
        setLoading(false)
        return
      }
      setLoading(true)
      setError(null)
      try {
        const token = await getToken()
        if (cancelled || !token) return

        const fetchPage = async (cur: string | null) => {
          const params = new URLSearchParams({ limit: String(pageSize), tab: activeTab })
          if (urlSearch) params.set('search', urlSearch)
          if (cur) params.set('cursor', cur)
          const res = await fetch(`/api/organizer/events?${params.toString()}`, {
            headers: { Authorization: `Bearer ${token}` },
          })
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          return await res.json() as EventsListResponse
        }

        // Restore the window the URL asks for. Cursor pagination cannot jump, so landing
        // on `?page=3` means walking three pages — which is why `parseUrlState` clamps the
        // page number: without that bound a hand-typed `?page=99999` would launch 99999
        // sequential requests. Loading MORE than the URL asks for never happens.
        const first = await fetchPage(null)
        if (cancelled) return
        let all    = first.events
        let next   = first.nextCursor
        while (!cancelled && next && all.length < urlPage * pageSize) {
          const more = await fetchPage(next)
          if (cancelled) return
          const seen = new Set(all.map(e => e.draftId))
          all  = [...all, ...more.events.filter(e => !seen.has(e.draftId))]
          next = more.nextCursor
        }
        if (cancelled) return
        setEvents(all)
        setCursor(next)
        setHasMore(Boolean(next))

        // Existing first-load behaviour, preserved: a brand-new organizer whose Active tab
        // is authoritatively empty is shown their Drafts instead of a dead end. `replace`,
        // not `push` — the redirect is not a step the organizer took, so Back must not
        // land them back on the empty tab they never chose.
        if (!autoSwitchedRef.current && activeTab === 'active' && !urlSearch
            && all.length === 0 && !next) {
          autoSwitchedRef.current = true
          router.replace(eventsHref({ ...urlState, tab: 'drafts', page: 1 }), { scroll: false })
        }
      } catch (e) {
        // The message is for us, not the organizer: the scoped error below shows fixed
        // human copy so a Firestore/HTTP detail can never reach the screen.
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load events')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    run()
    return () => { cancelled = true }
  }, [user, getToken, activeTab, urlSearch, pageSize, urlPage, reloadKey, router, urlState])

  const refetch = useCallback(() => setReloadKey(k => k + 1), [])

  // ── Pagination over the loaded window ──────────────────────────────────────
  const pageCount  = Math.max(1, Math.ceil(events.length / pageSize))
  const safePage   = Math.min(Math.max(urlPage, 1), pageCount) - 1   // 0-based, clamped
  const pageStart  = safePage * pageSize
  const pageItems  = events.slice(pageStart, pageStart + pageSize)
  const showingFrom = events.length === 0 ? 0 : pageStart + 1
  const showingTo   = Math.min(pageStart + pageSize, events.length)
  const canPrev = safePage > 0
  const canNext = (safePage + 1) * pageSize < events.length || hasMore

  async function fetchNextPage(): Promise<number> {
    if (!user || !cursor || loadingMore) return 0
    setLoadingMore(true)
    try {
      const token  = await getToken()
      const params = new URLSearchParams({ limit: String(pageSize), tab: activeTab, cursor })
      if (urlSearch) params.set('search', urlSearch)
      const res = await fetch(`/api/organizer/events?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json() as EventsListResponse
      const seenNow = new Set(events.map(e => e.draftId))
      const fresh   = json.events.filter(e => !seenNow.has(e.draftId))
      setEvents(prev => {
        const seen = new Set(prev.map(e => e.draftId))
        return [...prev, ...json.events.filter(e => !seen.has(e.draftId))]
      })
      setCursor(json.nextCursor)
      setHasMore(Boolean(json.nextCursor))
      return fresh.length
    } catch {
      showToast('Couldn’t load more events.', 'error')
      return 0
    } finally {
      setLoadingMore(false)
    }
  }

  async function goNext() {
    if ((safePage + 1) * pageSize < events.length) { navigate({ page: safePage + 2 }); return }
    if (hasMore && !loadingMore) {
      const added = await fetchNextPage()
      if (added > 0) navigate({ page: safePage + 2 })
    }
  }

  // ── Mutations ──────────────────────────────────────────────────────────────
  //
  // Every one of these ends by refetching the CURRENT query instead of reloading the
  // document. `window.location.reload()` used to throw the organizer back to the default
  // Active tab with their search cleared, which turned "archive this event" into "lose
  // your place". The server stays authoritative throughout: these calls hit the same
  // endpoints with the same rules, and a refusal surfaces as an error toast.

  const setPending = (id: string, action: PendingAction) =>
    setPendingByEvent(prev => ({ ...prev, [id]: action }))

  const authedFetch = useCallback(async (path: string, init?: RequestInit) => {
    const u = auth.currentUser
    if (!u) throw new Error('Not signed in')
    const token = await u.getIdToken()
    return fetch(path, {
      ...init,
      headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${token}` },
    })
  }, [])

  const runMutation = useCallback(async (
    event: EventListItem,
    action: Exclude<PendingAction, null>,
    request: () => Promise<Response>,
    successMessage: string,
    failureMessage: string,
  ) => {
    if (pendingByEvent[event.draftId]) return
    setPending(event.draftId, action)
    try {
      const res  = await request()
      const body = await res.json().catch(() => ({})) as {
        success?: boolean; error?: string; message?: string
      }
      // Success comes from the PAYLOAD as well as the status. A partial permanent delete
      // answers `{ success: false }`, and trusting the status alone would report an event
      // as gone while some of its data survived.
      if (!res.ok || body.success === false) {
        // The server's own refusal ("Only an archived event can be restored.") is more
        // useful than a generic line, so it is preferred when present.
        throw new Error(body.error ?? body.message ?? failureMessage)
      }
      showToast(successMessage, 'success')
      refetch()
    } catch (e) {
      showToast(e instanceof Error ? e.message : failureMessage, 'error')
    } finally {
      setPending(event.draftId, null)
    }
  }, [pendingByEvent, showToast, refetch])

  const onDuplicate = useCallback((event: EventListItem) => {
    void runMutation(event, 'duplicate',
      // The endpoint's existing idempotency contract: a deterministic key makes a
      // double-click or a network retry return the SAME copy instead of a second one.
      () => authedFetch(`/api/organizer/events/${event.draftId}/duplicate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ idempotencyKey: `dup${event.draftId}`.slice(0, 64) }),
      }),
      `“${event.name}” duplicated. The copy is in Drafts.`,
      'Could not duplicate this event.',
    )
  }, [runMutation, authedFetch])

  const onArchive = useCallback(async (event: EventListItem) => {
    const ok = await confirm({
      title: 'Archive this event?',
      message: `“${event.name}” will move to the Archived tab and stop appearing in your active lists. You can restore it later.`,
      confirmLabel: 'Archive',
      tone: 'default',
    })
    if (!ok) return
    void runMutation(event, 'archive',
      () => authedFetch(`/api/organizer/events/${event.draftId}/archive`, { method: 'POST' }),
      `“${event.name}” archived.`,
      'Could not archive this event.',
    )
  }, [confirm, runMutation, authedFetch])

  // Restore is reversible (archive puts it straight back) and moves the event to the
  // PRIVATE unpublished state rather than making anything public, so it does not warrant
  // a confirmation the way archiving and deleting do.
  const onRestore = useCallback((event: EventListItem) => {
    void runMutation(event, 'restore',
      () => authedFetch(`/api/organizer/events/${event.draftId}/restore`, { method: 'POST' }),
      `“${event.name}” restored. It's now unpublished — republish it when you're ready.`,
      'Could not restore this event.',
    )
  }, [runMutation, authedFetch])

  const onDeleteDraft = useCallback(async (event: EventListItem) => {
    const ok = await confirm({
      message: 'Delete this draft event? This cannot be undone.',
      tone: 'danger',
    })
    if (!ok) return
    if (pendingByEvent[event.draftId]) return
    setPending(event.draftId, 'delete')
    try {
      const res = await authedFetch(`/api/organizer/drafts/${event.draftId}`, { method: 'DELETE' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string; message?: string }
        throw new Error(body.message ?? body.error ?? 'Delete failed')
      }
      setEvents(prev => prev.filter(e => e.draftId !== event.draftId))
      try {
        if (localStorage.getItem('rd_event_draft_id') === event.draftId) {
          localStorage.removeItem('rd_event_draft_id')
        }
      } catch { /* private mode / storage disabled — nothing to clean up */ }
      showToast(`“${event.name}” deleted.`, 'success')
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Could not delete this draft.', 'error')
    } finally {
      setPending(event.draftId, null)
    }
  }, [confirm, pendingByEvent, authedFetch, showToast])

  const onDeleteForever = useCallback(async (event: EventListItem) => {
    const ok = await confirm({
      title: PERMANENT_DELETE_TITLE,
      message: PERMANENT_DELETE_DESCRIPTION,
      confirmLabel: 'Delete permanently',
      tone: 'danger',
    })
    if (!ok) return
    void runMutation(event, 'delete',
      () => authedFetch(`/api/organizer/events/${event.draftId}`, { method: 'DELETE' }),
      `“${event.name}” permanently deleted.`,
      'Could not delete this event.',
    )
  }, [confirm, runMutation, authedFetch])

  const onResubmit = useCallback((event: EventListItem) => {
    void runMutation(event, 'resubmit',
      () => authedFetch(`/api/organizer/events/${event.draftId}/resubmit`, { method: 'POST' }),
      `“${event.name}” resubmitted for review.`,
      'Could not resubmit this event.',
    )
  }, [runMutation, authedFetch])

  // RD-REVIEW-02 — closing ends the event for ordinary operations, so it is confirmed first; a
  // cancelled dialog sends nothing. The request names the review cycle this card was loaded with.
  const onCloseReview = useCallback(async (event: EventListItem) => {
    const ok = await confirm({
      title:        `Close “${event.name}”?`,
      message:      'Closing this event is permanent: you will no longer be able to edit it, resubmit it for review or publish it. '
        + CLOSURE_SERVICES_DETAIL,
      confirmLabel: 'Close event',
      tone:         'danger',
    })
    if (!ok) return
    void runMutation(event, 'close',
      () => authedFetch(`/api/organizer/events/${event.draftId}/close-review`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirm: true, reviewCycleId: event.reviewCycleId ?? null }),
      }),
      `“${event.name}” closed.`,
      'Could not close this event. Reload the page and try again.',
    )
  }, [confirm, runMutation, authedFetch])

  const cardActions = useMemo(
    () => ({ onDuplicate, onArchive, onRestore, onDeleteDraft, onDeleteForever, onResubmit, onCloseReview }),
    [onDuplicate, onArchive, onRestore, onDeleteDraft, onDeleteForever, onResubmit, onCloseReview],
  )

  const searching = urlSearch.length > 0

  // ── Content region — the ONLY part an error or an empty result replaces ─────
  let content: React.ReactNode
  if (loading) {
    content = (
      <div className={EVENTS_GRID_CLASS}>
        {Array.from({ length: Math.min(pageSize, 10) }).map((_, i) => <EventCardSkeleton key={i} />)}
      </div>
    )
  } else if (error) {
    content = (
      <ErrorState
        message="Something went wrong while loading your events."
        onRetry={refetch}
        className="rounded-surface border border-dashed border-border"
      />
    )
  } else if (events.length === 0 && searching) {
    content = (
      <EmptyState
        icon={Search}
        title={`No events match “${urlSearch}”`}
        description="Try a different search term."
        size="sm"
        action={{ label: 'Clear search', onClick: () => { setSearchInput(''); navigate({ search: '' }) } }}
        className="rounded-surface border border-dashed border-border"
      />
    )
  } else if (events.length === 0) {
    content = (
      <EmptyState
        icon={EMPTY[activeTab].icon}
        title={EMPTY[activeTab].title}
        description={EMPTY[activeTab].desc}
        size="md"
        action={EMPTY[activeTab].action
          ? { label: 'Create event', href: '/dashboard/events/new/visibility' }
          : undefined}
        className="rounded-surface border border-dashed border-border"
      />
    )
  } else {
    content = (
      <div className={EVENTS_GRID_CLASS}>
        {pageItems.map(e => (
          <EventCard
            key={e.draftId}
            event={e}
            actions={cardActions}
            pending={pendingByEvent[e.draftId] ?? null}
            canDeleteDraft
          />
        ))}
      </div>
    )
  }

  return (
    <div className="space-y-5 p-4 sm:p-6">
      <PageHeader
        title="Events"
        subtitle="Create, manage, and grow your events"
        action={
          <Link
            href="/dashboard/events/new/visibility"
            className={buttonVariants({ variant: 'primary', size: 'sm' })}
          >
            <Plus className="size-3.5" aria-hidden />
            {/* "New" on a phone keeps the subtitle on one line beside it. */}
            <span className="sm:hidden">New</span>
            <span className="hidden sm:inline">Create Event</span>
          </Link>
        }
      />

      {/* 2026-09-29: ONE toolbar row — lifecycle tabs left, search right — on a hairline,
          instead of a search band stacked over a tab band. Search leads on a phone. */}
      <div className="flex flex-col-reverse gap-3 border-b border-border/70 pb-4 md:flex-row md:items-center md:justify-between">
      <EventsTabs tabs={TABS} active={activeTab} onChange={key => navigate({ tab: key })} />

      <div className="relative w-full md:max-w-xs">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <input
          ref={searchInputRef}
          type="search"
          value={searchInput}
          onChange={e => setSearchInput(e.target.value)}
          placeholder="Search events…"
          aria-label="Search events by name"
          className={cn(
            'h-11 w-full rounded-control border border-border/80 bg-card pl-9 pr-10 text-fs-sm text-foreground md:h-10',
            'placeholder:text-muted-foreground',
            'focus:border-primary/40 focus:outline-none focus:ring-2 focus:ring-primary/25',
          )}
        />
        {searchInput && (
          <button
            type="button"
            onClick={() => { setSearchInput(''); navigate({ search: '' }) }}
            aria-label="Clear search"
            className={cn(
              'absolute right-1.5 top-1/2 inline-flex size-8 -translate-y-1/2 items-center justify-center',
              'rounded-control text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
            )}
          >
            <X className="size-4" aria-hidden />
          </button>
        )}
      </div>
      </div>

      {/* The panel the tabs actually control. One panel, re-labelled by the active tab —
          the grid's content IS the tab's content, so a second DOM subtree per tab would
          be four times the markup describing the same region. */}
      <div
        id={tabPanelId(activeTab)}
        role="tabpanel"
        aria-labelledby={tabId(activeTab)}
        tabIndex={-1}
        className="min-w-0 focus:outline-none"
      >
        {content}
      </div>

      {/* Pager — only where there is something to page through. */}
      {!loading && !error && events.length > 0 && (
        <div className="flex flex-col items-center justify-between gap-3 border-t border-border/70 pt-4 sm:flex-row">
          <p className="text-fs-xs text-muted-foreground" aria-live="polite">
            Showing{' '}
            <span className="font-semibold tabular-nums text-foreground">{showingFrom}–{showingTo}</span>
            {' '}of{' '}
            <span className="font-semibold tabular-nums text-foreground">{events.length}</span>
            {' '}loaded{hasMore ? '+' : ''}
          </p>

          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 text-fs-xs text-muted-foreground">
              <span className="hidden sm:inline">Per page</span>
              <select
                value={pageSize}
                onChange={e => navigate({ pageSize: Number(e.target.value) })}
                aria-label="Events per page"
                className="h-9 rounded-control border border-border bg-card px-2 text-fs-xs text-foreground focus:border-primary/40 focus:outline-none focus:ring-2 focus:ring-primary/25"
              >
                {PAGE_SIZE_OPTIONS.map(n => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>

            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => canPrev && navigate({ page: safePage })}
                disabled={!canPrev}
                aria-label="Previous page"
                className={cn(
                  'inline-flex size-9 items-center justify-center rounded-control border border-border',
                  'text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
                  'disabled:pointer-events-none disabled:opacity-40',
                )}
              >
                <ChevronLeft className="size-4" aria-hidden />
              </button>
              <span className="px-2 text-fs-xs font-medium tabular-nums text-foreground">
                Page {safePage + 1} of {pageCount}{hasMore ? '+' : ''}
              </span>
              <button
                type="button"
                onClick={goNext}
                disabled={!canNext || loadingMore}
                aria-label="Next page"
                className={cn(
                  'inline-flex size-9 items-center justify-center rounded-control border border-border',
                  'text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
                  'disabled:pointer-events-none disabled:opacity-40',
                )}
              >
                {loadingMore
                  ? <span className="size-4 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden />
                  : <ChevronRight className="size-4" aria-hidden />}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
