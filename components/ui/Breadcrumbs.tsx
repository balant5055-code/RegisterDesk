import Link from 'next/link'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils/cn'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface BreadcrumbItem {
  /** Display text */
  label: string
  /** If omitted the item renders as plain text (current page) */
  href?: string
}

export interface BreadcrumbsProps {
  items: BreadcrumbItem[]
  className?: string
}

// ─── Component ────────────────────────────────────────────────────────────────

/** A crumb longer than this may shrink and truncate; shorter crumbs never do. */
const LONG_CRUMB = 20

/**
 * Global breadcrumb component — design-system compliant, accessible, responsive.
 * Renders as a semantic <nav> / <ol> with chevron separators.
 * Last item is always rendered as plain text with aria-current="page".
 */
export function Breadcrumbs({ items, className }: BreadcrumbsProps) {
  if (!items.length) return null

  return (
    // 2026-09-27 (owner, phone): the trail is ONE line. It used to wrap, and because every
    // crumb was nowrap a long event name pushed each crumb onto its own row. Now short
    // crumbs keep their width and only a LONG crumb gives way, truncating with an ellipsis
    // (full text stays in `title`).
    <nav aria-label="Breadcrumb" className={cn('min-w-0', className)}>
      <ol className="flex min-w-0 flex-nowrap items-center gap-x-0.5">
        {items.map((item, i) => {
          const isLast = i === items.length - 1
          const long = item.label.length > LONG_CRUMB
          return (
            <li key={i} className={cn('flex items-center gap-x-0.5', long ? 'min-w-0 shrink' : 'shrink-0')}>

              {/* Separator */}
              {i > 0 && (
                <ChevronRight
                  className="mx-0.5 size-3 shrink-0 text-border-strong"
                  aria-hidden
                />
              )}

              {/* Linked crumb */}
              {item.href && !isLast ? (
                <Link
                  href={item.href}
                  title={long ? item.label : undefined}
                  className="min-w-0 truncate text-fs-sm text-muted-foreground transition-colors duration-150 hover:text-foreground"
                >
                  {item.label}
                </Link>
              ) : (
                /* Current page or last non-linked item */
                <span
                  aria-current={isLast ? 'page' : undefined}
                  title={long ? item.label : undefined}
                  className={cn(
                    'min-w-0 truncate text-fs-sm',
                    isLast
                      ? 'max-w-[200px] font-semibold text-foreground sm:max-w-[340px] lg:max-w-[480px]'
                      : 'text-muted-foreground',
                  )}
                >
                  {item.label}
                </span>
              )}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
