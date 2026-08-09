'use client'

// RD-MEDIA-03 · The workspace's event switcher.
//
// ONE control, at the top of every Media Studio page, replacing the four separate event
// pickers that used to sit inside Import, Galleries, Albums and Storage. Choosing here
// changes the whole workspace; nothing below ever asks again.
//
// Built from the existing design system — Card, Button, token variables. No new colour,
// radius or size, and no new navigation: this switches context, it does not route.

import { useEffect, useId, useRef, useState } from 'react'
import Link from 'next/link'
import { CalendarDays, Check, ChevronDown, Lock } from 'lucide-react'
import { Button, EmptyState, Skeleton } from '@/components/ui'
import { cn } from '@/lib/utils/cn'
import { useMediaStudio } from '@/features/media-studio/context/MediaStudioContext'
import type { MediaEventRow } from '@/features/media-studio/hooks/useMediaEvents'

export interface EventContextBarProps {
  /**
   * RD-MEDIA-IMPORT-05A · Tighter padding, no "Current event" overline.
   *
   * For hosts that already label the section. Default false, so every existing caller
   * renders exactly as before.
   */
  dense?: boolean
  /**
   * Locks the event and explains why.
   *
   * Set when a page was reached FROM Import Media: the organizer is mid-upload, and letting
   * them switch event from a screen they were sent to for one specific job is how the
   * upload target silently changes underneath them.
   */
  locked?: boolean
  /** Shown beside the lock — where to go back to. */
  backHref?:  string
  backLabel?: string
}

export function EventContextBar({
  locked = false, backHref, backLabel, dense = false,
}: EventContextBarProps) {
  const { events, loading, error, event, setEvent } = useMediaStudio()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const listId  = useId()

  // Close on an outside click or Escape — the two things every menu must do.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  if (loading) return <Skeleton className={cn('w-full rounded-xl', dense ? 'h-[42px]' : 'h-[58px]')} />

  if (error) {
    return (
      <div className="rounded-xl border border-destructive/40 bg-destructive/[0.04] px-4 py-3">
        <p className="text-fs-sm text-foreground">{error}</p>
      </div>
    )
  }

  if (events.length === 0) {
    return (
      <EmptyState
        icon={CalendarDays}
        title="No published events"
        description="Publish an event before importing media — photos are stored under its public URL."
        action={{ label: 'Go to events', href: '/dashboard/events' }}
      />
    )
  }

  const choose = (next: MediaEventRow) => { setEvent(next); setOpen(false) }

  return (
    <div
      ref={rootRef}
      className={cn(
        'relative flex flex-wrap items-center rounded-xl border border-border bg-card',
        dense ? 'gap-2 px-3 py-1.5' : 'gap-3 px-4 py-3',
      )}
    >
      {/* The overline is redundant when the host Panel is already labelled. */}
      {!dense && (
        <span className="text-fs-2xs font-semibold uppercase tracking-wide text-muted-foreground">
          Current event
        </span>
      )}

      {locked ? (
        <>
          <span className="inline-flex items-center gap-1.5 text-fs-md font-semibold text-foreground">
            <Lock className="size-3.5 text-muted-foreground" aria-hidden />
            {event?.name ?? 'No event selected'}
          </span>
          <span className="text-fs-2xs text-muted-foreground">
            Locked to the event you are uploading to.
          </span>
          {backHref && (
            <Link
              href={backHref}
              className="ml-auto text-fs-base font-semibold text-primary transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              {backLabel ?? 'Back'}
            </Link>
          )}
        </>
      ) : (
        <>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setOpen(v => !v)}
            aria-expanded={open}
            aria-haspopup="listbox"
            aria-controls={open ? listId : undefined}
          >
            {event?.name ?? 'Choose an event'}
            <ChevronDown className={cn('size-4 transition-transform', open && 'rotate-180')} aria-hidden />
          </Button>

          {!event && (
            <span className="text-fs-2xs text-muted-foreground">
              Media Studio works inside one event at a time.
            </span>
          )}

          {open && (
            <ul
              id={listId}
              role="listbox"
              aria-label="Choose an event"
              className="absolute left-4 top-[calc(100%-0.25rem)] z-20 max-h-[320px] w-[min(420px,calc(100%-2rem))] overflow-y-auto rounded-xl border border-border bg-card p-1.5 shadow-lg"
            >
              {events.map(e => {
                const selected = e.eventId === event?.eventId
                return (
                  <li key={e.eventId} role="option" aria-selected={selected}>
                    <button
                      type="button"
                      onClick={() => choose(e)}
                      className={cn(
                        'flex w-full items-start gap-2 rounded-lg px-3 py-2 text-left transition-colors',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                        selected ? 'bg-primary/[0.06]' : 'hover:bg-muted/60',
                      )}
                    >
                      <Check
                        className={cn('mt-0.5 size-3.5 shrink-0', selected ? 'text-primary' : 'opacity-0')}
                        aria-hidden
                      />
                      <span className="min-w-0">
                        <span className="block truncate text-fs-base font-semibold text-foreground">{e.name}</span>
                        <span className="block text-fs-2xs text-muted-foreground">
                          {e.startDate ?? 'Date not set'}
                        </span>
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </>
      )}
    </div>
  )
}
