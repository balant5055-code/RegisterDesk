'use client'

// WhatsApp Inbox — Super Admin console (Phase 1c).
//
// Two tabs:
//   • Conversations — every organizer's WhatsApp conversations, filterable by organizer, event
//     and the ADMIN's own unread state. Opening one marks it read for the Super Admin only;
//     the organizer's unread state is never touched.
//   • Unmatched — inbound messages routing could not safely assign, with the evidence routing
//     looked at. READ-ONLY: there is no reassignment (a product decision not yet made).
//
// Every request goes to /api/admin/whatsapp-inbox/*, which requires a Super Admin
// (resolveSuperAdminUid). This component renders; it never decides what may be seen.
// Replies are not available in Phase 1 — there is no composer here.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { ArrowLeft, ExternalLink, Inbox, Lock, MessageCircle, SearchX, ShieldAlert } from 'lucide-react'
import { auth } from '@/lib/firebase/auth'
import { cn } from '@/lib/utils/cn'
import { Button, Card, EmptyState, ErrorState, Skeleton } from '@/components/ui'
import { fieldControl } from '@/components/ui/field'
import { AdminToolbar, FilterTabs, LoadMoreButton, SearchInput, StatusPill } from '@/components/admin'
import { ConversationRow, ListSkeleton, MessageBody, Thread, displayName } from '@/components/whatsapp-inbox/InboxParts'
import { relativeTime } from '@/components/dashboard/notifications/presentation'
import {
  UNROUTED_REASON_LABELS,
  type AdminConversationDetailResponse,
  type AdminConversationListItem,
  type AdminConversationListResponse,
  type AdminInboxFacets,
  type AdminInboxSummary,
  type InboxMessageView,
  type UnmatchedDetailResponse,
  type UnmatchedListResponse,
  type UnmatchedMessageItem,
  type UnroutedReason,
} from '@/lib/whatsapp-inbox/types'

// Panes fill the viewport below the admin header, the toolbar and the tab row, so each list
// and thread scrolls inside itself. Measured in the browser (390 / 768 / 1280×720 / 1440):
// the chrome is ≈ 15rem from lg up and ≈ 16rem below it, where the toolbar description wraps.
const PANE_HEIGHT = 'h-[calc(100dvh-16rem)] lg:h-[calc(100dvh-15rem)] min-h-[28rem]'
const POLL_MS   = 30_000
const SEARCH_MS = 300

type Tab = 'conversations' | 'unmatched'

