'use client'

// RD-ADMIN-CLOSURE-01 · The Events list — Event 360's missing parent.
//
// ═══ WHAT WAS BROKEN ══════════════════════════════════════════════════════════
// `/admin/events/[slug]` (Event 360) is a GA-2 command console, and RD-ADMIN-IA-01 found it
// had NO browsable entry point. Its only in-app link came from `/admin/event-approvals` —
// which lists only events awaiting approval, so the moment an event was approved the console
// became reachable only by knowing its name and using search.
//
// Organizer 360 never had this problem because `/admin/organizers` exists. This is the same
// arrangement for events, deliberately built to mirror it.
//
// ═══ WHAT THIS IS NOT ═════════════════════════════════════════════════════════
// Not a redesign of Event 360, and not a second moderation console. It is a LIST that opens
// the console. Every moderation ACTION stays where it already lives (`/admin/moderation`);
// this page only reads.
//
// Reuses: the EXISTING `GET /api/admin/events` endpoint (no new route), the shared
// `components/admin` primitives, and the same status vocabulary moderation already uses.

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { auth } from '@/lib/firebase/auth'
import { Loader2, LayoutGrid } from 'lucide-react'
import {
  AdminToolbar, StatusPill, TableFrame, THead, Th, TBody, Tr, Td, TableStateRow,
  SearchInput, FilterTabs, LoadMoreButton, ErrorBanner,
} from '@/components/admin'
import type { PillTone } from '@/components/admin'
import type { ModerationStatus } from '@/lib/admin/moderation'
import type {
  AdminModerationItem, AdminModerationListResponse,
} from '@/lib/admin/moderationTypes'

const STATUS_FILTERS: { value: '' | ModerationStatus; label: string }[] = [
  { value: '',             label: 'All' },
  { value: 'active',       label: 'Active' },
  { value: 'under_review', label: 'Under review' },
  { value: 'taken_down',   label: 'Taken down' },
]

const STATUS_TONE: Record<ModerationStatus, PillTone> = {
  active:       'success',
  under_review: 'warning',
  taken_down:   'danger',
}

const STATUS_LABEL: Record<ModerationStatus, string> = {
  active:       'Active',
  under_review: 'Under review',
  taken_down:   'Taken down',
}

async function getToken(): Promise<string> {
  const u = auth.currentUser
  if (!u) throw new Error('Not authenticated')
  return u.getIdToken()
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
  })
}

export default function AdminEventsPageClient() {
  const [items,  setItems]  = useState<AdminModerationItem[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<'' | ModerationStatus>('')
  const [loading, setLoading] = useState(true)
  const [more,    setMore]    = useState(false)
  const [error,   setError]   = useState<string | null>(null)

  /**
   * One page of events.
   *
   * Declared as a plain async function rather than a `useCallback` that an effect then
   * calls: `react-hooks/set-state-in-effect` traces a hoisted callback as a synchronous set,
   * which it is not — every `setState` below lands after an await. The first page is loaded
   * by an effect that declares its own runner (see below), which is how every other data
   * page in this codebase does it.
   *
   * `next` appends rather than replaces, so "load more" keeps what is on screen — the same
   * behaviour the Organizers list has.
   */
  const fetchPage = async (
    next: string | null, q: string, st: '' | ModerationStatus,
  ): Promise<AdminModerationListResponse> => {
    const qs = new URLSearchParams({ pageSize: '25' })
    if (next) qs.set('cursor', next)
    if (q)    qs.set('search', q)
    if (st)   qs.set('status', st)

    const res = await fetch(`/api/admin/events?${qs.toString()}`, {
      headers: { authorization: `Bearer ${await getToken()}` },
      cache: 'no-store',
    })
    if (!res.ok) throw new Error('Could not load events.')
    return await res.json() as AdminModerationListResponse
  }

  // First page, and again whenever a filter changes. A cursor from the previous filter would
  // page into a different result set, so this always restarts from the top.
  useEffect(() => {
    let cancelled = false
    const run = async () => {
      if (!cancelled) { setLoading(true); setError(null) }
      try {
        const data = await fetchPage(null, search, status)
        if (cancelled) return
        setItems(data.items)
        setCursor(data.nextCursor)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load events.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void run()
    return () => { cancelled = true }
  }, [search, status])

  const loadMore = useCallback(async () => {
    if (!cursor || more) return
    setMore(true)
    try {
      const data = await fetchPage(cursor, search, status)
      setItems(prev => [...prev, ...data.items])
      setCursor(data.nextCursor)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load more events.')
    } finally {
      setMore(false)
    }
  }, [cursor, more, search, status])

  return (
    <div className="space-y-5">
      {/* Same composition as the Organizers list: toolbar for identity, a separate filter
          row beneath it. Copying the arrangement rather than inventing one is the point —
          the two consoles should feel like the same product. */}
      <AdminToolbar
        title="Events"
        description="Every published event on the platform. Open one to reach its Event 360 console."
      />

      <div className="flex flex-wrap items-center gap-3">
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Search by event, slug or organizer…"
          className="max-w-xs flex-1"
        />
        <FilterTabs
          options={STATUS_FILTERS}
          value={status}
          onChange={setStatus}
          aria-label="Filter by moderation status"
        />
      </div>

      {error && <ErrorBanner>{error}</ErrorBanner>}

      <TableFrame>
        <THead>
          <Th>Event</Th>
          <Th>Organizer</Th>
          <Th>Status</Th>
          <Th>Published</Th>
          <Th align="right">Console</Th>
        </THead>
        <TBody>
          {loading ? (
            <TableStateRow colSpan={5}>
              <Loader2 className="mx-auto size-4 animate-spin" aria-hidden />
            </TableStateRow>
          ) : items.length === 0 ? (
            <TableStateRow colSpan={5}>
              {search || status
                ? 'No events match these filters.'
                : 'No published events yet.'}
            </TableStateRow>
          ) : (
            items.map(ev => (
              <Tr key={ev.slug}>
                <Td>
                  {/* The whole point of this page: a real link to the console. */}
                  <Link
                    href={`/admin/events/${encodeURIComponent(ev.slug)}`}
                    className="font-medium text-foreground hover:underline"
                  >
                    {ev.title}
                  </Link>
                  <span className="block text-fs-2xs text-muted-foreground">{ev.slug}</span>
                </Td>
                <Td>
                  {/* Cross-console link — Event 360 ↔ Organizer 360, the pairing the
                      command palette already offers as an action. */}
                  <Link
                    href={`/admin/organizers/${encodeURIComponent(ev.organizerUid)}`}
                    className="hover:underline"
                  >
                    {ev.organizerName || '—'}
                  </Link>
                </Td>
                <Td>
                  <StatusPill tone={STATUS_TONE[ev.moderationStatus]}>
                    {STATUS_LABEL[ev.moderationStatus]}
                  </StatusPill>
                </Td>
                <Td>{fmtDate(ev.publishedAt)}</Td>
                <Td align="right">
                  <Link
                    href={`/admin/events/${encodeURIComponent(ev.slug)}`}
                    className="inline-flex items-center gap-1.5 text-fs-2xs text-muted-foreground hover:text-foreground"
                    title="Open Event 360"
                  >
                    <LayoutGrid className="size-3.5" aria-hidden />
                    Event 360
                  </Link>
                </Td>
              </Tr>
            ))
          )}
        </TBody>
      </TableFrame>

      {cursor && (
        <LoadMoreButton loading={more} onClick={() => void loadMore()} />
      )}
    </div>
  )
}
