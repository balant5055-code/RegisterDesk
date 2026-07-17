// Phase P.3 — /security trust page. Server Component (zero client JS).
//
// Company-level security & trust page. Reads ONLY from the security registry
// (SECURITY_CAPABILITIES / SECURITY_FUTURE). Reuses the platform hero/section/
// capability/CTA components. Every claim maps to a real control — no compliance
// or certification claims. Not a homepage section.

import type { Metadata } from 'next'
import { MarketingPageLayout } from '@/components/marketing/layout/MarketingPageLayout'
import { PlatformHero, PlatformSection, CapabilityGrid, PlatformCTA } from '@/components/marketing/platform'
import { SECURITY_CAPABILITIES, SECURITY_FUTURE } from '@/content/marketing/security'
import type { PlatformCapabilityItem } from '@/lib/marketing/platform/types'
import { buildMetadata, organizationJsonLd, breadcrumbJsonLd } from '@/lib/marketing/seo'

const toItems = (rows: { iconKey: PlatformCapabilityItem['iconKey']; title: string; description: string }[]): PlatformCapabilityItem[] =>
  rows.map(r => ({ iconKey: r.iconKey, title: r.title, description: r.description }))

export const metadata: Metadata = buildMetadata({
  title:       'Security & Trust | RegisterDesk',
  description: 'How RegisterDesk protects your operations and your attendees’ data — workspace isolation, role-based access, audit history, data ownership, and secure payments.',
  path:        '/security',
})

export default function SecurityPage() {
  const jsonLd = [
    organizationJsonLd(),
    breadcrumbJsonLd([{ name: 'Home', path: '/' }, { name: 'Security', path: '/security' }]),
  ]

  return (
    <>
      <MarketingPageLayout>
        <PlatformHero
          hero={{
            eyebrow:      'Security & Trust',
            headline:     'Built so you can trust RegisterDesk with your events',
            subheadline:  'Every claim below maps to a real capability — access control, isolation, audit history, and secure payments — protecting your operations and your attendees’ data.',
            primaryCta:   'startFree',
            secondaryCta: 'bookDemo',
            screenshotId: 'security-center',
          }}
        />

        <PlatformSection id="controls" eyebrow="Controls" title="Real controls, built in today" subtitle="Everything below is shipped." background="muted">
          <CapabilityGrid items={toItems(SECURITY_CAPABILITIES)} />
        </PlatformSection>

        <PlatformSection id="roadmap" eyebrow="Future-ready" title="On our security roadmap" subtitle="Planned — not available yet, and we never present roadmap items as shipped." background="white">
          <CapabilityGrid items={toItems(SECURITY_FUTURE)} />
        </PlatformSection>

        <PlatformCTA
          cta={{
            headline:     'Run events on a platform you can trust.',
            subheadline:  'Start free with security and access control built in.',
            primaryCta:   'startFree',
            secondaryCta: 'bookDemo',
          }}
        />
      </MarketingPageLayout>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
    </>
  )
}
