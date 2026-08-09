'use client'

import { useCallback, useEffect, useState } from 'react'
import { auth }                             from '@/lib/firebase/auth'
import { cn }                               from '@/lib/utils/cn'
import {
  AdminToolbar, StatusPill, TableFrame, THead, Th, TBody, Tr, Td, TableStateRow,
  SearchInput, FilterTabs, LoadMoreButton, ErrorBanner,
} from '@/components/admin'
import type { PillTone } from '@/components/admin'
import { useConfirm } from '@/components/ui/ConfirmDialog'
import Link from 'next/link'
import { Loader2, Eye, ShieldAlert, ShieldOff, ShieldCheck, Ban, X, CheckCircle2, LayoutGrid } from 'lucide-react'
import type { ModerationStatus }            from '@/lib/admin/moderation'
import type {
  AdminModerationItem,
  AdminModerationListResponse,
  AdminModerationAction,
} from '@/lib/admin/moderationTypes'
import type {
  AdminReportItem,
  AdminReportsListResponse,
  AdminReportAction,
  ReportStatus,
} from '@/lib/admin/reportTypes'

type Tab        = 'reports' | 'events' | 'campaigns'
type ContentTab = 'events' | 'campaigns'

const STATUS_FILTERS: { value: '' | ModerationStatus; label: string }[] = [
  { value: '',             label: 'All' },
  { value: 'active',       label: 'Active' },
  { value: 'under_review', label: 'Under review' },
  { value: 'taken_down',   label: 'Taken down' },
]

const btnGhost = 'flex items-center justify-center rounded-md border border-border p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50'

