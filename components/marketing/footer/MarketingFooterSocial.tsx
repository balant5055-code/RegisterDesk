// Phase P.1.5 — Footer social icons. Server Component.
//
// Registry-driven. Renders NOTHING when no official profiles are configured —
// links are never invented.

import Link from 'next/link'
import { cn } from '@/lib/utils/cn'
import { MARKETING_ICONS } from '@/lib/marketing/icons'
import type { SocialLink } from '@/lib/marketing/types'

export function MarketingFooterSocial({ items, className }: { items: SocialLink[]; className?: string }) {
  if (items.length === 0) return null
  return (
    <ul className={cn('flex items-center gap-2', className ?? 'mt-4')} aria-label="Social media">
      {items.map(s => {
        const Icon = MARKETING_ICONS[s.iconKey]
        return (
          <li key={s.id}>
            <Link
              href={s.href} target="_blank" rel="noopener noreferrer" aria-label={s.label}
              className="flex size-9 items-center justify-center rounded-lg border border-border/60 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              <Icon className="size-4" aria-hidden />
            </Link>
          </li>
        )
      })}
    </ul>
  )
}
