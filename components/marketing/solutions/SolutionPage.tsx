// Phase P.3 — Solution page renderer. Server Component (zero client JS).
//
// Fixed product-page structure for vertical solution pages, composed entirely
// from the existing platform framework components (no new section logic, no
// duplicated switch). Routing / SEO is supplied by each route via buildMetadata.

import { MarketingPageLayout } from '@/components/marketing/layout/MarketingPageLayout'
import {
  PlatformHero, PlatformSection, ProductShowcase, CapabilityGrid, UseCases, PlatformCTA,
} from '@/components/marketing/platform'
import { organizationJsonLd, breadcrumbJsonLd } from '@/lib/marketing/seo'
import type { SolutionPageConfig } from '@/content/marketing/solution-pages'

export function SolutionPage({ config }: { config: SolutionPageConfig }) {
  const jsonLd = [
    organizationJsonLd(),
    breadcrumbJsonLd([{ name: 'Home', path: '/' }, { name: config.breadcrumbLabel, path: `/solutions/${config.slug}` }]),
  ]

  return (
    <>
      <MarketingPageLayout>
        <PlatformHero hero={config.hero} />

        <PlatformSection id="showcase" eyebrow={config.showcase.eyebrow} title={config.showcase.title} subtitle={config.showcase.subtitle} background="muted">
          <ProductShowcase screenshotId={config.showcase.screenshotId} highlights={config.showcase.highlights} />
        </PlatformSection>

        <PlatformSection id="capabilities" eyebrow={config.capabilities.eyebrow} title={config.capabilities.title} subtitle={config.capabilities.subtitle} background="white">
          <CapabilityGrid items={config.capabilities.items} />
        </PlatformSection>

        <PlatformSection id="use-cases" eyebrow={config.useCases.eyebrow} title={config.useCases.title} subtitle={config.useCases.subtitle} background="muted">
          <UseCases items={config.useCases.items} />
        </PlatformSection>

        <PlatformCTA cta={config.cta} />
      </MarketingPageLayout>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
    </>
  )
}