async function getToken(): Promise<string> {
  const u = auth.currentUser
  if (!u) throw new Error('Not authenticated')
  return u.getIdToken()
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

function StatusBadge({ status }: { status: ModerationStatus }) {
  const tone: Record<ModerationStatus, PillTone> = {
    active:       'success',
    under_review: 'warning',
    taken_down:   'danger',
  }
  const label: Record<ModerationStatus, string> = {
    active: 'Active', under_review: 'Under review', taken_down: 'Taken down',
  }
  // Labels are already sentence-cased — keep them as authored (no title-casing).
  return <StatusPill tone={tone[status]} className="normal-case">{label[status]}</StatusPill>
}

export default function AdminModerationPage() {
  const [tab, setTab]             = useState<Tab>('reports')
  const [openCount, setOpenCount] = useState<number | null>(null)

  // Fetch the open-report count on mount so the badge shows regardless of tab.
  useEffect(() => {
    ;(async () => {
      try {
        const token = await getToken()
        const res = await fetch('/api/admin/reports?pageSize=1&status=open', {
          headers: { authorization: `Bearer ${token}` }, cache: 'no-store',
        })
        if (res.ok) setOpenCount(((await res.json()) as AdminReportsListResponse).openCount)
      } catch { /* non-fatal */ }
    })()
  }, [])

  const tabs: { value: Tab; label: string }[] = [
    { value: 'reports',   label: 'Reports' },
    { value: 'events',    label: 'Events' },
    { value: 'campaigns', label: 'Campaigns' },
  ]

  return (
    <div className="space-y-5">
      <AdminToolbar title="Moderation" description="Review reports, take down content, and restore it." />

      <div className="flex items-center gap-1 rounded-lg border border-border bg-card p-1 w-fit">
        {tabs.map(t => (
          <button
            key={t.value}
            onClick={() => setTab(t.value)}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md px-4 py-1.5 text-[13.5px] font-medium transition-colors',
              tab === t.value ? 'bg-primary/[0.08] text-primary' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {t.label}
            {t.value === 'reports' && openCount != null && openCount > 0 && (
              <span className="inline-flex min-w-[18px] items-center justify-center rounded-full bg-red-500 px-1.5 text-[10px] font-bold text-white">
                {openCount}
              </span>
            )}
          </button>
        ))}
      </div>

      {tab === 'reports'
        ? <ReportsTable onOpenCount={setOpenCount} />
        : <ModerationTable key={tab} kind={tab} />}
    </div>
  )
}

function ModerationTable({ kind }: { kind: ContentTab }) {
  const endpoint = kind === 'events' ? '/api/admin/events' : '/api/admin/campaigns'
  const noun     = kind === 'events' ? 'event' : 'campaign'

  const [items,       setItems]       = useState<AdminModerationItem[]>([])
  const [nextCursor,  setNextCursor]  = useState<string | null>(null)
  const [loading,     setLoading]     = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error,       setError]       = useState<string | null>(null)
  const [search,      setSearch]      = useState('')
  const [status,      setStatus]      = useState<'' | ModerationStatus>('')
  const [busySlug,    setBusySlug]    = useState<string | null>(null)
  const { confirm, prompt } = useConfirm()

  const load = useCallback(async (opts: { cursor?: string | null } = {}) => {
    const append = !!opts.cursor
    if (append) setLoadingMore(true); else setLoading(true)
    setError(null)
    try {
      const token = await getToken()
      const qs = new URLSearchParams({ pageSize: '25' })
      if (search)      qs.set('search', search)
      if (status)      qs.set('status', status)
      if (opts.cursor) qs.set('cursor', opts.cursor)

      const res = await fetch(`${endpoint}?${qs.toString()}`, {
        headers: { authorization: `Bearer ${token}` }, cache: 'no-store',
      })
      if (!res.ok) {
        const b = await res.json().catch(() => null) as { error?: string } | null
        throw new Error(b?.error ?? `Request failed (${res.status})`)
      }
      const data = await res.json() as AdminModerationListResponse
      setItems(prev => append ? [...prev, ...data.items] : data.items)
      setNextCursor(data.nextCursor)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      if (append) setLoadingMore(false); else setLoading(false)
    }
  }, [endpoint, search, status])

  useEffect(() => {
    const t = setTimeout(() => { void load() }, 300)
    return () => clearTimeout(t)
  }, [load])

  async function moderate(slug: string, action: AdminModerationAction) {
    let reason = ''
    if (action === 'take_down') {
      reason = (await prompt({ title: `Take down ${noun}`, message: `Reason for taking down this ${noun}:`, required: true, tone: 'danger' }))?.trim() ?? ''
      if (!reason) return
    } else if (action === 'under_review') {
      reason = (await prompt({ title: 'Flag for review', message: 'Reason for review (optional):' }))?.trim() ?? ''
    } else if (!(await confirm({ title: `Restore ${noun}`, message: `Restore this ${noun}?` }))) {
      return
    }

    setBusySlug(slug)
    setError(null)
    try {
      const token = await getToken()
      const res = await fetch(`${endpoint}/${encodeURIComponent(slug)}`, {
        method:  'PATCH',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body:    JSON.stringify({ action, reason }),
      })
      if (!res.ok) {
        const b = await res.json().catch(() => null) as { error?: string } | null
        throw new Error(b?.error ?? `Request failed (${res.status})`)
      }
      const data = await res.json() as { slug: string; moderationStatus: ModerationStatus }
      setItems(prev => prev.map(i => i.slug === slug
        ? { ...i, moderationStatus: data.moderationStatus, moderationReason: reason || null }
        : i,
      ))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Action failed')
    } finally {
      setBusySlug(null)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <SearchInput value={search} onChange={setSearch} placeholder={`Search ${noun}s…`} className="max-w-xs flex-1" />
        <FilterTabs options={STATUS_FILTERS} value={status} onChange={setStatus} aria-label="Filter by status" />
      </div>

      {error && <ErrorBanner>{error}</ErrorBanner>}

      <TableFrame minWidth="min-w-[760px]">
        <THead>
          <Th>Title</Th>
          <Th>Organizer</Th>
          <Th>Status</Th>
          <Th>Published</Th>
          <Th align="right">Actions</Th>
        </THead>
        <TBody>
          {loading ? (
            <TableStateRow colSpan={5}><Loader2 className="mx-auto size-5 animate-spin" /></TableStateRow>
          ) : items.length === 0 ? (
            <TableStateRow colSpan={5}>No {noun}s found.</TableStateRow>
          ) : items.map(it => {
            const busy = busySlug === it.slug
            const publicHref = kind === 'events' ? `/events/${it.slug}` : `/campaign/${it.slug}`
            return (
              <Tr key={it.slug}>
                <Td>
                  <p className="font-medium text-foreground">{it.title}</p>
                  <p className="text-[12px] text-muted-foreground">{it.slug}</p>
                </Td>
                <Td className="text-muted-foreground">{it.organizerName}</Td>
                <Td><StatusBadge status={it.moderationStatus} /></Td>
                <Td className="text-muted-foreground">{fmtDate(it.publishedAt)}</Td>
                <Td>
                  <div className="flex items-center justify-end gap-1.5">
                    <a href={publicHref} target="_blank" rel="noopener noreferrer" title="View" className={btnGhost}><Eye className="size-3.5" /></a>
                    {kind === 'events' && (
                      <Link href={`/admin/events/${it.slug}`} title="Open Event 360 console" className={btnGhost}><LayoutGrid className="size-3.5" /></Link>
                    )}
                    {it.moderationStatus !== 'under_review' && it.moderationStatus !== 'taken_down' && (
                      <button onClick={() => moderate(it.slug, 'under_review')} disabled={busy} title="Mark under review" className={cn(btnGhost, 'text-amber-600 hover:bg-amber-50')}><ShieldAlert className="size-3.5" /></button>
                    )}
                    {it.moderationStatus !== 'taken_down' && (
                      <button onClick={() => moderate(it.slug, 'take_down')} disabled={busy} title="Take down" className={cn(btnGhost, 'text-red-600 hover:bg-red-50')}>
                        {busy ? <Loader2 className="size-3.5 animate-spin" /> : <ShieldOff className="size-3.5" />}
                      </button>
                    )}
                    {it.moderationStatus !== 'active' && (
                      <button onClick={() => moderate(it.slug, 'restore')} disabled={busy} title="Restore" className={cn(btnGhost, 'text-emerald-600 hover:bg-emerald-50')}><ShieldCheck className="size-3.5" /></button>
                    )}
                  </div>
                </Td>
              </Tr>
            )
          })}
        </TBody>
      </TableFrame>

      {nextCursor && !loading && (
        <LoadMoreButton onClick={() => load({ cursor: nextCursor })} loading={loadingMore} />
      )}
    </div>
  )
}

// ─── Reports queue ──────────────────────────────────────────────────────────────

const REPORT_STATUS_FILTERS: { value: '' | ReportStatus; label: string }[] = [
  { value: '',          label: 'All' },
  { value: 'open',      label: 'Open' },
  { value: 'reviewing', label: 'Reviewing' },
  { value: 'actioned',  label: 'Actioned' },
  { value: 'dismissed', label: 'Dismissed' },
]

function ReportStatusBadge({ status }: { status: ReportStatus }) {
  const tone: Record<ReportStatus, PillTone> = {
    open:      'danger',
    reviewing: 'warning',
    actioned:  'success',
    dismissed: 'neutral',
  }
  return <StatusPill tone={tone[status]}>{status}</StatusPill>
}

function ReportsTable({ onOpenCount }: { onOpenCount: (n: number) => void }) {
  const [items,       setItems]       = useState<AdminReportItem[]>([])
  const [nextCursor,  setNextCursor]  = useState<string | null>(null)
  const [loading,     setLoading]     = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error,       setError]       = useState<string | null>(null)
  const [search,      setSearch]      = useState('')
  const [status,      setStatus]      = useState<'' | ReportStatus>('')
  const [busyId,      setBusyId]      = useState<string | null>(null)
  const { prompt } = useConfirm()

  const load = useCallback(async (opts: { cursor?: string | null } = {}) => {
    const append = !!opts.cursor
    if (append) setLoadingMore(true); else setLoading(true)
    setError(null)
    try {
      const token = await getToken()
      const qs = new URLSearchParams({ pageSize: '25' })
      if (search)      qs.set('search', search)
      if (status)      qs.set('status', status)
      if (opts.cursor) qs.set('cursor', opts.cursor)

      const res = await fetch(`/api/admin/reports?${qs.toString()}`, {
        headers: { authorization: `Bearer ${token}` }, cache: 'no-store',
      })
      if (!res.ok) {
        const b = await res.json().catch(() => null) as { error?: string } | null
        throw new Error(b?.error ?? `Request failed (${res.status})`)
      }
      const data = await res.json() as AdminReportsListResponse
      setItems(prev => append ? [...prev, ...data.items] : data.items)
      setNextCursor(data.nextCursor)
      onOpenCount(data.openCount)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      if (append) setLoadingMore(false); else setLoading(false)
    }
  }, [search, status, onOpenCount])

  useEffect(() => {
    const t = setTimeout(() => { void load() }, 300)
    return () => clearTimeout(t)
  }, [load])

  async function act(id: string, action: AdminReportAction, targetType: string) {
    let resolution = ''
    if (action === 'take_down' || action === 'suspend') {
      const what = action === 'take_down' ? `take down this ${targetType}` : 'suspend the organizer'
      resolution = (await prompt({ title: 'Resolution note', message: `Resolution note (required to ${what}):`, required: true, tone: 'danger' }))?.trim() ?? ''
      if (!resolution) return
    } else if (action === 'dismiss') {
      resolution = (await prompt({ title: 'Dismiss report', message: 'Dismissal note (optional):' }))?.trim() ?? ''
    }

    setBusyId(id)
    setError(null)
    try {
      const token = await getToken()
      const res = await fetch(`/api/admin/reports/${id}`, {
        method:  'PATCH',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body:    JSON.stringify({ action, resolution }),
      })
      if (!res.ok) {
        const b = await res.json().catch(() => null) as { error?: string } | null
        throw new Error(b?.error ?? `Request failed (${res.status})`)
      }
      const data = await res.json() as { id: string; status: ReportStatus }
      setItems(prev => prev.map(i => i.id === id ? { ...i, status: data.status, resolution: resolution || i.resolution } : i))
      // Refresh the open badge.
      void load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Action failed')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <SearchInput value={search} onChange={setSearch} placeholder="Search reason / target…" className="max-w-xs flex-1" />
        <FilterTabs options={REPORT_STATUS_FILTERS} value={status} onChange={setStatus} aria-label="Filter by status" />
      </div>

      {error && <ErrorBanner>{error}</ErrorBanner>}

      <TableFrame minWidth="min-w-[820px]">
        <THead>
          <Th>Created</Th>
          <Th>Target</Th>
          <Th>Reason</Th>
          <Th>Status</Th>
          <Th align="right">Actions</Th>
        </THead>
        <TBody>
          {loading ? (
            <TableStateRow colSpan={5}><Loader2 className="mx-auto size-5 animate-spin" /></TableStateRow>
          ) : items.length === 0 ? (
            <TableStateRow colSpan={5}>No reports found.</TableStateRow>
          ) : items.map(r => {
            const busy   = busyId === r.id
            const closed = r.status === 'actioned' || r.status === 'dismissed'
            return (
              <Tr key={r.id}>
                <Td className="text-muted-foreground">{fmtDate(r.createdAt)}</Td>
                <Td>
                  <p className="font-medium capitalize text-foreground">{r.targetType}</p>
                  <p className="text-[12px] text-muted-foreground">{r.targetId}</p>
                </Td>
                <Td>
                  <p className="text-foreground">{r.reason}</p>
                  {r.details && <p className="line-clamp-1 text-[12px] text-muted-foreground">{r.details}</p>}
                </Td>
                <Td><ReportStatusBadge status={r.status} /></Td>
                <Td>
                  <div className="flex items-center justify-end gap-1.5">
                    {!closed && r.status !== 'reviewing' && (
                      <button onClick={() => act(r.id, 'reviewing', r.targetType)} disabled={busy} title="Mark reviewing" className={cn(btnGhost, 'text-amber-600 hover:bg-amber-50')}><Eye className="size-3.5" /></button>
                    )}
                    {!closed && (r.targetType === 'event' || r.targetType === 'campaign') && (
                      <button onClick={() => act(r.id, 'take_down', r.targetType)} disabled={busy} title={`Take down ${r.targetType}`} className={cn(btnGhost, 'text-red-600 hover:bg-red-50')}><ShieldOff className="size-3.5" /></button>
                    )}
                    {!closed && (
                      <button onClick={() => act(r.id, 'suspend', r.targetType)} disabled={busy} title="Suspend organizer" className={cn(btnGhost, 'text-red-600 hover:bg-red-50')}><Ban className="size-3.5" /></button>
                    )}
                    {!closed && (
                      <button onClick={() => act(r.id, 'dismiss', r.targetType)} disabled={busy} title="Dismiss" className={btnGhost}>
                        {busy ? <Loader2 className="size-3.5 animate-spin" /> : <X className="size-3.5" />}
                      </button>
                    )}
                    {closed && <CheckCircle2 className="size-4 text-muted-foreground" aria-label={r.status} />}
                  </div>
                </Td>
              </Tr>
            )
          })}
        </TBody>
      </TableFrame>

      {nextCursor && !loading && (
        <LoadMoreButton onClick={() => load({ cursor: nextCursor })} loading={loadingMore} />
      )}
    </div>
  )
}
