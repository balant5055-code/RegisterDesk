// Phase P.1.3 — Section band wrapper. Server Component.
//
// One reusable section primitive: background band + vertical rhythm + container.
// Every marketing section composes from this — no duplicated section shells.

import type { ReactNode } from 'react'
import { cn } from '@/lib/utils/cn'
import { SURFACES, type SurfaceBand } from '@/lib/marketing/theme'
import { SECTION_SPACING, MARKETING_CONTAINER, type SectionSpacing, type MarketingContainer } from '@/lib/marketing/layout'

export interface SectionLayoutProps {
  background?: SurfaceBand
  spacing?:    SectionSpacing
  container?:  MarketingContainer
  id?:         string
  /** id of the heading that labels this section (a11y). */
  labelledBy?: string
  className?:  string
  children:    ReactNode
}

export function SectionLayout({
  background = 'white', spacing = 'default', container = 'page', id, labelledBy, className, children,
}: SectionLayoutProps) {
  return (
    <section id={id} aria-labelledby={labelledBy} className={cn(SURFACES[background], SECTION_SPACING[spacing])}>
      <div className={cn(MARKETING_CONTAINER[container], 'rd-reveal', className)}>{children}</div>
    </section>
  )
}
