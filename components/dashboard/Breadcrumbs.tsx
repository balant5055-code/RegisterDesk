'use client'

// RD-ORG-FOUNDATION · Breadcrumb trail.
//
// Thin presentation over the pure resolver in lib/navigation/breadcrumbs.ts. All
// route/label logic lives there so it is testable without a DOM; this file only
// decides how a resolved trail looks and how it collapses on small screens.

import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { useEventContext } from '@/components/dashboard/EventContextProvider'
import { buildBreadcrumbs, leafLabelFor } from '@/lib/navigation/breadcrumbs'

export function Breadcrumbs({ className }: { className?: string }) {
  const pathname     = usePathname()
  const searchParams = useSearchParams()
  const { selectedEventId, selectedEvent } = useEventContext()

  const crumbs = buildBreadcrumbs({
    pathname,
    tab:       searchParams.get('tab'),
    selectedEventId,
    // The NAME, never the id. A null name yields a shorter trail rather than a
    // raw Firestore id — see the resolver's header.
    eventName: selectedEvent?.name ?? null,
    leafLabel: leafLabelFor(pathname),
  })

  if (crumbs.length === 0) return null
  const last = crumbs.length - 1

  return (
    <nav aria-label="Breadcrumb" className={cn('flex min-w-0 items-center', className)}>
      <ol className="flex min-w-0 items-center gap-1">
        {crumbs.map((crumb, i) => {
          const isLast = i === last
          return (
            <li key={`${crumb.label}-${i}`} className={cn('flex min-w-0 items-center gap-1', !isLast && 'shrink-0')}>
              {i > 0 && (
                <ChevronRight className="size-3 shrink-0 text-muted-foreground/40" aria-hidden />
              )}
              {isLast ? (
                // The current location. Truncates rather than wraps: event names run
                // long and a wrapping trail pushes the page content down on mobile.
                <span
                  className="min-w-0 truncate text-fs-sm font-semibold text-foreground"
                  aria-current="page"
                  title={crumb.label}
                >
                  {crumb.label}
                </span>
              ) : crumb.href ? (
                <Link
                  href={crumb.href}
                  className={cn(
                    'shrink-0 rounded-control px-0.5 text-fs-sm text-muted-foreground transition-colors',
                    'hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
                    // Intermediate crumbs collapse away before the current page does:
                    // on a phone the answer to "where am I?" matters more than the path.
                    i < last - 1 && 'hidden sm:inline-block',
                  )}
                >
                  {crumb.label}
                </Link>
              ) : (
                <span className={cn(
                  'shrink-0 text-fs-sm text-muted-foreground',
                  i < last - 1 && 'hidden sm:inline-block',
                )}>
                  {crumb.label}
                </span>
              )}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
