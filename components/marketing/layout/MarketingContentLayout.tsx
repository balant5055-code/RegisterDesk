// Phase P.1.4 — Reading-width page wrapper (legal / docs / prose). Server Component.

import type { ReactNode } from 'react'
import { MarketingPageLayout } from './MarketingPageLayout'
import { ContentContainer } from './ContentContainer'
import { SECTION_SPACING } from '@/lib/marketing/layout'

export function MarketingContentLayout({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <MarketingPageLayout>
      <div className={SECTION_SPACING.default}>
        <ContentContainer className={className}>{children}</ContentContainer>
      </div>
    </MarketingPageLayout>
  )
}
