'use client'

// WhatsApp Inbox (Phase 1b) — attendee replies to RegisterDesk WhatsApp messages.
//
// Two panes on desktop (conversation list | thread), one pane at a time on mobile. The open
// conversation lives in the URL (`?c=<id>`), so a notification deep-link, a refresh and the
// browser back button all land on the same thread.
//
// Everything is fetched from /api/organizer/whatsapp-inbox/*, which authorizes the caller
// (owner/admin via `broadcasts`), applies the `whatsappInbox` flag, and scopes every read to
// the caller's workspace. This component renders; it never decides what a user may see.
//
// Replies are NOT implemented in Phase 1: the composer is shown disabled and labelled
// "Coming Soon".

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { ArrowLeft, Inbox, Loader2, MessageCircle, Search, ShieldAlert, X } from 'lucide-react'
import { auth } from '@/lib/firebase/auth'
import { cn } from '@/lib/utils/cn'
import { Button, Card, EmptyState, ErrorState, PageHeader, Skeleton } from '@/components/ui'
import { fieldControl } from '@/components/ui/field'
import { useFeatureFlags } from '@/lib/config/featureFlagsClient'
import { useBusinessConfig } from '@/lib/config/BusinessConfigProvider'
import { useWorkspacePermissions } from '@/lib/hooks/useWorkspacePermissions'
import { useEventContext } from '@/components/dashboard/EventContextProvider'
import { ComingSoonComposer, ConversationRow, ListSkeleton, Thread, displayName } from '@/components/whatsapp-inbox/InboxParts'
import {
  INBOX_UNREAD_CHANGED_EVENT,
  type ConversationDetailResponse,
  type ConversationListItem,
  type ConversationListResponse,
  type InboxMessageView,
} from '@/lib/whatsapp-inbox/types'

// The two panes fill the viewport below the workspace top bar, the page header and the main
// padding, so the thread scrolls inside itself with the composer pinned — never the whole
// page. Measured in the browser (390 / 768 / 1280×720 / 1440): the chrome above + below
// the card is ≈ 11.2rem on phones and ≈ 13.9rem from md up, where the breadcrumb bar
// appears. The one-line subtitle is part of that budget — a wrapping subtitle overflows.
// The floor keeps it usable on short laptop screens.
const INBOX_PANE_HEIGHT = 'h-[calc(100dvh-11.5rem)] md:h-[calc(100dvh-14rem)] min-h-[28rem]'

const POLL_MS   = 30_000
const SEARCH_MS = 300

type Gate = 'ok' | 'forbidden' | 'disabled'

