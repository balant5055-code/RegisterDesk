// Phase P.2 — a product-page section: a centred header (label · title · subtitle) over the
// section's own content. Server Component.
//
// 2026-09-23 LUXURY PASS (owner): the pill Eyebrow became the bronze-ruled small-caps
// label and the heading is the display face set light — the same masthead voice as every
// other public page. The reveal-on-scroll and the section rhythm are unchanged.

import type { ReactNode } from 'react'
import { cn } from '@/lib/utils/cn'
import { SECTION_SPACING } from '@/lib/marketing/layout'
import { EditorialOverline } from '@/components/marketing/EditorialOverline'

export function PlatformSection({ id, eyebrow, title, subtitle, children }: {
  id:          string
  eyebrow?:    string
  title:       string
  subtitle?:   string
  /** Retained for call-site compatibility; all sections are white (L1 foundation). */
  background?: 'white' | 'muted'
  children:    ReactNode
}) {
  const headingId = `platform-${id}-heading`
  return (
    <section
      aria-labelledby={headingId}
      className="border-t border-border/40 bg-background first-of-type:border-t-0"
    >
      <div className={cn('rd-reveal mx-auto w-full max-w-6xl px-4 sm:px-6 lg:px-8', SECTION_SPACING.default)}>
        <div className="mx-auto max-w-2xl text-center">
          {eyebrow && <EditorialOverline>{eyebrow}</EditorialOverline>}
          <h2
            id={headingId}
            className={cn('text-balance font-display text-fs-2xl font-light tracking-[-0.015em] text-hero-ink leading-[1.15] sm:text-fs-3xl', eyebrow && 'mt-4')}
          >
            {title}
          </h2>
          {subtitle && (
            <p className="mt-3 text-fs-base leading-relaxed text-hero-ink-soft sm:text-fs-md">{subtitle}</p>
          )}
        </div>
        <div className="mt-10 sm:mt-12">{children}</div>
      </div>
    </section>
  )
}
