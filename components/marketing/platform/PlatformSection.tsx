// Phase P.2 (UX redesign) — Platform section band + header. Server Component.
//
// Self-contained premium wrapper (does NOT use the shared homepage SectionHeader,
// so homepage styling is untouched). Pill eyebrow, large display title, generous
// vertical rhythm, alternating surface, hairline top border for clean section
// transitions. Provides the <h2> for each platform section.

import type { ReactNode } from 'react'
import { cn } from '@/lib/utils/cn'
import { SECTION_SPACING } from '@/lib/marketing/layout'
import { marketingType } from '@/lib/marketing/theme'
import { Eyebrow } from '@/components/marketing/Eyebrow'

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
      className={cn('border-t border-border/40 bg-white')}
    >
      <div className={cn('rd-reveal mx-auto w-full max-w-6xl px-4 sm:px-6 lg:px-8', SECTION_SPACING.default)}>
        <div className="mx-auto max-w-2xl text-center">
          {eyebrow && <Eyebrow>{eyebrow}</Eyebrow>}
          <h2 id={headingId} className={cn(marketingType.sectionHeading, eyebrow && 'mt-5')}>
            {title}
          </h2>
          {subtitle && (
            <p className="mt-4 text-[var(--fs-lg)] leading-relaxed text-muted-foreground">{subtitle}</p>
          )}
        </div>
        <div className="mt-14">{children}</div>
      </div>
    </section>
  )
}
