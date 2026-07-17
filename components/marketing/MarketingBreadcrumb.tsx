'use client'

// Shared public-marketing breadcrumb — ONE implementation used by every public
// sub-page (via the shared hero / legal layout). Route-derived: no per-page data.
// Home is always a link; the current page is aria-current; intermediate crumbs
// link only when they resolve to a real index page (never a 404). Renders nothing
// at the site root.

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils/cn'

// Human labels for known segments (else the segment is title-cased).
const LABELS: Record<string, string> = {
  platform:        'Platform',
  solutions:       'Solutions',
  pricing:         'Pricing',
  about:           'About',
  security:        'Security',
  contact:         'Contact',
  resources:       'Resources',
  events:          'Events',
  causes:          'Causes',
  privacy:         'Privacy Policy',
  terms:           'Terms of Service',
  'refund-policy': 'Refund Policy',
}

// Intermediate crumbs are links only for paths that are real index pages.
const LINKABLE = new Set(['/platform', '/pricing', '/about', '/security', '/contact', '/resources', '/events', '/causes'])

const LINK_CLASS = 'transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded'

function titleCase(segment: string): string {
  return segment.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

export function MarketingBreadcrumb({ className }: { className?: string }) {
  const pathname = usePathname() ?? '/'
  if (pathname === '/') return null

  const segments = pathname.split('/').filter(Boolean)
  const crumbs = segments.map((seg, i) => ({
    label: LABELS[seg] ?? titleCase(seg),
    path:  '/' + segments.slice(0, i + 1).join('/'),
    last:  i === segments.length - 1,
  }))

  return (
    <nav aria-label="Breadcrumb" className={cn('flex', className)}>
      <ol className="flex flex-wrap items-center gap-1.5 text-fs-xs text-muted-foreground">
        <li>
          <Link href="/" className={LINK_CLASS}>Home</Link>
        </li>
        {crumbs.map(c => (
          <li key={c.path} className="flex items-center gap-1.5">
            <ChevronRight className="size-3 text-muted-foreground/40" aria-hidden />
            {c.last ? (
              <span className="font-medium text-foreground" aria-current="page">{c.label}</span>
            ) : LINKABLE.has(c.path) ? (
              <Link href={c.path} className={LINK_CLASS}>{c.label}</Link>
            ) : (
              <span>{c.label}</span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  )
}
