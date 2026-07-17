// Phase P.2 (product-page architecture) — Platform page renderer. Server Component.
//
// PRODUCT-PAGE template. A /platform/* page is:
//   shell → hero (+ screenshot) → product sections → small CTA.
// The renderer dispatches ONLY product section kinds (product_showcase /
// dashboard_preview / ui_gallery / capability_grid / feature_highlights /
// integrations / use_cases). It has NO knowledge of homepage section types
// (workflow / features / benefits / faq) — those live only on `/`.
// No client JS, no animation. Routing / SEO / metadata unchanged.

import { MarketingPageLayout } from '@/components/marketing/layout/MarketingPageLayout'
import { platformJsonLd } from '@/lib/marketing/platform/seo'
import type { PlatformPageConfig, PlatformSectionConfig } from '@/lib/marketing/platform/types'
import { PlatformHero } from './PlatformHero'
import { PlatformSection } from './PlatformSection'
import { ProductShowcase } from './ProductShowcase'
import { CapabilityGrid } from './CapabilityGrid'
import { FeatureHighlights } from './FeatureHighlights'
import { UiGallery } from './UiGallery'
import { IntegrationsBlock } from './IntegrationsBlock'
import { UseCases } from './UseCases'
import { PlatformScreenshot } from './PlatformScreenshot'
import { PlatformCTA } from './PlatformCTA'

type Band = 'white' | 'muted'

function SectionRenderer({ section, background }: { section: PlatformSectionConfig; background: Band }) {
  const wrap = { id: section.id, eyebrow: section.eyebrow, title: section.title, subtitle: section.subtitle, background }
  switch (section.kind) {
    case 'product_showcase':   return <PlatformSection {...wrap}><ProductShowcase screenshotId={section.screenshotId} highlights={section.highlights} /></PlatformSection>
    case 'dashboard_preview':  return <PlatformSection {...wrap}><PlatformScreenshot screenshotId={section.screenshotId} /></PlatformSection>
    case 'ui_gallery':         return <PlatformSection {...wrap}><UiGallery screenshotIds={section.screenshotIds} /></PlatformSection>
    case 'capability_grid':    return <PlatformSection {...wrap}><CapabilityGrid items={section.items} /></PlatformSection>
    case 'feature_highlights': return <PlatformSection {...wrap}><FeatureHighlights items={section.items} /></PlatformSection>
    case 'integrations':       return <PlatformSection {...wrap}><IntegrationsBlock items={section.items} /></PlatformSection>
    case 'use_cases':          return <PlatformSection {...wrap}><UseCases items={section.items} /></PlatformSection>
    default:                   return null
  }
}

export function PlatformPage({ config }: { config: PlatformPageConfig }) {
  const jsonLd = platformJsonLd(config)
  return (
    <>
      <MarketingPageLayout>
        <PlatformHero hero={config.hero} />
        {config.sections.map((section, i) => (
          <SectionRenderer key={section.id} section={section} background={i % 2 === 0 ? 'muted' : 'white'} />
        ))}
        <PlatformCTA cta={config.cta} />
      </MarketingPageLayout>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
    </>
  )
}
