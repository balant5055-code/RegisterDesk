'use client'

import { useState, useEffect, useMemo, useRef } from 'react'
import Link from 'next/link'
import { onAuthStateChanged } from 'firebase/auth'
import { auth }               from '@/lib/firebase/auth'
import { cn }                 from '@/lib/utils/cn'
import {
  Calendar, Users, TrendingUp, MoreHorizontal, ExternalLink,
  Plus, Pencil, Copy, Archive, AlertCircle, FileText, Search, X, Trash2,
} from 'lucide-react'
import type { EventListItem, EventsListResponse } from '@/app/api/organizer/events/route'
import type { EventLifecycleStatus } from '@/types/events'

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
    case 'draft':                return ['drafts']
    case 'completed':
    case 'cancelled':
    case 'archived':             return ['archived']
    default:                     return ['drafts']
  }
}

// ─── Lifecycle Status Badge ───────────────────────────────────────────────────

function StatusBadge({ ls }: { ls: EventLifecycleStatus }) {
  const map: Record<EventLifecycleStatus, { label: string; cls: string }> = {
    draft:               { label: 'Draft',       cls: 'bg-muted text-muted-foreground'   },
    published:           { label: 'Published',   cls: 'bg-emerald-100 text-emerald-700'  },
    registration_closed: { label: 'Reg. Closed', cls: 'bg-amber-100 text-amber-700'     },
    completed:           { label: 'Completed',   cls: 'bg-sky-100 text-sky-700'          },
    cancelled:           { label: 'Cancelled',   cls: 'bg-red-100 text-red-600'          },
    archived:            { label: 'Archived',    cls: 'bg-muted text-muted-foreground'   },
  }
  const { label, cls } = map[ls] ?? map.draft
  return (
    <span className={cn('inline-flex rounded-full px-2 py-0.5 text-[12px] font-semibold', cls)}>
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
      'inline-flex rounded-full px-2 py-0.5 text-[12px] font-semibold',
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
  const menuRef = useRef<HTMLDivElement>(null)
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
    setDeleteErr(null)
    setDeleting(true)
    try {
      await onDelete(event.draftId)
    } catch (e) {
      setDeleteErr(e instanceof Error ? e.message : 'Delete failed')
      setDeleting(false)
    }
  }

  return (
    <div className="group flex flex-col overflow-hidden rounded-xl border border-border bg-card shadow-sm transition-all hover:shadow-md hover:border-border-strong">
      {/* Banner */}
      <div className={cn('relative aspect-[16/6] overflow-hidden', GRADIENT)}>
        {event.bannerUrl ? (
          <img src={event.bannerUrl} alt="" className="h-full w-full object-cover" loading="lazy" />
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <span className="select-none text-4xl font-black text-primary/10">
              {event.name.charAt(0).toUpperCase()}
            </span>
          </div>
        )}
        <div className="absolute left-2.5 top-2.5 flex gap-1.5">
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
            'line-clamp-2 text-[15px] font-semibold transition-colors',
            isReadOnly ? 'text-muted-foreground' : 'text-foreground group-hover:text-primary',
          )}>
            {event.name}
          </h3>
          <div className="mt-1 flex items-center gap-1.5 text-[13px] text-muted-foreground">
            <Calendar className="size-[11px] shrink-0" aria-hidden />
            <span>{fmtDate(event.startDate)}</span>
          </div>
        </div>

        {/* Metrics */}
        <div className="space-y-2 rounded-lg border border-border/50 bg-muted/[0.04] p-3">
          <div>
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1 text-[13px] text-muted-foreground">
                <Users className="size-[11px]" />Registrations
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
            <span className="flex items-center gap-1 text-[13px] text-muted-foreground">
              <TrendingUp className="size-[11px]" />Revenue
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

      {/* Actions */}
      <div className="flex items-center gap-2 border-t border-border px-4 py-2.5">
        <Link
          href={`/dashboard/events/${event.draftId}`}
          className="flex-1 rounded-lg bg-primary px-3 py-1.5 text-center text-[14px] font-semibold text-white transition-colors hover:bg-[#bf1868]"
        >
          {isReadOnly ? 'View' : isDraft ? 'Continue Setup' : 'Manage'}
        </Link>

        {ls !== 'draft' && event.slug && (
          <Link
            href={`/events/${event.slug}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex h-[30px] w-[30px] items-center justify-center rounded-lg border border-border text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
            title="View public page"
          >
            <ExternalLink className="size-3.5" aria-hidden />
          </Link>
        )}

        {/* More dropdown */}
        <div ref={menuRef} className="relative">
          <button
            type="button"
            onClick={() => setMenuOpen(v => !v)}
            className="flex h-[30px] w-[30px] items-center justify-center rounded-lg border border-border text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
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
                className="flex w-full cursor-not-allowed items-center gap-2.5 px-3.5 py-2.5 text-left text-[12.5px] text-muted-foreground opacity-50"
              >
                <Copy className="size-3.5" /> Duplicate
                <span className="ml-auto text-[10px]">Go to Manage</span>
              </button>
              {!isReadOnly && (
                <button
                  type="button"
                  disabled
                  className="flex w-full cursor-not-allowed items-center gap-2.5 px-3.5 py-2.5 text-left text-[14px] text-muted-foreground opacity-50"
                >
                  <Archive className="size-3.5" /> Archive
                  <span className="ml-auto text-[10px]">Go to Manage</span>
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

function SkeletonCard() {
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="aspect-[16/6] animate-pulse bg-muted" />
      <div className="space-y-3 p-4">
        <div className="h-4 w-3/4 animate-pulse rounded bg-muted" />
        <div className="h-3 w-1/2 animate-pulse rounded bg-muted" />
        <div className="h-14 animate-pulse rounded-lg bg-muted" />
      </div>
      <div className="border-t border-border px-4 py-2.5">
        <div className="h-[30px] animate-pulse rounded-lg bg-muted" />
      </div>
    </div>
  )
}

// ─── Empty States ─────────────────────────────────────────────────────────────

const EMPTY: Record<TabKey, { icon: React.ElementType; title: string; desc: string; action?: boolean }> = {
  active:    { icon: TrendingUp,  title: 'No active events',    desc: 'Publish an event to start accepting registrations.' },
  published: { icon: TrendingUp,  title: 'No published events', desc: 'Published events with open registration appear here.' },
  drafts:    { icon: FileText,    title: 'No draft events',     desc: 'Events you\'re working on appear here.', action: true },
  archived:  { icon: Archive,     title: 'No archived events',  desc: 'Completed, cancelled, and archived events appear here.' },
}

function EmptyState({ tab }: { tab: TabKey }) {
  const { icon: Icon, title, desc, action } = EMPTY[tab]
  return (
    <div className="flex flex-col items-center justify-center gap-4 rounded-2xl border border-dashed border-border py-20 text-center">
      <div className="flex size-14 items-center justify-center rounded-full bg-muted">
        <Icon className="size-6 text-muted-foreground/60" aria-hidden />
      </div>
      <div>
        <p className="text-[15px] font-semibold text-foreground">{title}</p>
        <p className="mt-1 max-w-xs text-[13px] text-muted-foreground">{desc}</p>
      </div>
      {action && (
        <Link
          href="/dashboard/events/new/visibility"
          className="flex items-center gap-2 rounded-xl bg-primary px-5 py-2 text-[13px] font-semibold text-white hover:bg-[#bf1868]"
        >
          <Plus className="size-4" /> Create Event
        </Link>
      )}
    </div>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function EventsClient() {
  const [events,    setEvents]    = useState<EventListItem[]>([])
  const [loading,   setLoading]   = useState(true)
  const [error,     setError]     = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<TabKey>('active')
  const [search,    setSearch]    = useState('')

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async user => {
      if (!user) { setError('You must be signed in to view events.'); setLoading(false); return }
      try {
        const token = await user.getIdToken()
        const res   = await fetch('/api/organizer/events', {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const json  = await res.json() as EventsListResponse
        setEvents(json.events)

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
      const json = await res.json().catch(() => ({})) as { error?: string }
      throw new Error(json.error ?? `Delete failed (${res.status})`)
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

  if (!loading && error) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 p-6 text-center">
        <div className="flex size-12 items-center justify-center rounded-full bg-destructive/10">
          <AlertCircle className="size-6 text-destructive" />
        </div>
        <p className="text-[15px] font-semibold">{error}</p>
      </div>
    )
  }

  return (
    <div className="space-y-6 p-5 sm:p-6">
      {/* Page header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-[32px] font-bold text-foreground">Events</h1>
          <p className="mt-0.5 text-[14px] text-muted-foreground">Create, manage, and grow your events</p>
        </div>
        <Link
          href="/dashboard/events/new/visibility"
          className="flex w-fit items-center gap-2 rounded-xl bg-primary px-4 py-2 text-[14px] font-semibold text-white hover:bg-[#bf1868]"
        >
          <Plus className="size-4" /> Create Event
        </Link>
      </div>

      {/* Search + summary row */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        {/* Search input */}
        <div className="relative w-full sm:max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <input
            type="search"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search events…"
            aria-label="Search events by name"
            className="h-9 w-full rounded-lg border border-border bg-card pl-8 pr-8 text-[14px] text-foreground placeholder:text-muted-foreground focus:border-primary/40 focus:outline-none focus:ring-2 focus:ring-primary/25"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch('')}
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

      {/* Tabs */}
      <div className="border-b border-border">
        <nav className="-mb-px flex gap-0" role="tablist">
          {TABS.map(t => {
            const count  = buckets.get(t.key)?.length ?? 0
            const active = activeTab === t.key
            return (
              <button
                key={t.key}
                role="tab"
                aria-selected={active}
                onClick={() => setActiveTab(t.key)}
                className={cn(
                  'flex items-center gap-2 border-b-2 px-4 py-3 text-[14px] font-medium transition-colors',
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
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => <SkeletonCard key={i} />)}
        </div>
      ) : visible.length === 0 && q ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-border py-16 text-center">
          <Search className="size-8 text-muted-foreground/40" />
          <p className="text-[14px] font-medium text-foreground">No events match &ldquo;{search}&rdquo;</p>
          <button
            type="button"
            onClick={() => setSearch('')}
            className="text-[13px] text-primary hover:underline underline-offset-4"
          >
            Clear search
          </button>
        </div>
      ) : visible.length === 0 ? (
        <EmptyState tab={activeTab} />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {visible.map(e => (
            <EventCard
              key={e.draftId}
              event={e}
              onDelete={e.lifecycleStatus === 'draft' ? handleDeleteDraft : undefined}
            />
          ))}
        </div>
      )}
    </div>
  )
}
