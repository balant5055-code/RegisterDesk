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

/**
 * Global breadcrumb component — design-system compliant, accessible, responsive.
 * Renders as a semantic <nav> / <ol> with chevron separators.
 * Last item is always rendered as plain text with aria-current="page".
 */
export function Breadcrumbs({ items, className }: BreadcrumbsProps) {
  if (!items.length) return null

  return (
    <nav aria-label="Breadcrumb" className={cn('min-w-0', className)}>
      <ol className="flex flex-wrap items-center gap-x-0.5 gap-y-1">
        {items.map((item, i) => {
          const isLast = i === items.length - 1
          return (
            <li key={i} className="flex min-w-0 items-center gap-x-0.5">

              {/* Separator */}
              {i > 0 && (
                <ChevronRight
                  className="mx-0.5 size-3 shrink-0 text-gray-300"
                  aria-hidden
                />
              )}

              {/* Linked crumb */}
              {item.href && !isLast ? (
                <Link
                  href={item.href}
                  className="whitespace-nowrap text-[13px] text-gray-400 transition-colors duration-150 hover:text-gray-700"
                >
                  {item.label}
                </Link>
              ) : (
                /* Current page or last non-linked item */
                <span
                  aria-current={isLast ? 'page' : undefined}
                  className={cn(
                    'text-[13px]',
                    isLast
                      ? 'max-w-[200px] truncate font-semibold text-gray-800 sm:max-w-[340px] lg:max-w-[480px]'
                      : 'whitespace-nowrap text-gray-400',
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
