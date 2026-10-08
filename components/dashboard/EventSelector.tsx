'use client'

// RD-ORG-FOUNDATION · Event Selector — the primary context control.
//
// Reads EventContext and nothing else. It performs NO fetching of its own: the
// summaries it renders (name, status, date, registration count) are already in the
// context from the single /api/organizer/events call the shell makes. Opening the
// selector costs zero Firestore reads, which is the point — a control the organizer
// opens dozens of times a day must not be a per-open query.

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { Calendar, Check, ChevronsUpDown, Layers, ListFilter, Plus, Search } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { useEventContext } from '@/components/dashboard/EventContextProvider'
import { presentEventStatus, ALL_EVENTS_SELECTION, type EventStatusPresentation, type EventSummary } from '@/lib/events/eventContext'
import { ALL_EVENTS_HREF, CREATE_EVENT_HREF } from '@/config/workspaceNav'

// Status tone → token classes. One mapping, used by the trigger and every row, so a
// status can never be drawn two ways in the same menu.
const TONE_DOT: Record<EventStatusPresentation['tone'], string> = {
  live:     'bg-emerald-500',
  upcoming: 'bg-sky-500',
  draft:    'bg-slate-400',
  closed:   'bg-amber-500',
  done:     'bg-slate-400',
  stopped:  'bg-rose-400',
}

function formatDate(iso: string | null): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
}

function EventRow({ event, selected, onSelect, now }: {
  event: EventSummary; selected: boolean; onSelect: () => void; now: number
}) {
  const status = presentEventStatus(event, now)
  const date   = formatDate(event.startDate)

  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={onSelect}
      className={cn(
        'flex w-full items-start gap-2.5 rounded-control px-2.5 py-2 text-left transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
        selected ? 'bg-muted' : 'hover:bg-muted/60',
      )}
    >
      <span className={cn('mt-1.5 size-1.5 shrink-0 rounded-pill', TONE_DOT[status.tone])} aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-fs-sm font-medium text-foreground">{event.name}</span>
        <span className="mt-0.5 flex items-center gap-1.5 text-fs-2xs text-muted-foreground">
          <span>{status.label}</span>
          {date && <><span aria-hidden>·</span><span>{date}</span></>}
          {event.totalRegistrations > 0 && (
            <><span aria-hidden>·</span>
              <span>{event.totalRegistrations.toLocaleString('en-IN')} registered</span></>
          )}
        </span>
      </span>
      {selected && <Check className="mt-0.5 size-3.5 shrink-0 text-primary" aria-hidden />}
    </button>
  )
}

