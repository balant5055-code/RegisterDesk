// Phase P.1.4 — Marketing page wrapper. Server Component.
// Phase P.1.6.12 — footer mounted here (the single shell wrapping every public
// page): white canvas + the (only) marketing navbar + a <main> landmark + the
// (only) marketing footer. Navigation/footer live ONLY here — never duplicated.

import type { ReactNode } from 'react'
import { MarketingLayout } from './MarketingLayout'
import { MarketingNavbar } from '@/components/marketing/navigation/MarketingNavbar'
import { MarketingFooter } from '@/components/marketing/footer/MarketingFooter'

export function MarketingPageLayout({ children }: { children: ReactNode }) {
  return (
    <MarketingLayout className="flex flex-col">
      <MarketingNavbar />
      <main id="main-content" className="flex-1">{children}</main>
      <MarketingFooter />
    </MarketingLayout>
  )
}
