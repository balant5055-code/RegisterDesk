'use client'

// RD-ORG-FOUNDATION · Empty / error / no-event states — one component, three kinds.
//
// ═══ WHY ONE COMPONENT ═══════════════════════════════════════════════════════
// The portal had `components/ui/EmptyState` and `components/dashboard/EmptyState`,
// each exporting BOTH an `EmptyState` and an `ErrorState` with same-named but
// differently-shaped prop interfaces. Two implementations of the same idea, and a
// blind merge would silently change call-site behaviour — so neither was ever
// merged, and new pages picked whichever they happened to import.
//
// StateBlock does not merge them. It is the state primitive the FOUNDATION uses, so
// the shell has one answer; the two legacy components stay untouched for the pages
// already on them, and each page migrates during its own module phase.
//
// ═══ THE 'no-event' KIND ═════════════════════════════════════════════════════
// New to this phase, and load-bearing. Every event-scoped module can now be reached
// with no event selected (fresh account, or an organizer who deleted their last
// event). Without a defined state for that, a module either renders an empty table —
// which reads as "no registrations" rather than "no event chosen" — or shows
// workspace-wide data under an event heading. Both are lies. This is the third state.

import Link from 'next/link'
import { AlertCircle, CalendarPlus, Inbox } from 'lucide-react'
import { cn } from '@/lib/utils/cn'

export type StateKind = 'empty' | 'error' | 'no-event'

export interface StateAction {
  label:    string
  href?:    string
  onClick?: () => void
}

export interface StateBlockProps {
  kind:         StateKind
  title:        string
  description?: string
  action?:      StateAction
  className?:   string
}

const ICON: Record<StateKind, React.ElementType> = {
  empty:      Inbox,
  error:      AlertCircle,
  'no-event': CalendarPlus,
}

const ICON_TONE: Record<StateKind, string> = {
  empty:      'bg-muted text-muted-foreground',
  error:      'bg-destructive/10 text-destructive',
  'no-event': 'bg-primary/10 text-primary',
}

export function StateBlock({ kind, title, description, action, className }: StateBlockProps) {
  const Icon = ICON[kind]

  const actionClasses = cn(
    'inline-flex h-9 items-center rounded-control px-3.5 text-fs-sm font-medium transition-colors',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
    kind === 'error'
      ? 'border border-border text-foreground hover:bg-muted'
      : 'bg-primary text-primary-foreground hover:bg-primary-hover',
  )

  return (
    <div
      role={kind === 'error' ? 'alert' : undefined}
      className={cn(
        'flex flex-col items-center justify-center rounded-surface border border-border bg-card px-6 py-12 text-center',
        className,
      )}
    >
      <span className={cn('flex size-10 items-center justify-center rounded-control', ICON_TONE[kind])} aria-hidden>
        <Icon className="size-5" />
      </span>

      <h2 className="mt-3 text-fs-md font-semibold text-foreground">{title}</h2>

      {description && (
        <p className="mt-1.5 max-w-md text-fs-sm text-muted-foreground">{description}</p>
      )}

      {action && (
        <div className="mt-5">
          {action.href ? (
            <Link href={action.href} className={actionClasses}>{action.label}</Link>
          ) : (
            <button type="button" onClick={action.onClick} className={actionClasses}>{action.label}</button>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * The canonical "pick an event first" state.
 *
 * Every event-scoped module renders this when nothing is selected, so the message is
 * identical across the portal instead of each module inventing its own wording for
 * the same condition.
 */
export function NoEventSelected({ moduleName }: { moduleName: string }) {
  return (
    <StateBlock
      kind="no-event"
      title="Select an event"
      description={`${moduleName} works on one event at a time. Choose an event from the selector at the top of the page, or create your first one.`}
      action={{ label: 'View all events', href: '/dashboard/events' }}
    />
  )
}