async function authed(input: string, init?: RequestInit): Promise<Response> {
  const token = await auth.currentUser?.getIdToken()
  if (!token) throw new Error('Not authenticated')
  return fetch(input, { ...init, headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${token}` } })
}

const gateFor = (status: number): Gate | null =>
  status === 403 ? 'forbidden' : status === 404 ? 'disabled' : null

// ─── Page ─────────────────────────────────────────────────────────────────────

export function InboxClient() {
  const router       = useRouter()
  const pathname     = usePathname()
  const searchParams = useSearchParams()
  const selectedId   = searchParams.get('c')

  const flags = useFeatureFlags()
  const configLoading = useBusinessConfig().loading
  const perms = useWorkspacePermissions()
  const { events } = useEventContext()

  // Filters. `query` is the input; `search` is the debounced value actually sent.
  const [eventId, setEventId] = useState('')
  const [unreadOnly, setUnreadOnly] = useState(false)
  const [query, setQuery]     = useState('')
  const [search, setSearch]   = useState('')

  const [items, setItems]           = useState<ConversationListItem[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [truncated, setTruncated]   = useState(false)
  const [listLoading, setListLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [listError, setListError]   = useState<string | null>(null)
  const [gate, setGate]             = useState<Gate>('ok')

  const [detail, setDetail]           = useState<NonNullable<ConversationDetailResponse['conversation']> | null>(null)
  const [messages, setMessages]       = useState<InboxMessageView[]>([])
  const [olderCursor, setOlderCursor] = useState<string | null>(null)
  // Which conversation the pane currently holds. "Loading" is DERIVED (selected ≠ loaded)
  // rather than set inside the selection effect, so no state is set synchronously there.
  const [loadedFor, setLoadedFor]     = useState<string | null>(null)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const threadScroll = useRef<HTMLDivElement>(null)
  // The conversation most recently asked for. A response for any other id arrived late
  // (the user moved on) and is dropped, so a slow thread can never overwrite the open one.
  const requested = useRef<string | null>(null)

  const eventOptions = useMemo(
    () => events.filter(e => e.slug).map(e => ({ value: e.slug as string, label: e.name })),
    [events],
  )
  const filtered = Boolean(eventId || unreadOnly || search)

  useEffect(() => {
    const t = window.setTimeout(() => setSearch(query.trim()), SEARCH_MS)
    return () => window.clearTimeout(t)
  }, [query])

  const openConversation = useCallback((id: string | null) => {
    const params = new URLSearchParams(searchParams.toString())
    if (id) params.set('c', id)
    else params.delete('c')
    const qs = params.toString()
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
  }, [router, pathname, searchParams])

  // ── List ──────────────────────────────────────────────────────────────────
  const loadList = useCallback(async (cursor?: string) => {
    try {
      const params = new URLSearchParams()
      if (eventId)    params.set('eventId', eventId)
      if (unreadOnly) params.set('unread', '1')
      if (search)     params.set('q', search)
      if (cursor)     params.set('cursor', cursor)
      const res  = await authed(`/api/organizer/whatsapp-inbox/conversations?${params}`)
      const g    = gateFor(res.status)
      if (g) { setGate(g); setListLoading(false); setLoadingMore(false); return }
      const data = await res.json() as ConversationListResponse
      if (!data.success) throw new Error(data.error ?? 'Could not load conversations.')
      setGate('ok')
      setListError(null)
      setItems(prev => (cursor ? [...prev, ...(data.items ?? [])] : (data.items ?? [])))
      setNextCursor(data.nextCursor ?? null)
      setTruncated(Boolean(data.truncated))
    } catch (err) {
      setListError(err instanceof Error ? err.message : 'Could not load conversations.')
    }
    setListLoading(false)
    setLoadingMore(false)
  }, [eventId, unreadOnly, search])

  // Fetch only when the page can actually show data: the flag is on and the caller holds
  // `broadcasts` (known, not the optimistic loading answer). Otherwise the page renders its
  // "not switched on" / "no access" state and asking the API would only earn a 404 / 403.
  const inboxUsable = flags.whatsappInbox && !perms.loading && perms.has('broadcasts')

  useEffect(() => {
    if (!inboxUsable) return
    let cancelled = false
    ;(async () => { if (!cancelled) await loadList() })()
    return () => { cancelled = true }
  }, [loadList, inboxUsable])

  // ── Detail ────────────────────────────────────────────────────────────────
  const markRead = useCallback(async (id: string) => {
    try {
      const res = await authed(`/api/organizer/whatsapp-inbox/conversations/${encodeURIComponent(id)}/read`, { method: 'POST' })
      if (!res.ok) return
      setItems(prev => prev.map(c => (c.id === id ? { ...c, unreadCount: 0 } : c)))
      setDetail(prev => (prev && prev.id === id ? { ...prev, unreadCount: 0 } : prev))
      window.dispatchEvent(new Event(INBOX_UNREAD_CHANGED_EVENT))
    } catch { /* best-effort — the next poll shows the true state */ }
  }, [])

  const loadDetail = useCallback(async (id: string, opts: { older?: string; quiet?: boolean } = {}) => {
    if (!opts.quiet && !opts.older) requested.current = id
    const stale = () => requested.current !== id
    try {
      const qs   = opts.older ? `?before=${encodeURIComponent(opts.older)}` : ''
      const res  = await authed(`/api/organizer/whatsapp-inbox/conversations/${encodeURIComponent(id)}${qs}`)
      const g    = gateFor(res.status)
      if (g === 'forbidden') { setGate('forbidden'); return }
      const data = await res.json() as ConversationDetailResponse
      if (stale()) return
      if (res.status === 404 || !data.success || !data.conversation) {
        throw new Error(res.status === 404 ? 'This conversation could not be found.' : (data.error ?? 'Could not load this conversation.'))
      }
      setDetailError(null)
      setDetail(data.conversation)
      if (opts.older) {
        setMessages(prev => [...(data.messages ?? []), ...prev])
        setOlderCursor(data.olderCursor ?? null)
      } else if (opts.quiet) {
        // A poll: merge the newest page into what is already loaded, by id.
        setMessages(prev => {
          const seen = new Set(prev.map(m => m.id))
          const add  = (data.messages ?? []).filter(m => !seen.has(m.id))
          return add.length ? [...prev, ...add] : prev
        })
      } else {
        setMessages(data.messages ?? [])
        setOlderCursor(data.olderCursor ?? null)
      }
      if (data.conversation.unreadCount > 0) void markRead(id)
    } catch (err) {
      if (!opts.quiet && !stale()) setDetailError(err instanceof Error ? err.message : 'Could not load this conversation.')
    } finally {
      if (!opts.quiet && !opts.older && !stale()) setLoadedFor(id)
      setLoadingOlder(false)
    }
  }, [markRead])

  useEffect(() => {
    if (!selectedId || !inboxUsable) return
    let cancelled = false
    ;(async () => { if (!cancelled) await loadDetail(selectedId) })()
    return () => { cancelled = true }
  }, [selectedId, loadDetail, inboxUsable])

  // Keyboard/screen-reader users: on narrow screens opening a conversation HIDES the list they
  // were in, so move focus to the conversation header rather than leaving it on a hidden row.
  const threadHeader = useRef<HTMLElement>(null)
  useEffect(() => {
    if (!selectedId || !window.matchMedia('(max-width: 1023px)').matches) return
    const id = window.requestAnimationFrame(() => threadHeader.current?.focus())
    return () => window.cancelAnimationFrame(id)
  }, [selectedId])

  const detailLoading = Boolean(selectedId) && loadedFor !== selectedId

  // Keep the newest message in view when a thread opens or grows — but not when older
  // messages are prepended. Scrolls the thread itself, never the page around it.
  const lastMessageId = messages[messages.length - 1]?.id
  useEffect(() => {
    const el = threadScroll.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lastMessageId, detailLoading])

  // ── Polling: first list page + the open thread, while the tab is visible ───
  useEffect(() => {
    if (gate !== 'ok' || !inboxUsable) return
    const tick = () => {
      if (document.visibilityState === 'hidden') return
      if (!nextCursor || items.length <= 30) void loadList()
      if (selectedId) void loadDetail(selectedId, { quiet: true })
    }
    const t = window.setInterval(tick, POLL_MS)
    return () => window.clearInterval(t)
  }, [gate, inboxUsable, loadList, loadDetail, selectedId, nextCursor, items.length])

  // ── Gates ─────────────────────────────────────────────────────────────────
  const header = (
    <PageHeader
      title="Inbox"
      subtitle="WhatsApp replies from your attendees."
    />
  )

  // Permission first, then the flag — the same order the API applies (403 before 404), so a
  // member without `broadcasts` is told they lack access rather than that it is switched off.
  if (gate === 'forbidden' || (!perms.loading && !perms.has('broadcasts'))) {
    return (
      <div className="space-y-4">
        {header}
        <EmptyState
          size="lg"
          icon={ShieldAlert}
          title="You don’t have access to the Inbox"
          description="The Inbox is available to workspace owners and admins. Ask your workspace owner if you need access."
        />
      </div>
    )
  }
  // Until the platform configuration has loaded, `flags` holds the CODE DEFAULTS (Inbox off), so
  // deciding now would flash "not switched on" at every workspace where the Inbox IS on.
  if (configLoading) {
    return (
      <div className="space-y-4">
        {header}
        <Card padded={false} className="overflow-hidden"><ListSkeleton /></Card>
      </div>
    )
  }
  // `whatsappInbox` is ONE platform-wide switch (Business Configuration → Feature Flags), not a
  // per-workspace setting — the copy says so, so nobody looks for it in workspace settings.
  if (!flags.whatsappInbox || gate === 'disabled') {
    return (
      <div className="space-y-4">
        {header}
        <EmptyState
          size="lg"
          icon={Inbox}
          title="The Inbox isn’t switched on yet"
          description="Attendee WhatsApp replies are being received and kept. The Inbox will appear here once RegisterDesk switches it on."
        />
      </div>
    )
  }

  // ── Render ────────────────────────────────────────────────────────────────
  const selectedInList = items.find(c => c.id === selectedId) ?? null
  const shown = (detail && detail.id === selectedId ? detail : null) ?? selectedInList
  const threadMessages = loadedFor === selectedId ? messages : []

  return (
    <div className="space-y-4">
      {header}

      <Card padded={false} className={cn('overflow-hidden', INBOX_PANE_HEIGHT, 'lg:grid lg:grid-cols-[22.5rem_minmax(0,1fr)]')}>
        {/* ── Conversation list ── */}
        <section
          aria-label="Conversations"
          className={cn('min-h-0 flex-col lg:flex lg:border-r lg:border-border', selectedId ? 'hidden' : 'flex h-full')}
        >
          <div className="shrink-0 space-y-2 border-b border-border p-3">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <label htmlFor="inbox-search" className="sr-only">Search conversations</label>
              <input
                id="inbox-search"
                type="search"
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="Search name, phone or event"
                className={fieldControl({ className: 'h-9 pl-9 pr-8' })}
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  aria-label="Clear search"
                  className="absolute right-2 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-control text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                >
                  <X className="size-3.5" aria-hidden />
                </button>
              )}
            </div>
            <div className="flex items-center gap-2">
              <label htmlFor="inbox-event" className="sr-only">Filter by event</label>
              <select
                id="inbox-event"
                value={eventId}
                onChange={e => setEventId(e.target.value)}
                className={fieldControl({ className: 'h-9 min-w-0 flex-1 truncate pr-8' })}
              >
                <option value="">All events</option>
                {eventOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              <div role="group" aria-label="Show" className="flex shrink-0 rounded-control border border-border p-0.5">
                {([['all', 'All'], ['unread', 'Unread']] as const).map(([key, label]) => {
                  const on = key === 'unread' ? unreadOnly : !unreadOnly
                  return (
                    <button
                      key={key}
                      type="button"
                      aria-pressed={on}
                      onClick={() => setUnreadOnly(key === 'unread')}
                      className={cn(
                        'h-7 rounded-sm px-2.5 text-fs-xs font-medium transition-colors',
                        on ? 'bg-primary/[0.08] text-primary' : 'text-muted-foreground hover:text-foreground',
                      )}
                    >
                      {label}
                    </button>
                  )
                })}
              </div>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto" aria-busy={listLoading}>
            {listLoading ? (
              <ListSkeleton />
            ) : listError ? (
              <div className="p-4"><ErrorState message={listError} onRetry={() => { setListLoading(true); void loadList() }} /></div>
            ) : items.length === 0 ? (
              <EmptyState
                size="sm"
                className="px-6 py-12"
                icon={filtered ? Search : MessageCircle}
                title={filtered ? 'No conversations match' : 'No messages yet'}
                description={filtered
                  ? 'Try a different search, event or filter.'
                  : 'When an attendee replies to a WhatsApp message RegisterDesk sent for your event, it appears here.'}
              />
            ) : (
              <>
                <ul>
                  {items.map(c => <ConversationRow key={c.id} c={c} active={c.id === selectedId} onOpen={openConversation} />)}
                </ul>
                {truncated && (
                  <p className="px-4 py-3 text-fs-2xs text-muted-foreground">
                    Showing matches from your most recent conversations. Narrow by event to search further back.
                  </p>
                )}
                {nextCursor && (
                  <div className="p-3">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="w-full"
                      disabled={loadingMore}
                      onClick={() => { setLoadingMore(true); void loadList(nextCursor) }}
                    >
                      {loadingMore ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
                      {loadingMore ? 'Loading…' : 'Load more'}
                    </Button>
                  </div>
                )}
              </>
            )}
          </div>
        </section>

        {/* ── Thread ── */}
        <section
          aria-label="Conversation"
          className={cn('min-h-0 flex-col', selectedId ? 'flex h-full' : 'hidden lg:flex')}
        >
          {!selectedId ? (
            <div className="flex flex-1 items-center justify-center p-6">
              <EmptyState
                size="md"
                icon={MessageCircle}
                title="Select a conversation"
                description="Choose a conversation on the left to read the attendee’s messages."
              />
            </div>
          ) : (
            <>
              <header ref={threadHeader} tabIndex={-1} aria-label="Conversation details" className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-3 focus:outline-none">
                <button
                  type="button"
                  onClick={() => openConversation(null)}
                  aria-label="Back to conversations"
                  className="flex size-8 shrink-0 items-center justify-center rounded-control text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 lg:hidden"
                >
                  <ArrowLeft className="size-4" aria-hidden />
                </button>
                {shown ? (
                  <div className="min-w-0 flex-1">
                    <h2 className="truncate text-fs-md font-semibold text-foreground">{displayName(shown)}</h2>
                    <p className="truncate text-fs-xs text-muted-foreground">
                      {[shown.attendeeName ? shown.attendeePhone : null, shown.eventName].filter(Boolean).join(' · ')}
                      {shown.registrationCount > 1 ? ` · ${shown.registrationCount} registrations` : ''}
                    </p>
                  </div>
                ) : (
                  <div className="flex-1 space-y-1.5"><Skeleton className="h-4 w-40" /><Skeleton className="h-3 w-56" /></div>
                )}
              </header>

              <div ref={threadScroll} className="min-h-0 flex-1 overflow-y-auto bg-background/40 px-4 py-4" aria-busy={detailLoading}>
                {detailLoading ? (
                  <div className="space-y-3" aria-hidden>
                    <Skeleton className="h-14 w-2/3 rounded-lg" />
                    <Skeleton className="h-10 w-1/2 rounded-lg" />
                    <Skeleton className="h-16 w-3/5 rounded-lg" />
                  </div>
                ) : detailError ? (
                  <ErrorState message={detailError} onRetry={() => { setLoadedFor(null); void loadDetail(selectedId) }} />
                ) : threadMessages.length === 0 ? (
                  <EmptyState size="sm" icon={MessageCircle} title="No messages" description="This conversation has no messages to show." />
                ) : (
                  <>
                    {olderCursor && (
                      <div className="mb-3 flex justify-center">
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          disabled={loadingOlder}
                          onClick={() => { setLoadingOlder(true); void loadDetail(selectedId, { older: olderCursor }) }}
                        >
                          {loadingOlder ? 'Loading…' : 'Load earlier messages'}
                        </Button>
                      </div>
                    )}
                    <Thread messages={threadMessages} />
                  </>
                )}
              </div>

              <ComingSoonComposer />
            </>
          )}
        </section>
      </Card>
    </div>
  )
}
