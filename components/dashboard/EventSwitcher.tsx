'use client'

// Phase H.2.1 — Event Switcher.
//
// Lets an organizer jump between events without leaving the workspace. It is a
// PRESENTATION control over a list of events the caller already has — it performs
// NO data fetching of its own (the dashboard passes the events it already loaded
// from /api/organizer/dashboard, so there are no extra reads and no duplicated
// queries). Selecting an event deep-links into its event workspace.

import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { CalendarDays, Check, ChevronsUpDown, Search } from 'lucide-react'
import { cn } from '@/lib/utils/cn'

export interface SwitchableEvent {
  draftId:         string
  name:            string
  lifecycleStatus: string
}

const STATUS_DOT: Record<string, string> = {
  published:            'bg-emerald-500',
  registration_closed:  'bg-amber-500',
  completed:            'bg-slate-400',
  draft:                'bg-slate-300',
}

export interface EventSwitcherProps {
  events:          SwitchableEvent[]
  currentEventId?: string
  className?:      string
}

function EventSwitcherImpl({ events, currentEventId, className }: EventSwitcherProps) {
  const router = useRouter()
  const ref    = useRef<HTMLDivElement>(null)
  const [open, setOpen]   = useState(false)
  const [query, setQuery] = useState('')

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    const onKey  = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open])

  const current = useMemo(
    () => events.find(e => e.draftId === currentEventId) ?? null,
    [events, currentEventId],
  )

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? events.filter(e => e.name.toLowerCase().includes(q)) : events
  }, [events, query])

  function select(id: string) {
    setOpen(false)
    setQuery('')
    router.push(`/dashboard/events/${id}`)
  }

  if (events.length === 0) return null

  return (
    <div ref={ref} className={cn('relative', className)}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex h-9 w-full items-center gap-2 rounded-xl border border-border bg-card px-3 text-left text-[14px] font-medium text-foreground transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary sm:w-56"
      >
        <CalendarDays className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1 truncate">{current ? current.name : 'All events'}</span>
        <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground/60" aria-hidden />
      </button>

      {open && (
        <div
          role="listbox"
          aria-label="Switch event"
          className="absolute left-0 top-full z-50 mt-1.5 w-[min(20rem,80vw)] overflow-hidden rounded-xl border border-border bg-card shadow-lg"
        >
          <div className="flex items-center gap-2 border-b border-border px-3 py-2">
            <Search className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <input
              autoFocus
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search events…"
              aria-label="Search events"
              className="h-6 w-full bg-transparent text-[14px] text-foreground placeholder:text-muted-foreground focus:outline-none"
            />
          </div>
          <ul className="max-h-72 overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <li className="px-3 py-3 text-[13px] text-muted-foreground">No events match “{query}”.</li>
            ) : filtered.map(ev => {
              const active = ev.draftId === currentEventId
              return (
                <li key={ev.draftId} role="option" aria-selected={active}>
                  <button
                    type="button"
                    onClick={() => select(ev.draftId)}
                    className={cn(
                      'flex w-full items-center gap-2.5 px-3 py-2 text-left text-[14px] transition-colors hover:bg-muted/50',
                      active ? 'font-semibold text-foreground' : 'text-muted-foreground',
                    )}
                  >
                    <span className={cn('size-1.5 shrink-0 rounded-full', STATUS_DOT[ev.lifecycleStatus] ?? 'bg-slate-300')} aria-hidden />
                    <span className="min-w-0 flex-1 truncate">{ev.name}</span>
                    {active && <Check className="size-3.5 shrink-0 text-primary" aria-hidden />}
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </div>
  )
}

export const EventSwitcher = memo(EventSwitcherImpl)
