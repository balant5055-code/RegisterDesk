'use client'

// The switcher between the four legal documents, under each legal page's title.
//
// Every destination comes from FOOTER_LEGAL — the same registry the footer's legal row
// reads — so the two can never disagree. Client-side only to read the current path: the
// current document is marked with aria-current and the bronze hairline, the others are
// quiet small caps that warm to the action colour on hover.

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { FOOTER_LEGAL } from '@/content/marketing/footer'
import { cn } from '@/lib/utils/cn'

export function LegalNav({ className }: { className?: string }) {
  const pathname = usePathname()
  return (
    <nav aria-label="Legal documents" className={className}>
      <ul className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 sm:gap-x-8">
        {FOOTER_LEGAL.map(l => {
          const current = pathname === l.href
          return (
            <li key={l.href}>
              <Link
                href={l.href}
                aria-current={current ? 'page' : undefined}
                className={cn(
                  'relative inline-flex min-h-8 items-center text-fs-2xs font-semibold uppercase tracking-[0.18em]',
                  'transition-colors duration-200',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-action focus-visible:ring-offset-2',
                  current ? 'text-hero-ink' : 'text-hero-eyebrow hover:text-action',
                )}
              >
                {l.label}
                <span
                  aria-hidden
                  className={cn(
                    'absolute inset-x-0 bottom-0.5 h-px bg-hero-accent-rule transition-opacity duration-200',
                    current ? 'opacity-100' : 'opacity-0',
                  )}
                />
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
