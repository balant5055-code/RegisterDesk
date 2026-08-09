'use client'

// RD-MEDIA-UX-01 · The Import workspace bar.
//
// One row that answers "where am I uploading to?" — the question the old page answered three
// separate times (an Event section, a Gallery section, and again in Review).
//
// PRESENTATION ONLY. It selects nothing and fetches nothing; it renders what the workspace
// already knows and links to the panels that own each choice.

import { Calendar, ChevronRight, FolderOpen, Layers } from 'lucide-react'
import { Skeleton } from '@/components/ui'
import { cn } from '@/lib/utils/cn'

export interface ImportWorkspaceBarProps {
  eventName:   string | null
  galleryName: string | null
  albumName:   string | null
  loading?:    boolean
  /** Scrolls nothing — moves focus to the Destination panel. */
  onChange?:   () => void
}

export function ImportWorkspaceBar({
  eventName, galleryName, albumName, loading, onChange,
}: ImportWorkspaceBarProps) {
  if (loading) return <Skeleton className="h-11 w-full rounded-xl" />

  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-x-1.5 gap-y-1 rounded-xl border border-border',
        'bg-card px-3 py-2',
      )}
    >
      <Crumb icon={Calendar} value={eventName} fallback="No event selected" strong />
      <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/50" aria-hidden />
      <Crumb icon={FolderOpen} value={galleryName} fallback="No gallery" />
      <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/50" aria-hidden />
      <Crumb icon={Layers} value={albumName} fallback="No album" />

      {onChange && (
        <button
          type="button"
          onClick={onChange}
          className={cn(
            'ml-auto shrink-0 rounded-md px-2 py-0.5 text-fs-sm font-semibold text-primary',
            'transition-opacity hover:opacity-80',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
          )}
        >
          Change
        </button>
      )}
    </div>
  )
}

/**
 * One crumb. `min-w-0` + `truncate` on the label is what keeps the bar to a single row on
 * desktop no matter how long an event is named.
 */
function Crumb({
  icon: Icon, value, fallback, strong,
}: {
  icon: typeof Calendar
  value: string | null
  fallback: string
  strong?: boolean
}) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <span
        className={cn(
          'truncate text-fs-sm',
          value
            ? strong ? 'font-semibold text-foreground' : 'text-foreground'
            : 'text-muted-foreground',
        )}
      >
        {value ?? fallback}
      </span>
    </span>
  )
}