async function authed(input: string, init?: RequestInit): Promise<Response> {
  const token = await auth.currentUser?.getIdToken()
  if (!token) throw new Error('Not authenticated')
  return fetch(input, { ...init, cache: 'no-store', headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${token}` } })
}

const fmtDateTime = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—'

const CONTEXT_LABEL: Record<string, string> = {
  none: 'No reply reference', matched: 'Reference matched', invalid: 'Reference failed validation', not_found: 'Reference not found',
}

/** An unmatched receipt rendered through the SAME message renderer as a conversation. */
const asMessage = (u: UnmatchedMessageItem): InboxMessageView => ({
  id: u.id, direction: 'inbound', type: u.type, text: u.text, media: u.media, location: u.location,
  hasContext: Boolean(u.contextWamid), sentAt: u.metaTimestamp ?? u.receivedAt,
})

/**
 * On narrow screens opening an item HIDES the list the user was in, so move focus to the
 * detail header instead of leaving it on a hidden row (keyboard and screen-reader users).
 */
function useFocusOnMobileOpen(selectedId: string | null) {
  const ref = useRef<HTMLElement>(null)
  useEffect(() => {
    if (!selectedId || !window.matchMedia('(max-width: 1023px)').matches) return
    const id = window.requestAnimationFrame(() => ref.current?.focus())
    return () => window.cancelAnimationFrame(id)
  }, [selectedId])
  return ref
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function WhatsAppInboxAdminPage() {
  const router       = useRouter()
  const pathname     = usePathname()
  const searchParams = useSearchParams()
  const tab: Tab     = searchParams.get('tab') === 'unmatched' ? 'unmatched' : 'conversations'

  const [forbidden, setForbidden] = useState(false)
  const [summary, setSummary]     = useState<AdminInboxSummary | null>(null)

  const setParams = useCallback((patch: Record<string, string | null>) => {
    const params = new URLSearchParams(searchParams.toString())
    for (const [k, v] of Object.entries(patch)) {
      if (v) params.set(k, v)
      else params.delete(k)
    }
    const qs = params.toString()
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
  }, [router, pathname, searchParams])

  const loadSummary = useCallback(async () => {
    try {
      const res = await authed('/api/admin/whatsapp-inbox/summary')
      if (res.status === 401 || res.status === 403) { setForbidden(true); return }
      const data = await res.json() as AdminInboxSummary
      if (data.success) setSummary(data)
    } catch { /* the tabs simply show no counts */ }
  }, [])

  useEffect(() => {
    if (forbidden) return            // refused once → stop asking (every poll would be another 403)
    let cancelled = false
    ;(async () => { if (!cancelled) await loadSummary() })()
    const t = window.setInterval(() => { if (document.visibilityState !== 'hidden') void loadSummary() }, POLL_MS)
    return () => { cancelled = true; window.clearInterval(t) }
  }, [loadSummary, forbidden])

  const toolbar = (
    <AdminToolbar
      title="WhatsApp Inbox"
      icon={Inbox}
      description="Attendee replies across all organizers, and messages that could not be routed. Read-only."
    />
  )

  if (forbidden) {
    return (
      <div className="space-y-5">
        {toolbar}
        <EmptyState
          size="lg"
          icon={ShieldAlert}
          title="Super Admin access required"
          description="The WhatsApp Inbox holds attendee messages from every organizer, so it is limited to Super Admins."
        />
      </div>
    )
  }

  const count = (n: number | undefined) => (n ? ` · ${n > 999 ? '999+' : n}` : '')

  return (
    <div className="space-y-5">
      {toolbar}
      <FilterTabs<Tab>
        aria-label="Inbox view"
        className="w-fit"
        value={tab}
        onChange={t => setParams({ tab: t === 'unmatched' ? 'unmatched' : null, c: null, m: null })}
        options={[
          { value: 'conversations', label: `Conversations${count(summary?.unreadConversations)}` },
          { value: 'unmatched',     label: `Unmatched${count(summary?.unmatched)}` },
        ]}
      />
      {tab === 'conversations'
        ? <ConversationsTab selectedId={searchParams.get('c')} open={id => setParams({ c: id })} onForbidden={() => setForbidden(true)} onRead={loadSummary} />
        : <UnmatchedTab selectedId={searchParams.get('m')} open={id => setParams({ m: id })} openConversation={id => setParams({ tab: null, m: null, c: id })} onForbidden={() => setForbidden(true)} />}
    </div>
  )
}

// ─── Conversations ────────────────────────────────────────────────────────────

function ConversationsTab({ selectedId, open, onForbidden, onRead }: {
  selectedId: string | null
  open: (id: string | null) => void
  onForbidden: () => void
  onRead: () => void
}) {
  const [organizerUid, setOrganizerUid] = useState('')
  const [eventId, setEventId]           = useState('')
  const [unreadOnly, setUnreadOnly]     = useState(false)
  const [query, setQuery]               = useState('')
  const [search, setSearch]             = useState('')
  const [facets, setFacets]             = useState<AdminInboxFacets | null>(null)

  const [items, setItems]             = useState<AdminConversationListItem[]>([])
  const [nextCursor, setNextCursor]   = useState<string | null>(null)
  const [truncated, setTruncated]     = useState(false)
  const [listLoading, setListLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [listError, setListError]     = useState<string | null>(null)

  const [detail, setDetail]           = useState<NonNullable<AdminConversationDetailResponse['conversation']> | null>(null)
  const [messages, setMessages]       = useState<InboxMessageView[]>([])
  const [olderCursor, setOlderCursor] = useState<string | null>(null)
  const [loadedFor, setLoadedFor]     = useState<string | null>(null)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const threadScroll = useRef<HTMLDivElement>(null)
  const requested    = useRef<string | null>(null)
  const detailHeader = useFocusOnMobileOpen(selectedId)

  useEffect(() => {
    const t = window.setTimeout(() => setSearch(query.trim()), SEARCH_MS)
    return () => window.clearTimeout(t)
  }, [query])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await authed('/api/admin/whatsapp-inbox/facets')
        if (res.status === 401 || res.status === 403) { onForbidden(); return }
        const data = await res.json() as AdminInboxFacets
        if (!cancelled && data.success) setFacets(data)
      } catch { /* filters fall back to "All" */ }
    })()
    return () => { cancelled = true }
  }, [onForbidden])

  const eventOptions = useMemo(
    () => (facets?.events ?? []).filter(e => !organizerUid || e.organizerUid === organizerUid),
    [facets, organizerUid],
  )
  const filtered = Boolean(organizerUid || eventId || unreadOnly || search)

  const loadList = useCallback(async (cursor?: string) => {
    try {
      const params = new URLSearchParams()
      if (organizerUid) params.set('organizerUid', organizerUid)
      if (eventId)      params.set('eventId', eventId)
      if (unreadOnly)   params.set('unread', '1')
      if (search)       params.set('q', search)
      if (cursor)       params.set('cursor', cursor)
      const res = await authed(`/api/admin/whatsapp-inbox/conversations?${params}`)
      if (res.status === 401 || res.status === 403) { onForbidden(); return }
      const data = await res.json() as AdminConversationListResponse
      if (!data.success) throw new Error(data.error ?? 'Could not load conversations.')
      setListError(null)
      setItems(prev => (cursor ? [...prev, ...(data.items ?? [])] : (data.items ?? [])))
      setNextCursor(data.nextCursor ?? null)
      setTruncated(Boolean(data.truncated))
    } catch (err) {
      setListError(err instanceof Error ? err.message : 'Could not load conversations.')
    }
    setListLoading(false)
    setLoadingMore(false)
  }, [organizerUid, eventId, unreadOnly, search, onForbidden])

  useEffect(() => {
    let cancelled = false
    ;(async () => { if (!cancelled) await loadList() })()
    return () => { cancelled = true }
  }, [loadList])

  const markRead = useCallback(async (id: string) => {
    try {
      const res = await authed(`/api/admin/whatsapp-inbox/conversations/${encodeURIComponent(id)}/read`, { method: 'POST' })
      if (!res.ok) return
      setItems(prev => prev.map(c => (c.id === id ? { ...c, adminUnreadCount: 0 } : c)))
      setDetail(prev => (prev && prev.id === id ? { ...prev, adminUnreadCount: 0 } : prev))
      onRead()
    } catch { /* the next poll shows the true state */ }
  }, [onRead])

  const loadDetail = useCallback(async (id: string, opts: { older?: string; quiet?: boolean } = {}) => {
    if (!opts.quiet && !opts.older) requested.current = id
    const stale = () => requested.current !== id
    try {
      const qs  = opts.older ? `?before=${encodeURIComponent(opts.older)}` : ''
      const res = await authed(`/api/admin/whatsapp-inbox/conversations/${encodeURIComponent(id)}${qs}`)
      if (res.status === 401 || res.status === 403) { onForbidden(); return }
      const data = await res.json() as AdminConversationDetailResponse
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
        setMessages(prev => {
          const seen = new Set(prev.map(m => m.id))
          const add  = (data.messages ?? []).filter(m => !seen.has(m.id))
          return add.length ? [...prev, ...add] : prev
        })
      } else {
        setMessages(data.messages ?? [])
        setOlderCursor(data.olderCursor ?? null)
      }
      if (data.conversation.adminUnreadCount > 0) void markRead(id)
    } catch (err) {
      if (!opts.quiet && !stale()) setDetailError(err instanceof Error ? err.message : 'Could not load this conversation.')
    } finally {
      if (!opts.quiet && !opts.older && !stale()) setLoadedFor(id)
      setLoadingOlder(false)
    }
  }, [markRead, onForbidden])

  useEffect(() => {
    if (!selectedId) return
    let cancelled = false
    ;(async () => { if (!cancelled) await loadDetail(selectedId) })()
    return () => { cancelled = true }
  }, [selectedId, loadDetail])

  const detailLoading  = Boolean(selectedId) && loadedFor !== selectedId
  const threadMessages = loadedFor === selectedId ? messages : []
  const lastMessageId  = messages[messages.length - 1]?.id
  useEffect(() => {
    const el = threadScroll.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lastMessageId, detailLoading])

  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === 'hidden') return
      if (!nextCursor || items.length <= 30) void loadList()
      if (selectedId) void loadDetail(selectedId, { quiet: true })
    }
    const t = window.setInterval(tick, POLL_MS)
    return () => window.clearInterval(t)
  }, [loadList, loadDetail, selectedId, nextCursor, items.length])

  const shown = (detail && detail.id === selectedId ? detail : null) ?? items.find(c => c.id === selectedId) ?? null
  const contextLine = (c: AdminConversationListItem) =>
    `${c.organizerName ?? 'Unknown organizer'} · ${c.eventName ?? c.eventId}`

  return (
    <Card padded={false} className={cn('overflow-hidden', PANE_HEIGHT, 'lg:grid lg:grid-cols-[24rem_minmax(0,1fr)]')}>
      <section
        aria-label="Conversations"
        className={cn('min-h-0 flex-col lg:flex lg:border-r lg:border-border', selectedId ? 'hidden' : 'flex h-full')}
      >
        <div className="shrink-0 space-y-2 border-b border-border p-3">
          <SearchInput value={query} onChange={setQuery} placeholder="Search attendee, phone, event or organizer" />
          <div className="grid grid-cols-2 gap-2">
            <label className="sr-only" htmlFor="wa-admin-organizer">Organizer</label>
            <select
              id="wa-admin-organizer"
              value={organizerUid}
              onChange={e => { setOrganizerUid(e.target.value); setEventId('') }}
              className={fieldControl({ className: 'h-9 min-w-0 truncate pr-8' })}
            >
              <option value="">All organizers</option>
              {(facets?.organizers ?? []).map(o => <option key={o.uid} value={o.uid}>{o.name}</option>)}
            </select>
            <label className="sr-only" htmlFor="wa-admin-event">Event</label>
            <select
              id="wa-admin-event"
              value={eventId}
              onChange={e => setEventId(e.target.value)}
              className={fieldControl({ className: 'h-9 min-w-0 truncate pr-8' })}
            >
              <option value="">All events</option>
              {eventOptions.map(ev => <option key={ev.eventId} value={ev.eventId}>{ev.eventName ?? ev.eventId}</option>)}
            </select>
          </div>
          <FilterTabs<'all' | 'unread'>
            aria-label="Show"
            className="w-fit"
            value={unreadOnly ? 'unread' : 'all'}
            onChange={v => setUnreadOnly(v === 'unread')}
            options={[{ value: 'all', label: 'All' }, { value: 'unread', label: 'Unread' }]}
          />
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
              icon={filtered ? SearchX : MessageCircle}
              title={filtered ? 'No conversations match' : 'No conversations yet'}
              description={filtered ? 'Try a different search or filter.' : 'Attendee replies routed to an organizer appear here.'}
            />
          ) : (
            <>
              <ul>
                {items.map(c => (
                  <ConversationRow
                    key={c.id}
                    c={c}
                    active={c.id === selectedId}
                    onOpen={open}
                    subtitle={contextLine(c)}
                    unreadCount={c.adminUnreadCount}
                  />
                ))}
              </ul>
              {truncated && (
                <p className="px-4 py-3 text-fs-2xs text-muted-foreground">
                  Showing matches from the most recent conversations. Filter by organizer or event to search further back.
                </p>
              )}
              {nextCursor && (
                <div className="p-3">
                  <LoadMoreButton loading={loadingMore} onClick={() => { setLoadingMore(true); void loadList(nextCursor) }} />
                </div>
              )}
            </>
          )}
        </div>
        {facets?.truncated && (
          <p className="shrink-0 border-t border-border px-4 py-2 text-fs-2xs text-muted-foreground">
            Filter options cover the most recent conversations.
          </p>
        )}
      </section>

      <section aria-label="Conversation" className={cn('min-h-0 flex-col', selectedId ? 'flex h-full' : 'hidden lg:flex')}>
        {!selectedId ? (
          <div className="flex flex-1 items-center justify-center p-6">
            <EmptyState size="md" icon={MessageCircle} title="Select a conversation" description="Choose a conversation to read it. Opening one marks it read for Super Admins only." />
          </div>
        ) : (
          <>
            <header ref={detailHeader} tabIndex={-1} aria-label="Conversation details" className="flex shrink-0 items-start gap-3 border-b border-border px-4 py-3 focus:outline-none">
              <button
                type="button"
                onClick={() => open(null)}
                aria-label="Back to conversations"
                className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-control text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 lg:hidden"
              >
                <ArrowLeft className="size-4" aria-hidden />
              </button>
              {shown ? (
                <div className="min-w-0 flex-1">
                  <h2 className="truncate text-fs-md font-semibold text-foreground">{displayName(shown)}</h2>
                  <p className="truncate text-fs-xs text-muted-foreground">
                    {[shown.attendeeName ? shown.attendeePhone : null, `${shown.messageCount} message${shown.messageCount === 1 ? '' : 's'}`,
                      shown.registrationCount > 1 ? `${shown.registrationCount} registrations` : null].filter(Boolean).join(' · ')}
                  </p>
                  <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-fs-xs">
                    <Link href={`/admin/organizers/${encodeURIComponent(shown.organizerUid)}`} className="inline-flex items-center gap-1 font-medium text-primary hover:underline">
                      {shown.organizerName ?? 'Unknown organizer'} <ExternalLink className="size-3" aria-hidden />
                    </Link>
                    <Link href={`/admin/events/${encodeURIComponent(shown.eventId)}`} className="inline-flex items-center gap-1 font-medium text-primary hover:underline">
                      {shown.eventName ?? shown.eventId} <ExternalLink className="size-3" aria-hidden />
                    </Link>
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
                </div>
              ) : detailError ? (
                <ErrorState message={detailError} onRetry={() => { setLoadedFor(null); void loadDetail(selectedId) }} />
              ) : threadMessages.length === 0 ? (
                <EmptyState size="sm" icon={MessageCircle} title="No messages" description="This conversation has no messages to show." />
              ) : (
                <>
                  {olderCursor && (
                    <div className="mb-3 flex justify-center">
                      <Button type="button" variant="ghost" size="xs" disabled={loadingOlder}
                        onClick={() => { setLoadingOlder(true); void loadDetail(selectedId, { older: olderCursor }) }}>
                        {loadingOlder ? 'Loading…' : 'Load earlier messages'}
                      </Button>
                    </div>
                  )}
                  <Thread messages={threadMessages} />
                </>
              )}
            </div>
            <p className="flex shrink-0 items-center gap-2 border-t border-border px-4 py-3 text-fs-xs text-muted-foreground">
              <Lock className="size-3.5 shrink-0" aria-hidden />
              Read-only. Replies aren’t available yet — Coming Soon.
            </p>
          </>
        )}
      </section>
    </Card>
  )
}

// ─── Unmatched ────────────────────────────────────────────────────────────────

const REASONS = Object.keys(UNROUTED_REASON_LABELS) as UnroutedReason[]

function UnmatchedTab({ selectedId, open, openConversation, onForbidden }: {
  selectedId: string | null
  open: (id: string | null) => void
  openConversation: (conversationId: string) => void
  onForbidden: () => void
}) {
  const [reason, setReason]           = useState<UnroutedReason | ''>('')
  const [items, setItems]             = useState<UnmatchedMessageItem[]>([])
  const [nextCursor, setNextCursor]   = useState<string | null>(null)
  const [listLoading, setListLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [listError, setListError]     = useState<string | null>(null)

  const [detail, setDetail]           = useState<UnmatchedDetailResponse | null>(null)
  const [loadedFor, setLoadedFor]     = useState<string | null>(null)
  const requested = useRef<string | null>(null)
  const detailHeader = useFocusOnMobileOpen(selectedId)

  const loadList = useCallback(async (cursor?: string) => {
    try {
      const params = new URLSearchParams()
      if (reason) params.set('reason', reason)
      if (cursor) params.set('cursor', cursor)
      const res = await authed(`/api/admin/whatsapp-inbox/unmatched?${params}`)
      if (res.status === 401 || res.status === 403) { onForbidden(); return }
      const data = await res.json() as UnmatchedListResponse
      if (!data.success) throw new Error(data.error ?? 'Could not load unmatched messages.')
      setListError(null)
      setItems(prev => (cursor ? [...prev, ...(data.items ?? [])] : (data.items ?? [])))
      setNextCursor(data.nextCursor ?? null)
    } catch (err) {
      setListError(err instanceof Error ? err.message : 'Could not load unmatched messages.')
    }
    setListLoading(false)
    setLoadingMore(false)
  }, [reason, onForbidden])

  useEffect(() => {
    let cancelled = false
    ;(async () => { if (!cancelled) await loadList() })()
    const t = window.setInterval(() => { if (document.visibilityState !== 'hidden') void loadList() }, POLL_MS)
    return () => { cancelled = true; window.clearInterval(t) }
  }, [loadList])

  const loadDetail = useCallback(async (id: string) => {
    requested.current = id
    try {
      const res = await authed(`/api/admin/whatsapp-inbox/unmatched/${encodeURIComponent(id)}`)
      if (res.status === 401 || res.status === 403) { onForbidden(); return }
      const data = await res.json() as UnmatchedDetailResponse
      if (requested.current !== id) return
      setDetail(res.status === 404 ? { success: false, error: 'This message is no longer in the unmatched queue.' } : data)
    } catch {
      if (requested.current === id) setDetail({ success: false, error: 'Could not load this message.' })
    } finally {
      if (requested.current === id) setLoadedFor(id)
    }
  }, [onForbidden])

  useEffect(() => {
    if (!selectedId) return
    let cancelled = false
    ;(async () => { if (!cancelled) await loadDetail(selectedId) })()
    return () => { cancelled = true }
  }, [selectedId, loadDetail])

  const detailLoading = Boolean(selectedId) && loadedFor !== selectedId
  const d = loadedFor === selectedId ? detail : null

  return (
    <Card padded={false} className={cn('overflow-hidden', PANE_HEIGHT, 'lg:grid lg:grid-cols-[24rem_minmax(0,1fr)]')}>
      <section aria-label="Unmatched messages" className={cn('min-h-0 flex-col lg:flex lg:border-r lg:border-border', selectedId ? 'hidden' : 'flex h-full')}>
        <div className="shrink-0 border-b border-border p-3">
          <label className="sr-only" htmlFor="wa-admin-reason">Reason</label>
          <select
            id="wa-admin-reason"
            value={reason}
            onChange={e => { setListLoading(true); setReason(e.target.value as UnroutedReason | '') }}
            className={fieldControl({ className: 'h-9 truncate pr-8' })}
          >
            <option value="">All reasons</option>
            {REASONS.map(r => <option key={r} value={r}>{UNROUTED_REASON_LABELS[r]}</option>)}
          </select>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto" aria-busy={listLoading}>
          {listLoading ? (
            <ListSkeleton />
          ) : listError ? (
            <div className="p-4"><ErrorState message={listError} onRetry={() => { setListLoading(true); void loadList() }} /></div>
          ) : items.length === 0 ? (
            <EmptyState size="sm" className="px-6 py-12" icon={Inbox}
              title={reason ? 'Nothing for this reason' : 'The queue is empty'}
              description={reason ? 'Try another reason.' : 'Every inbound message has been routed to an organizer.'} />
          ) : (
            <>
              <ul>
                {items.map(u => {
                  const active = u.id === selectedId
                  return (
                    <li key={u.id}>
                      <button
                        type="button"
                        onClick={() => open(u.id)}
                        aria-current={active ? 'true' : undefined}
                        className={cn(
                          'relative flex w-full flex-col gap-1 border-b border-border px-4 py-3 text-left transition-colors',
                          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40',
                          active ? 'bg-primary/[0.06]' : 'hover:bg-muted/50',
                        )}
                      >
                        {active && <span className="absolute inset-y-0 left-0 w-[2px] bg-primary" aria-hidden />}
                        <span className="flex items-baseline gap-2">
                          <span className="truncate text-fs-sm font-medium text-foreground">{u.fromPhone ?? 'Unknown sender'}</span>
                          <span className="ml-auto shrink-0 text-fs-2xs text-muted-foreground tabular-nums">{relativeTime(u.receivedAt)}</span>
                        </span>
                        <span className="truncate text-fs-xs text-muted-foreground">{u.text ?? (u.media?.caption || u.type)}</span>
                        {u.reason && <StatusPill tone="warning" className="w-fit">{UNROUTED_REASON_LABELS[u.reason]}</StatusPill>}
                      </button>
                    </li>
                  )
                })}
              </ul>
              {nextCursor && (
                <div className="p-3">
                  <LoadMoreButton loading={loadingMore} onClick={() => { setLoadingMore(true); void loadList(nextCursor) }} />
                </div>
              )}
            </>
          )}
        </div>
      </section>

      <section aria-label="Unmatched message" className={cn('min-h-0 flex-col', selectedId ? 'flex h-full' : 'hidden lg:flex')}>
        {!selectedId ? (
          <div className="flex flex-1 items-center justify-center p-6">
            <EmptyState size="md" icon={Inbox} title="Select a message" description="Inspect what arrived and why routing could not assign it." />
          </div>
        ) : (
          <>
            <header ref={detailHeader} tabIndex={-1} aria-label="Message details" className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-3 focus:outline-none">
              <button type="button" onClick={() => open(null)} aria-label="Back to unmatched messages"
                className="flex size-8 shrink-0 items-center justify-center rounded-control text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 lg:hidden">
                <ArrowLeft className="size-4" aria-hidden />
              </button>
              <h2 className="min-w-0 flex-1 truncate text-fs-md font-semibold text-foreground">
                {d?.item?.fromPhone ?? (detailLoading ? '' : 'Unmatched message')}
              </h2>
              {d?.item?.reason && <StatusPill tone="warning">{UNROUTED_REASON_LABELS[d.item.reason]}</StatusPill>}
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4" aria-busy={detailLoading}>
              {detailLoading ? (
                <div className="space-y-3" aria-hidden><Skeleton className="h-16 w-2/3 rounded-lg" /><Skeleton className="h-32 w-full rounded-lg" /></div>
              ) : !d || !d.success || !d.item ? (
                <ErrorState message={d?.error ?? 'Could not load this message.'} onRetry={() => { setLoadedFor(null); void loadDetail(selectedId) }} />
              ) : (
                <UnmatchedDetail d={d} openConversation={openConversation} />
              )}
            </div>
            <p className="flex shrink-0 items-center gap-2 border-t border-border px-4 py-3 text-fs-xs text-muted-foreground">
              <Lock className="size-3.5 shrink-0" aria-hidden />
              Inspection only. Reassigning a message to an organizer is not available.
            </p>
          </>
        )}
      </section>
    </Card>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-fs-2xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</h3>
      {children}
    </section>
  )
}

function UnmatchedDetail({ d, openConversation }: { d: UnmatchedDetailResponse; openConversation: (id: string) => void }) {
  const u = d.item!
  const ev = d.evidence
  const rows: [string, React.ReactNode][] = [
    ['Received',            fmtDateTime(u.receivedAt)],
    ['Sent (WhatsApp time)', fmtDateTime(u.metaTimestamp)],
    ['Sender',              u.fromPhone ?? 'Unknown'],
    ['Type',                u.type],
    ['Reason',              u.reason ? UNROUTED_REASON_LABELS[u.reason] : '—'],
    ['Reply reference',     CONTEXT_LABEL[u.context] ?? u.context],
    ['Candidates',          String(u.candidateCount)],
    ['Routing attempts',    String(u.attempts)],
    ...(u.lastError ? [['Last error', u.lastError] as [string, React.ReactNode]] : []),
    ['WhatsApp message ID', <span key="w" className="break-all font-mono text-fs-2xs">{u.wamid}</span>],
    ...(u.contextWamid ? [['Replied to', <span key="c" className="break-all font-mono text-fs-2xs">{u.contextWamid}</span>] as [string, React.ReactNode]] : []),
  ]
  return (
    <div className="space-y-6">
      <Section title="Message">
        <div className="max-w-lg rounded-lg border border-border bg-muted/40 px-3.5 py-2.5">
          <MessageBody m={asMessage(u)} />
        </div>
      </Section>

      <Section title="Details">
        <dl className="divide-y divide-border rounded-lg border border-border">
          {rows.map(([k, v]) => (
            <div key={k} className="flex gap-4 px-3.5 py-2">
              <dt className="w-40 shrink-0 text-fs-xs text-muted-foreground">{k}</dt>
              <dd className="min-w-0 flex-1 break-words text-fs-xs text-foreground">{v}</dd>
            </div>
          ))}
        </dl>
      </Section>

      {ev?.matchedLog && (
        <Section title="Referenced outbound message">
          <div className="rounded-lg border border-border px-3.5 py-2.5 text-fs-xs text-foreground">
            <p className="font-medium">{ev.matchedLog.organizerName ?? ev.matchedLog.organizerUid ?? 'Unknown organizer'} · {ev.matchedLog.eventName ?? ev.matchedLog.eventId ?? '—'}</p>
            <p className="mt-0.5 text-muted-foreground">
              {ev.matchedLog.templateKey ?? 'message'} · sent to {ev.matchedLog.recipientPhone ?? 'unknown'} ·{' '}
              {ev.matchedLog.hasRegistration ? 'to an attendee' : 'to an organizer'}
            </p>
          </div>
        </Section>
      )}

      {Boolean(ev?.candidateRegistrations.length) && (
        <Section title="Registrations the reference points to">
          <ul className="divide-y divide-border rounded-lg border border-border">
            {ev!.candidateRegistrations.map(r => (
              <li key={r.id} className="px-3.5 py-2 text-fs-xs">
                <p className="font-medium text-foreground">{r.attendeeName ?? 'Unnamed attendee'} <span className="text-muted-foreground">· {r.phone ?? 'no phone'}</span></p>
                <p className="text-muted-foreground">{r.organizerName ?? r.organizerUid ?? '—'} · {r.eventName ?? r.eventId ?? '—'}</p>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title="Existing conversations for this phone">
        {ev?.phoneConversations.length ? (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {ev.phoneConversations.map(c => (
              <li key={c.id} className="flex items-center gap-3 px-3.5 py-2 text-fs-xs">
                <span className="min-w-0 flex-1 truncate text-foreground">{c.organizerName ?? c.organizerUid} · {c.eventName ?? c.eventId}</span>
                <Button type="button" variant="ghost" size="xs" onClick={() => openConversation(c.id)}>View</Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-fs-xs text-muted-foreground">None.</p>
        )}
      </Section>

      {u.reason && (
        <p className="rounded-lg border border-border bg-muted/40 px-3.5 py-2.5 text-fs-xs text-muted-foreground">
          Held back deliberately: {UNROUTED_REASON_LABELS[u.reason].toLowerCase()}. Routing never guesses between organizers or
          events, so the message stays here for review.
        </p>
      )}
    </div>
  )
}
