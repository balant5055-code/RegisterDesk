'use client'

// Phase H.4.2 — Reusable widget shell with the five canonical states:
// loading · empty · unknown · ready · error.
//
// Page-agnostic: any page composes widgets by passing a state + content. Wraps
// the existing DashboardCard (one visual language) and the existing
// EmptyState/ErrorState/Skeleton primitives — no duplicate UI.

import { memo } from 'react'
import type { LucideIcon } from 'lucide-react'
import { HelpCircle } from 'lucide-react'
import { DashboardCard } from './DashboardCard'
import { EmptyState, ErrorState } from './EmptyState'
import { Skeleton } from './Skeleton'
import { cn } from '@/lib/utils/cn'

export type WidgetState = 'loading' | 'empty' | 'unknown' | 'ready' | 'error'

export interface WidgetProps {
  title:        string
  state:        WidgetState
  children?:    React.ReactNode
  viewHref?:    string
  viewLabel?:   string
  action?:      React.ReactNode
  // Empty
  emptyIcon?:   LucideIcon
  emptyTitle?:  string
  emptyText?:   string
  // Unknown
  unknownText?: string
  // Error
  errorText?:   string
  onRetry?:     () => void
  className?:   string
  /** Rows for the loading skeleton. */
  skeletonRows?: number
}

function WidgetImpl({
  title, state, children, viewHref, viewLabel, action,
  emptyIcon = HelpCircle, emptyTitle = 'Nothing here yet', emptyText = 'No data to show.',
  unknownText = 'This information is not available yet.',
  errorText = 'Could not load this widget.', onRetry,
  className, skeletonRows = 3,
}: WidgetProps) {
  return (
    <DashboardCard title={title} viewHref={state === 'ready' ? viewHref : undefined} viewLabel={viewLabel}
      action={state === 'ready' ? action : undefined} className={className}>
      {state === 'loading' && (
        <div className="space-y-2 p-4" aria-busy="true">
          {Array.from({ length: skeletonRows }).map((_, i) => <Skeleton key={i} className="h-10 w-full rounded-xl" />)}
        </div>
      )}
      {state === 'empty' && <EmptyState icon={emptyIcon} title={emptyTitle} description={emptyText} />}
      {state === 'unknown' && (
        <div className="flex items-center gap-2 px-5 py-6 text-[13px] text-muted-foreground" role="status">
          <HelpCircle className="size-4 shrink-0 text-muted-foreground/60" aria-hidden />
          {unknownText}
        </div>
      )}
      {state === 'error' && <ErrorState message={errorText} onRetry={onRetry} />}
      {state === 'ready' && <div className={cn(className && 'contents')}>{children}</div>}
    </DashboardCard>
  )
}

export const Widget = memo(WidgetImpl)