export function EventSelector({ className }: { className?: string }) {
  const { events, selectedEvent, selectedEventId, isAllEvents, selectEvent, loading, now } = useEventContext()
  const [open, setOpen]   = useState(false)
  const [query, setQuery] = useState('')
  const ref      = useRef<HTMLDivElement>(null)
  const searchEl = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    const onKey  = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); setQuery('') } }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    // Focus search on open so the keyboard path is type-then-Enter, not tab-tab-tab.
    const t = window.setTimeout(() => searchEl.current?.focus(), 0)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      window.clearTimeout(t)
    }
  }, [open])

  // Client-side filtering over an at-most-100 in-memory list. Not a server search,
  // and deliberately so — a keystroke here must never become a Firestore query.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return events
    return events.filter(e => e.name.toLowerCase().includes(q))
  }, [events, query])

  // "All events" is a SCOPE, not an event, so it is searchable by its own words rather
  // than living in the event list. Hidden while a search excludes it, so the filtered
  // list never claims a match it does not have.
  const showAllOption = useMemo(() => {
    const q = query.trim().toLowerCase()
    return !q || 'all events'.includes(q)
  }, [query])

  const status = selectedEvent ? presentEventStatus(selectedEvent, now) : null

  return (
    <div ref={ref} className={cn('relative', className)}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={isAllEvents
          ? 'Scope: All events. Change event.'
          : selectedEvent ? `Selected event: ${selectedEvent.name}. Change event.` : 'Select an event'}
        disabled={loading && events.length === 0}
        className={cn(
          'group flex h-9 min-w-0 items-center gap-2 rounded-control border border-border bg-background px-2.5',
          'text-left transition-colors hover:bg-muted/50 disabled:opacity-60',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
          // RD-COMMS-P2-F mobile QA — below sm the top bar's other controls (menu, search, theme,
          // bell, profile) need ~15.75rem; a fixed 45vw pushed the bell and the profile menu off a
          // 320–412px screen. The selector now takes what is left (it still truncates the name and
          // opens the full list). Unchanged from sm up.
          'w-[min(15rem,calc(100vw-15.75rem))] sm:w-64',
        )}
      >
        {/* The glyph distinguishes the two kinds of scope at a glance: a workspace icon
            for All events, a status dot for one event. */}
        {isAllEvents
          ? <Layers className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          : status
            ? <span className={cn('size-1.5 shrink-0 rounded-pill', TONE_DOT[status.tone])} aria-hidden />
            : <Calendar className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />}
        <span className="min-w-0 flex-1 truncate text-fs-sm font-medium text-foreground">
          {loading && events.length === 0
            ? 'Loading events…'
            : isAllEvents
              ? 'All events'
              : selectedEvent?.name ?? (events.length === 0 ? 'No events yet' : 'Select an event')}
        </span>
        <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground/70" aria-hidden />
      </button>

      {open && (
        <div
          role="listbox"
          aria-label="Events"
          className={cn(
            'absolute left-0 z-50 mt-1.5 w-[min(22rem,calc(100vw-2rem))] overflow-hidden',
            'rounded-surface border border-border bg-card shadow-lg',
          )}
        >
          <div className="flex items-center gap-2 border-b border-border px-2.5 py-2">
            <Search className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <input
              ref={searchEl}
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search events"
              aria-label="Search events"
              className="min-w-0 flex-1 bg-transparent text-fs-sm text-foreground outline-none placeholder:text-muted-foreground"
            />
          </div>

          <div className="max-h-[min(22rem,50vh)] overflow-y-auto p-1.5">
            {/* ═══ ALL EVENTS ═══════════════════════════════════════════════════
                A SCOPE, not an event — so it sits above the list with a divider rather
                than pretending to be the first row of it. Without this the workspace-wide
                Dashboard mode had no way to be reached from the UI at all. */}
            {showAllOption && (
              <>
                <button
                  type="button"
                  role="option"
                  aria-selected={isAllEvents}
                  onClick={() => { selectEvent(ALL_EVENTS_SELECTION); setOpen(false); setQuery('') }}
                  className={cn(
                    'flex w-full items-start gap-2.5 rounded-control px-2.5 py-2 text-left transition-colors',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
                    isAllEvents ? 'bg-muted' : 'hover:bg-muted/60',
                  )}
                >
                  <Layers className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-fs-sm font-medium text-foreground">All events</span>
                    <span className="mt-0.5 block truncate text-fs-2xs text-muted-foreground">
                      {events.length > 0
                        ? `Workspace totals across ${events.length.toLocaleString('en-IN')} event${events.length === 1 ? '' : 's'}`
                        : 'Workspace totals'}
                    </span>
                  </span>
                  {isAllEvents && <Check className="mt-0.5 size-3.5 shrink-0 text-primary" aria-hidden />}
                </button>
                {filtered.length > 0 && <div className="my-1.5 h-px bg-border" role="presentation" />}
              </>
            )}
            {filtered.length === 0 ? (
              // Still rendered when "All events" matched the query — otherwise a search for
              // "all" would leave the event list silently absent rather than explained.
              <p className={cn('px-2.5 text-center text-fs-xs text-muted-foreground', showAllOption ? 'py-3' : 'py-6')}>
                {events.length === 0 ? 'You have not created an event yet.' : 'No events match that search.'}
              </p>
            ) : (
              <div className="space-y-0.5">
                {filtered.map(e => (
                  <EventRow
                    key={e.draftId}
                    event={e}
                    selected={e.draftId === selectedEventId}
                    onSelect={() => { selectEvent(e.draftId); setOpen(false); setQuery('') }}
                    now={now}
                  />
                ))}
              </div>
            )}
          </div>

          <div className="flex items-center gap-1 border-t border-border p-1.5">
            <Link
              href={CREATE_EVENT_HREF}
              onClick={() => setOpen(false)}
              className="flex flex-1 items-center gap-1.5 rounded-control px-2.5 py-1.5 text-fs-xs font-medium text-foreground transition-colors hover:bg-muted"
            >
              <Plus className="size-3.5" aria-hidden /> Create event
            </Link>
            <Link
              href={ALL_EVENTS_HREF}
              onClick={() => setOpen(false)}
              className="flex flex-1 items-center gap-1.5 rounded-control px-2.5 py-1.5 text-fs-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <ListFilter className="size-3.5" aria-hidden /> View all events
            </Link>
          </div>
        </div>
      )}
    </div>
  )
}
