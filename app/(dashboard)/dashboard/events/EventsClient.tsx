'use client'

import { useState, useEffect, useMemo, useRef } from 'react'
import Link from 'next/link'
import { onAuthStateChanged } from 'firebase/auth'
import { auth }               from '@/lib/firebase/auth'
import { cn }                 from '@/lib/utils/cn'
import {
  Calendar, Users, TrendingUp, MoreHorizontal, ExternalLink,
  Plus, Pencil, Copy, Archive, FileText, Search, X, Trash2,
  ChevronLeft, ChevronRight, ImageIcon,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { EmptyState, PageHeader, buttonVariants } from '@/components/ui'
import { ErrorState } from '@/components/dashboard/EmptyState'
import { useConfirm } from '@/components/ui/ConfirmDialog'
import type { EventListItem, EventsListResponse } from '@/app/api/organizer/events/route'
import type { EventLifecycleStatus } from '@/types/events'
import { eventLifecycleMeta } from '@/lib/ui/statusColors'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtDate(iso: string | null): string {
  if (!iso) return 'TBD'
  return new Date(iso).toLocaleDateString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric',
  })
}

function fmtINR(paise: number): string {
  if (paise === 0) return '₹0'
  return new Intl.NumberFormat('en-IN', {
    style: 'currency', currency: 'INR', maximumFractionDigits: 0,
  }).format(paise / 100)
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

// Responsive grid — shared by the skeleton and the content grid so switching
// between them causes no layout shift.
// mobile 1 · tablet 2 · laptop 3 · desktop 4 · desktop-XL 5. No horizontal scroll.
const GRID_CLASS =
  'grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-5 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5'

// ─── Tab definition ───────────────────────────────────────────────────────────
// Active    : published | registration_closed  (currently live events)
// Published : published only                  (open for new registrations)
// Drafts    : draft
// Archived  : completed | cancelled | archived

type TabKey = 'active' | 'published' | 'drafts' | 'archived'

const TABS: { key: TabKey; label: string }[] = [
  { key: 'active',    label: 'Active'    },
  { key: 'published', label: 'Published' },
  { key: 'drafts',    label: 'Drafts'    },
  { key: 'archived',  label: 'Archived'  },
]

// An event may appear in multiple tabs (e.g. published → both 'active' and 'published')
function tabsForEvent(ls: EventLifecycleStatus): TabKey[] {
  switch (ls) {
    case 'published':            return ['active', 'published']
    case 'registration_closed':  return ['active']
    case 'pending_review':       return ['active']
    case 'changes_requested':    return ['drafts']
    case 'draft':                return ['drafts']
    case 'completed':
    case 'cancelled':
    case 'archived':             return ['archived']
    // Recognition only (Phase L2): a taken-offline event is inactive, NOT a draft.
    // Grouped with archived so it can never fall into the 'drafts' default. Never
    // emitted yet — this is provisional and will be revisited when the state ships.
    case 'unpublished':          return ['archived']
    default:                     return ['drafts']
  }
}

// Page-size options for the pager. Reuses the API's existing `limit` parameter.
const PAGE_SIZE_OPTIONS = [5, 10, 20, 50] as const
const DEFAULT_PAGE_SIZE = 10

// ─── Lifecycle Status Badge ───────────────────────────────────────────────────

function StatusBadge({ ls }: { ls: EventLifecycleStatus }) {
  const { label, cls } = eventLifecycleMeta[ls] ?? eventLifecycleMeta.draft
  return (
    <span className={cn('inline-flex rounded-full px-2 py-0.5 text-[12px] font-semibold shadow-sm', cls)}>
      {label}
    </span>
  )
}

// ─── Event Type Badge ─────────────────────────────────────────────────────────

const TYPE_COLORS: Record<string, string> = {
  conference: 'bg-violet-100 text-violet-700',
  sports:     'bg-orange-100 text-orange-700',
  workshop:   'bg-blue-100 text-blue-700',
  concert:    'bg-pink-100 text-pink-700',
  festival:   'bg-yellow-100 text-yellow-700',
  networking: 'bg-teal-100 text-teal-700',
}

function EventTypeBadge({ type }: { type: string | null }) {
  if (!type) return null
  return (
    <span className={cn(
      'inline-flex rounded-full px-2 py-0.5 text-[12px] font-semibold shadow-sm',
      TYPE_COLORS[type] ?? 'bg-muted text-muted-foreground',
    )}>
      {capitalize(type)}
    </span>
  )
}

// ─── Event Card ───────────────────────────────────────────────────────────────

function EventCard({
  event,
  onDelete,
}: {
  event:     EventListItem
  onDelete?: (draftId: string) => Promise<void>
}) {
  const [menuOpen,  setMenuOpen]  = useState(false)
  const [deleting,  setDeleting]  = useState(false)
  const [deleteErr, setDeleteErr] = useState<string | null>(null)
  const [resubmitting, setResubmitting] = useState(false)
  const [resubmitErr,  setResubmitErr]  = useState<string | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const { confirm } = useConfirm()
  const ls = event.lifecycleStatus

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false)
    }
    if (menuOpen) document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [menuOpen])

  const capacityPct = event.totalCapacity
    ? Math.min(Math.round((event.totalRegistrations / event.totalCapacity) * 100), 100)
    : null

  const revenueDisplay = event.isFreeEvent ? 'Free' : fmtINR(event.estimatedRevenue)
  const GRADIENT       = 'bg-gradient-to-br from-[#fb5a6a]/25 via-[#e5277e]/15 to-transparent'
  const isReadOnly     = ls === 'archived' || ls === 'completed' || ls === 'cancelled'
  const isDraft        = ls === 'draft'

  async function handleDelete() {
    if (!onDelete || deleting) return
    setMenuOpen(false)
    if (!(await confirm({ message: 'Delete this draft event? This cannot be undone.', tone: 'danger' }))) return
    setDeleteErr(null)
    setDeleting(true)
    try {
      await onDelete(event.draftId)
    } catch (e) {
      setDeleteErr(e instanceof Error ? e.message : 'Delete failed')
      setDeleting(false)
    }
  }

  // Event was returned by an admin (rejected or changes requested) — the organizer
  // can resubmit it for review (a lifecycle transition; not a re-publish).
  const needsResubmit = event.reviewStatus === 'rejected' || ls === 'changes_requested'
  async function handleResubmit() {
    if (resubmitting) return
    setResubmitErr(null)
    setResubmitting(true)
    try {
      const u = auth.currentUser
      if (!u) throw new Error('Not authenticated')
      const token = await u.getIdToken()
      const res = await fetch(`/api/organizer/events/${event.draftId}/resubmit`, {
        method: 'POST', headers: { authorization: `Bearer ${token}` },
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({})) as { error?: string }
        throw new Error(j.error ?? 'Resubmit failed')
      }
      window.location.reload()
    } catch (e) {
      setResubmitErr(e instanceof Error ? e.message : 'Resubmit failed')
      setResubmitting(false)
    }
  }

  return (
    <div className="group flex h-full flex-col overflow-hidden rounded-xl border border-border bg-card shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:border-border-strong hover:shadow-lg">
      {/* Banner — fixed 16:9 ratio keeps every card the same height */}
      <div className={cn('relative aspect-[16/9] overflow-hidden', GRADIENT)}>
        {event.bannerUrl ? (
          <img
            src={event.bannerUrl}
            alt=""
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
            loading="lazy"
          />
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center gap-1.5 text-primary/25">
            <ImageIcon className="size-7" aria-hidden />
            <span className="select-none text-2xl font-black leading-none">
              {event.name.charAt(0).toUpperCase()}
            </span>
          </div>
        )}
        <div className="absolute left-2.5 top-2.5 flex flex-wrap gap-1.5">
          <StatusBadge ls={ls} />
          <EventTypeBadge type={event.eventType} />
        </div>
        {isReadOnly && (
          <div className="absolute inset-0 bg-foreground/10" />
        )}
      </div>

      {/* Body */}
      <div className="flex flex-1 flex-col gap-3 p-4">
        <div>
          <h3 className={cn(
            'line-clamp-2 text-[15px] font-semibold leading-snug transition-colors',
            isReadOnly ? 'text-muted-foreground' : 'text-foreground group-hover:text-primary',
          )}>
            {event.name}
          </h3>
          <div className="mt-1.5 flex items-center gap-1.5 text-[13px] text-muted-foreground">
            <Calendar className="size-[13px] shrink-0" aria-hidden />
            <span>{fmtDate(event.startDate)}</span>
          </div>
        </div>

        {/* Admin review notice + resubmit */}
        {needsResubmit && (
          <div className="rounded-lg border border-orange-200 bg-orange-50 p-2.5 text-[12.5px]">
            <p className="font-semibold text-orange-800">
              {event.reviewStatus === 'rejected' ? 'Not approved' : 'Changes requested'}
            </p>
            {(event.rejectionReason || event.changesComment) && (
              <p className="mt-0.5 text-orange-700">{event.rejectionReason || event.changesComment}</p>
            )}
            <button
              type="button"
              onClick={handleResubmit}
              disabled={resubmitting}
              className="mt-1.5 inline-flex items-center gap-1 rounded-md bg-orange-600 px-2.5 py-1 text-[12px] font-semibold text-white disabled:opacity-50"
            >
              {resubmitting ? 'Resubmitting…' : 'Resubmit for Review'}
            </button>
            {resubmitErr && <p className="mt-1 text-[11px] text-rose-600">{resubmitErr}</p>}
          </div>
        )}

        {/* Metrics — pushed to fill remaining height so action rows align */}
        <div className="mt-auto space-y-2 rounded-lg border border-border/50 bg-muted/[0.04] p-3">
          <div>
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
                <Users className="size-[13px]" />Registrations
              </span>
              <span className="text-[14px] font-semibold text-foreground tabular-nums">
                {event.totalRegistrations.toLocaleString('en-IN')}
                {event.totalCapacity ? ` / ${event.totalCapacity.toLocaleString('en-IN')}` : ''}
              </span>
            </div>
            {capacityPct !== null && (
              <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted">
                <div
                  className={cn(
                    'h-full rounded-full',
                    capacityPct >= 90 ? 'bg-red-500' : capacityPct >= 70 ? 'bg-amber-500' : 'bg-primary',
                  )}
                  style={{ width: `${capacityPct}%` }}
                />
              </div>
            )}
          </div>
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
              <TrendingUp className="size-[13px]" />Revenue
            </span>
            <span className="text-[14px] font-semibold text-foreground">{revenueDisplay}</span>
          </div>
        </div>
      </div>

      {/* Delete error */}
      {deleteErr && (
        <div className="mx-4 mb-2 flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-600">
          <span className="flex-1">{deleteErr}</span>
          <button type="button" onClick={() => setDeleteErr(null)}><X className="size-3" /></button>
        </div>
      )}

      {/* Actions — equal height buttons, bottom-aligned */}
      <div className="flex items-center gap-2 border-t border-border px-4 py-3">
        <Link
          href={`/dashboard/events/${event.draftId}`}
          className="inline-flex h-[34px] flex-1 items-center justify-center rounded-lg bg-primary px-3 text-[14px] font-semibold text-white transition-colors hover:bg-[#bf1868]"
        >
          {isReadOnly ? 'View' : isDraft ? 'Continue Setup' : 'Manage'}
        </Link>

        {ls !== 'draft' && event.slug && (
          <Link
            href={event.campaignType === 'donation_only'
              ? `/campaign/${event.slug}`
              : `/events/${event.slug}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-[34px] w-[34px] items-center justify-center rounded-lg border border-border text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
            title={event.campaignType === 'donation_only' ? 'View campaign page' : 'View public page'}
          >
            <ExternalLink className="size-3.5" aria-hidden />
          </Link>
        )}

        {/* More dropdown */}
        <div ref={menuRef} className="relative">
          <button
            type="button"
            onClick={() => setMenuOpen(v => !v)}
            className="inline-flex h-[34px] w-[34px] items-center justify-center rounded-lg border border-border text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
            aria-label="More options"
            aria-expanded={menuOpen}
          >
            <MoreHorizontal className="size-3.5" aria-hidden />
          </button>

          {menuOpen && (
            <div className="absolute bottom-full right-0 z-20 mb-1.5 w-44 overflow-hidden rounded-xl border border-border bg-card shadow-lg">
              {!isReadOnly && (
                <Link
                  href={`/dashboard/events/new/visibility?draftId=${event.draftId}`}
                  onClick={() => setMenuOpen(false)}
                  className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left text-[14px] text-foreground hover:bg-muted/60"
                >
                  <Pencil className="size-3.5 text-muted-foreground" />
                  {isDraft ? 'Continue Setup' : 'Edit'}
                </Link>
              )}
              <button
                type="button"
                disabled
                className="flex w-full cursor-not-allowed items-center gap-2.5 px-3.5 py-2.5 text-left text-[13px] text-muted-foreground opacity-50"
              >
                <Copy className="size-3.5" /> Duplicate
                <span className="ml-auto text-[12px]">Go to Manage</span>
              </button>
              {!isReadOnly && (
                <button
                  type="button"
                  disabled
                  className="flex w-full cursor-not-allowed items-center gap-2.5 px-3.5 py-2.5 text-left text-[14px] text-muted-foreground opacity-50"
                >
                  <Archive className="size-3.5" /> Archive
                  <span className="ml-auto text-[12px]">
                    {isDraft && event.hasPaidLicense ? 'Available Soon' : 'Go to Manage'}
                  </span>
                </button>
              )}
              {isDraft && onDelete && (
                <>
                  <div className="my-1 border-t border-border/40" />
                  <button
                    type="button"
                    onClick={handleDelete}
                    disabled={deleting}
                    className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left text-[14px] text-red-600 hover:bg-red-50 disabled:opacity-50"
                  >
                    <Trash2 className="size-3.5" />
                    {deleting ? 'Deleting…' : 'Delete Draft'}
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Skeleton Card ────────────────────────────────────────────────────────────
// Mirrors EventCard's structure and dimensions exactly (16:9 banner, same
// paddings and action-row height) so the transition to real cards has no shift.

function SkeletonCard() {
  return (
    <div className="flex h-full flex-col overflow-hidden rounded-xl border border-border bg-card shadow-sm">
      <div className="aspect-[16/9] animate-pulse bg-muted" />
      <div className="flex flex-1 flex-col gap-3 p-4">
        <div className="h-4 w-3/4 animate-pulse rounded bg-muted" />
        <div className="h-3 w-1/2 animate-pulse rounded bg-muted" />
        <div className="mt-auto h-[72px] animate-pulse rounded-lg bg-muted" />
      </div>
      <div className="border-t border-border px-4 py-3">
        <div className="h-[34px] animate-pulse rounded-lg bg-muted" />
      </div>
    </div>
  )
}

// ─── Empty States ─────────────────────────────────────────────────────────────

const EMPTY: Record<TabKey, { icon: LucideIcon; title: string; desc: string; action?: boolean }> = {
  active:    { icon: TrendingUp,  title: 'No active events',    desc: 'Publish an event to start accepting registrations.' },
  published: { icon: TrendingUp,  title: 'No published events', desc: 'Published events with open registration appear here.' },
  drafts:    { icon: FileText,    title: 'No draft events',     desc: 'Events you\'re working on appear here.', action: true },
  archived:  { icon: Archive,     title: 'No archived events',  desc: 'Completed, cancelled, and archived events appear here.' },
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function EventsClient() {
  const [events,    setEvents]    = useState<EventListItem[]>([])
  const [loading,   setLoading]   = useState(true)
  const [error,     setError]     = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<TabKey>('active')
  const [search,    setSearch]    = useState('')
  const [cursor,      setCursor]      = useState<string | null>(null)
  const [hasMore,     setHasMore]     = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)

  // Pager state. `page` is a display window over the client-filtered list; the
  // data itself is still fetched purely via Firestore cursor pagination below.
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE)
  const [page,     setPage]     = useState(0)

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async user => {
      if (!user) { setError('You must be signed in to view events.'); setLoading(false); return }
      try {
        const token = await user.getIdToken()
        const res   = await fetch(`/api/organizer/events?limit=${DEFAULT_PAGE_SIZE}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const json  = await res.json() as EventsListResponse
        setEvents(json.events)
        setCursor(json.nextCursor)
        setHasMore(Boolean(json.nextCursor))

        // Auto-select Drafts if no active events
        const hasActive = json.events.some(
          e => e.lifecycleStatus === 'published' || e.lifecycleStatus === 'registration_closed',
        )
        if (!hasActive) setActiveTab('drafts')
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load events')
      } finally {
        setLoading(false)
      }
    })
    return unsub
  }, [])

  async function handleDeleteDraft(draftId: string): Promise<void> {
    const user = auth.currentUser
    if (!user) throw new Error('Not signed in')
    const token = await user.getIdToken()

    const res = await fetch(`/api/organizer/drafts/${draftId}`, {
      method:  'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    })

    if (!res.ok) {
      const json = await res.json().catch(() => ({})) as { error?: string; message?: string }
      throw new Error(json.message ?? json.error ?? `Delete failed (${res.status})`)
    }

    // Optimistic removal from state
    setEvents(prev => prev.filter(e => e.draftId !== draftId))

    // Clear localStorage if this draft was active in the wizard
    try {
      if (localStorage.getItem('rd_event_draft_id') === draftId) {
        localStorage.removeItem('rd_event_draft_id')
      }
    } catch { /* ignore */ }
  }

  // Fetches the next Firestore page via the existing cursor + limit contract.
  // Returns the number of newly-added (de-duped) events so callers can decide
  // whether advancing the display page is meaningful.
  async function fetchNextPage(): Promise<number> {
    const user = auth.currentUser
    if (!user || !cursor || loadingMore) return 0
    setLoadingMore(true)
    try {
      const token = await user.getIdToken()
      const res   = await fetch(
        `/api/organizer/events?cursor=${encodeURIComponent(cursor)}&limit=${pageSize}`,
        { headers: { Authorization: `Bearer ${token}` } },
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json() as EventsListResponse
      // Count new rows against the currently-committed events (the functional
      // updater below runs later, so its result can't be read synchronously).
      const seenNow    = new Set(events.map(e => e.draftId))
      const freshCount = json.events.filter(e => !seenNow.has(e.draftId)).length
      setEvents(prev => {
        const seen = new Set(prev.map(e => e.draftId))
        return [...prev, ...json.events.filter(e => !seen.has(e.draftId))]
      })
      setCursor(json.nextCursor)
      setHasMore(Boolean(json.nextCursor))
      return freshCount
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load more events')
      return 0
    } finally {
      setLoadingMore(false)
    }
  }

  // An event can appear in multiple tabs (published → active + published)
  const buckets = useMemo(() => {
    const map = new Map<TabKey, EventListItem[]>()
    TABS.forEach(t => map.set(t.key, []))
    events.forEach(e => {
      tabsForEvent(e.lifecycleStatus).forEach(tab => {
        map.get(tab)!.push(e)
      })
    })
    return map
  }, [events])

  const q = search.trim().toLowerCase()
  const visible = (buckets.get(activeTab) ?? []).filter(e =>
    !q || e.name.toLowerCase().includes(q),
  )

  const pageCount = Math.max(1, Math.ceil(visible.length / pageSize))
  // Clamp during render so a shrunk list (a delete, a tab/search change, or a
  // fetched page that added nothing to the active tab) never leaves us stranded
  // on an out-of-range page. Page is reset to 0 in the filter handlers, so this
  // is purely a safety net — no effect and no cascading render required.
  const safePage    = Math.min(page, pageCount - 1)
  const pageStart   = safePage * pageSize
  const pageItems   = visible.slice(pageStart, pageStart + pageSize)
  const showingFrom = visible.length === 0 ? 0 : pageStart + 1
  const showingTo   = Math.min(pageStart + pageSize, visible.length)
  const canPrev = safePage > 0
  // Next is available if there's another window already loaded, or the server
  // has more pages to fetch via cursor.
  const canNext = (safePage + 1) * pageSize < visible.length || hasMore

  function goPrev() {
    if (canPrev) setPage(Math.max(0, safePage - 1))
  }

  async function goNext() {
    // Another window is already loaded — just advance the display.
    if ((safePage + 1) * pageSize < visible.length) { setPage(safePage + 1); return }
    // Otherwise pull the next cursor page and advance only if it yielded rows
    // for the active tab.
    if (hasMore && !loadingMore) {
      const added = await fetchNextPage()
      if (added > 0) setPage(safePage + 1)
    }
  }

  if (!loading && error) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center p-6">
        <ErrorState message={error} onRetry={() => window.location.reload()} />
      </div>
    )
  }

  return (
    <div className="space-y-6 p-4 sm:p-6">
      {/* Page header */}
      <PageHeader
        title="Events"
        subtitle="Create, manage, and grow your events"
        action={
          <Link
            href="/dashboard/events/new/visibility"
            className={buttonVariants({ variant: 'primary', size: 'sm' })}
          >
            <Plus className="size-3.5" aria-hidden /> Create Event
          </Link>
        }
      />

      {/* Search + summary row */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        {/* Search input */}
        <div className="relative w-full sm:max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <input
            type="search"
            value={search}
            onChange={e => { setSearch(e.target.value); setPage(0) }}
            placeholder="Search events…"
            aria-label="Search events by name"
            className="h-9 w-full rounded-lg border border-border bg-card pl-8 pr-8 text-[14px] text-foreground placeholder:text-muted-foreground focus:border-primary/40 focus:outline-none focus:ring-2 focus:ring-primary/25"
          />
          {search && (
            <button
              type="button"
              onClick={() => { setSearch(''); setPage(0) }}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              aria-label="Clear search"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>

        {/* Status chips */}
        {!loading && events.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {TABS.map(t => {
              const count = buckets.get(t.key)?.length ?? 0
              if (count === 0) return null
              return (
                <span key={t.key} className="rounded-full border border-border bg-card px-3 py-1 text-[13px] text-muted-foreground shadow-sm">
                  <span className="font-semibold text-foreground">{count}</span> {t.label.toLowerCase()}
                </span>
              )
            })}
          </div>
        )}
      </div>

      {/* Tabs — horizontally scrollable on narrow screens, never overflow the page */}
      <div className="border-b border-border">
        <nav className="-mb-px flex gap-0 overflow-x-auto" role="tablist">
          {TABS.map(t => {
            const count  = buckets.get(t.key)?.length ?? 0
            const active = activeTab === t.key
            return (
              <button
                key={t.key}
                role="tab"
                aria-selected={active}
                onClick={() => { setActiveTab(t.key); setPage(0) }}
                className={cn(
                  'flex shrink-0 items-center gap-2 border-b-2 px-4 py-3 text-[14px] font-medium transition-colors',
                  active
                    ? 'border-primary text-primary'
                    : 'border-transparent text-muted-foreground hover:text-foreground',
                )}
              >
                {t.label}
                {count > 0 && (
                  <span className={cn(
                    'rounded-full px-2 py-0.5 text-[12px] font-semibold tabular-nums',
                    active ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground',
                  )}>
                    {count}
                  </span>
                )}
              </button>
            )
          })}
        </nav>
      </div>

      {/* Grid */}
      {loading ? (
        <div className={GRID_CLASS}>
          {Array.from({ length: Math.min(pageSize, 10) }).map((_, i) => <SkeletonCard key={i} />)}
        </div>
      ) : visible.length === 0 && q ? (
        <EmptyState
          icon={Search}
          title={`No events match "${search}"`}
          description="Try adjusting your search term."
          size="sm"
          action={{ label: 'Clear search', onClick: () => { setSearch(''); setPage(0) } }}
          className="rounded-2xl border border-dashed border-border"
        />
      ) : visible.length === 0 ? (
        <EmptyState
          icon={EMPTY[activeTab].icon}
          title={EMPTY[activeTab].title}
          description={EMPTY[activeTab].desc}
          size="md"
          action={EMPTY[activeTab].action ? {
            label: 'Create Event',
            href:  '/dashboard/events/new/visibility',
          } : undefined}
          className="rounded-2xl border border-dashed border-border"
        />
      ) : (
        <div className={GRID_CLASS}>
          {pageItems.map(e => (
            <EventCard
              key={e.draftId}
              event={e}
              onDelete={e.lifecycleStatus === 'draft' && !e.hasPaidLicense ? handleDeleteDraft : undefined}
            />
          ))}
        </div>
      )}

      {/* Pager — cursor pagination internally; Prev / page / Next + page size */}
      {!loading && visible.length > 0 && (
        <div className="flex flex-col items-center justify-between gap-3 border-t border-border pt-4 sm:flex-row">
          <p className="text-[13px] text-muted-foreground">
            Showing{' '}
            <span className="font-semibold text-foreground tabular-nums">{showingFrom}–{showingTo}</span>
            {' '}of{' '}
            <span className="font-semibold text-foreground tabular-nums">{visible.length}</span>
            {' '}loaded{hasMore ? '+' : ''}
          </p>

          <div className="flex items-center gap-4">
            {/* Page size selector — reuses the API `limit` parameter */}
            <label className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
              <span className="hidden sm:inline">Per page</span>
              <select
                value={pageSize}
                onChange={e => { setPageSize(Number(e.target.value)); setPage(0) }}
                aria-label="Events per page"
                className="h-8 rounded-lg border border-border bg-card px-2 text-[13px] text-foreground focus:border-primary/40 focus:outline-none focus:ring-2 focus:ring-primary/25"
              >
                {PAGE_SIZE_OPTIONS.map(n => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>

            {/* Prev / current page / Next */}
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={goPrev}
                disabled={!canPrev}
                aria-label="Previous page"
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-border text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
              >
                <ChevronLeft className="size-4" aria-hidden />
              </button>
              <span className="px-2 text-[13px] font-medium tabular-nums text-foreground">
                Page {safePage + 1} of {pageCount}{hasMore ? '+' : ''}
              </span>
              <button
                type="button"
                onClick={goNext}
                disabled={!canNext || loadingMore}
                aria-label="Next page"
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-border text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
              >
                {loadingMore
                  ? <span className="size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden />
                  : <ChevronRight className="size-4" aria-hidden />}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
