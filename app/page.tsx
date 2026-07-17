// Phase P.1.6.12 — Homepage assembly. Server Component (pure composition).
//
// Replaces the legacy homepage with the registry-driven marketing homepage. The
// page mounts the single MarketingPageLayout shell (navbar + footer) and iterates
// HOMEPAGE_SECTIONS — no manual ordering, no business logic, no duplication. SEO
// reuses the existing seo.ts helpers (metadata + JSON-LD).

import type { Metadata } from 'next'
import { MarketingPageLayout } from '@/components/marketing/layout/MarketingPageLayout'
import { HOMEPAGE_SECTIONS } from '@/content/marketing/homepage'
import { FAQ_ITEMS } from '@/content/marketing/faq'
import {
  buildMetadata, organizationJsonLd, softwareAppJsonLd, breadcrumbJsonLd, faqJsonLd,
} from '@/lib/marketing/seo'

export const metadata: Metadata = buildMetadata({
  title:       'RegisterDesk — The Event Operations Platform',
  description: 'Run every event from one platform: registration, payments, identifiers, check-in, certificates, and settlements.',
  path:        '/',
})

export default function Home() {
  const jsonLd = [
    organizationJsonLd(),
    softwareAppJsonLd(),
    breadcrumbJsonLd([{ name: 'Home', path: '/' }]),
    faqJsonLd(FAQ_ITEMS),
  ]

  return (
    <>
      <MarketingPageLayout>
        {HOMEPAGE_SECTIONS.map(({ id, Component }) => <Component key={id} />)}
      </MarketingPageLayout>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
    </>
  )
}
