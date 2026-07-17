'use client'

// Notification Center — full feed (Phase H.4.3).
//
// The organizer's inbox of platform events: category + event filters, search,
// unread toggle, infinite scroll, mark-read / mark-all, and deep-link to each
// destination. Data comes from the permission-gated feed API; rendering is
// metadata-driven via the catalog.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Bell, CheckCheck, Loader2, Search } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import {
  fetchNotifications, markNotificationRead, markAllNotificationsRead,
} from '@/lib/hooks/useNotifications'
import { NOTIFICATION_CATEGORIES, categoryMeta } from '@/lib/notifications/inbox/catalog'
import { iconForKey, SEVERITY_ICON, SEVERITY_DOT, relativeTime } from './notifications/presentation'
import type { NotificationCategory, NotificationView } from '@/lib/notifications/inbox/types'

const PAGE = 20

export function NotificationCenter() {
  const router = useRouter()

  const [items, setItems]           = useState<NotificationView[]>([])
  const [unreadCount, setUnreadCount] = useState(0)
  const [hasMore, setHasMore]       = useState(false)
  const [loading, setLoading]       = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)

  const [category, setCategory] = useState<NotificationCategory | null>(null)
  const [eventId, setEventId]   = useState<string | null>(null)
  const [unread, setUnread]     = useState(false)
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch]     = useState('')

  const cursorRef = useRef<string | null>(null)

  // Debounce the search box.
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 200)
    return () => clearTimeout(t)
  }, [searchInput])

  // await-first so no setState runs synchronously in the effect that calls it.
  const load = useCallback(async (reset: boolean) => {
    const feed = await fetchNotifications({
      cursor: reset ? null : cursorRef.current,
      category, eventId, q: search, unread, limit: PAGE,
    })
    cursorRef.current = feed.nextCursor
    setHasMore(Boolean(feed.nextCursor))
    setItems(prev => (reset ? feed.notifications : [...prev, ...feed.notifications]))
    if (reset) setUnreadCount(feed.unreadCount)
    setLoading(false)
    setLoadingMore(false)
  }, [category, eventId, search, unread])

  // Reload from scratch whenever a filter changes.
  useEffect(() => { void load(true) }, [load])

  const loadMore = useCallback(() => { setLoadingMore(true); void load(false) }, [load])

  // Infinite scroll.
  const sentinelRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = sentinelRef.current
    if (!el) return
    const obs = new IntersectionObserver(entries => {
      if (entries[0]?.isIntersecting && hasMore && !loadingMore) loadMore()
    }, { rootMargin: '200px' })
    obs.observe(el)
    return () => obs.disconnect()
  }, [hasMore, loadingMore, loadMore])

  const eventOptions = useMemo(() => {
    const m = new Map<string, string>()
    items.forEach(n => { if (n.eventId) m.set(n.eventId, n.eventName ?? n.eventId) })
    return [...m.entries()]
  }, [items])

  function openNotification(n: NotificationView) {
    if (!n.read) {
      setItems(prev => prev.map(x => (x.id === n.id ? { ...x, read: true } : x)))
      setUnreadCount(c => Math.max(0, c - 1))
      void markNotificationRead(n.id)
    }
    if (n.link) router.push(n.link)
  }

  async function markAll() {
    setItems(prev => prev.map(x => ({ ...x, read: true })))
    setUnreadCount(0)
    await markAllNotificationsRead()
    void load(true)
  }

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-[20px] font-semibold text-foreground">Notifications</h1>
          <p className="mt-0.5 text-[13.5px] text-muted-foreground">
            Platform events for your workspace{unreadCount > 0 ? ` · ${unreadCount} unread` : ''}.
          </p>
        </div>
        {unreadCount > 0 && (
          <button
            onClick={() => void markAll()}
            className="flex shrink-0 items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-[13px] font-medium text-foreground transition-colors hover:bg-muted/60"
          >
            <CheckCheck className="size-3.5" /> Mark all read
          </button>
        )}
      </div>

      {/* Controls */}
      <div className="space-y-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <input
            type="search"
            value={searchInput}
            onChange={e => setSearchInput(e.target.value)}
            placeholder="Search notifications…"
            aria-label="Search notifications"
            className="h-9 w-full rounded-lg border border-border bg-card pl-9 pr-3 text-[14px] text-foreground placeholder:text-muted-foreground focus:border-primary/40 focus:outline-none focus:ring-2 focus:ring-primary/20"
          />
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <FilterChip active={category === null} onClick={() => setCategory(null)}>All</FilterChip>
          {NOTIFICATION_CATEGORIES.map(c => (
            <FilterChip key={c} active={category === c} onClick={() => setCategory(c)}>
              {categoryMeta(c).label}
            </FilterChip>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {eventOptions.length > 0 && (
            <select
              value={eventId ?? ''}
              onChange={e => setEventId(e.target.value || null)}
              aria-label="Filter by event"
              className="h-8 rounded-lg border border-border bg-card px-2 text-[13px] text-foreground focus:border-primary/40 focus:outline-none focus:ring-2 focus:ring-primary/20"
            >
              <option value="">All events</option>
              {eventOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            </select>
          )}
          <label className="flex cursor-pointer items-center gap-1.5 text-[13px] text-foreground">
            <input type="checkbox" checked={unread} onChange={e => setUnread(e.target.checked)} className="size-3.5 accent-[var(--primary)]" />
            Unread only
          </label>
        </div>
      </div>

      {/* List */}
      <div className="overflow-hidden rounded-xl border border-border bg-card">
        {loading ? (
          <div className="flex items-center justify-center py-16 text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-16 text-center">
            <Bell className="size-6 text-muted-foreground/50" />
            <p className="text-[14px] font-medium text-foreground">Nothing here yet</p>
            <p className="text-[13px] text-muted-foreground">Platform events will appear here as they happen.</p>
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {items.map(n => {
              const Icon = iconForKey(categoryMeta(n.category).iconKey)
              return (
                <li key={n.id}>
                  <button
                    onClick={() => openNotification(n)}
                    className={cn(
                      'flex w-full items-start gap-3 px-4 py-3.5 text-left transition-colors hover:bg-muted/40',
                      !n.read && 'bg-primary/[0.03]',
                    )}
                  >
                    <span className="relative mt-0.5 shrink-0">
                      <Icon className={cn('size-[18px]', SEVERITY_ICON[n.severity])} aria-hidden />
                      {!n.read && <span className={cn('absolute -right-1 -top-1 size-2 rounded-full', SEVERITY_DOT[n.severity])} />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className={cn('text-[14px] leading-snug', !n.read ? 'font-semibold text-foreground' : 'text-foreground/90')}>
                          {n.title}
                        </span>
                        {n.actionRequired && (
                          <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700">
                            Action
                          </span>
                        )}
                      </span>
                      <span className="mt-0.5 block text-[13px] leading-snug text-muted-foreground">{n.body}</span>
                      <span className="mt-1 flex items-center gap-2 text-[11.5px] text-muted-foreground/80">
                        <span>{categoryMeta(n.category).label}</span>
                        {n.eventName && <><span aria-hidden>·</span><span className="truncate">{n.eventName}</span></>}
                        <span aria-hidden>·</span><span>{relativeTime(n.createdAt)}</span>
                      </span>
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}

        {/* Infinite-scroll sentinel + fallback */}
        {!loading && hasMore && (
          <div ref={sentinelRef} className="flex items-center justify-center py-4">
            <button
              onClick={loadMore}
              disabled={loadingMore}
              className="flex items-center gap-2 text-[13px] font-medium text-primary hover:underline disabled:opacity-50"
            >
              {loadingMore && <Loader2 className="size-3.5 animate-spin" />}
              {loadingMore ? 'Loading…' : 'Load more'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function FilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'rounded-full border px-3 py-1 text-[12.5px] font-medium transition-colors',
        active
          ? 'border-primary bg-primary/10 text-primary'
          : 'border-border bg-card text-muted-foreground hover:text-foreground',
      )}
    >
      {children}
    </button>
  )
}
