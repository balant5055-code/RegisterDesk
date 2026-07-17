// Phase P.3 — /resources hub. Server Component (zero client JS).
//
// A directory of resources, sourced from the navigation registry (the approved
// IA) — not a homepage section. Reuses the platform hero/section/CTA components.

import type { Metadata } from 'next'
import { typography } from '@/lib/ds/typography'
import { cn } from '@/lib/utils/cn'
import { Card } from '@/components/marketing/Card'
import { IconChip } from '@/components/marketing/IconChip'
import Link from 'next/link'
import { ArrowRight } from 'lucide-react'
import { MarketingPageLayout } from '@/components/marketing/layout/MarketingPageLayout'
import { PlatformHero, PlatformSection, PlatformCTA } from '@/components/marketing/platform'
import { PRIMARY_NAV } from '@/content/marketing/navigation'
import { MARKETING_ICONS } from '@/lib/marketing/icons'
import { buildMetadata, organizationJsonLd, breadcrumbJsonLd } from '@/lib/marketing/seo'

const RESOURCES = PRIMARY_NAV.find(m => m.id === 'resources')?.groups?.flatMap(g => g.items) ?? []

export const metadata: Metadata = buildMetadata({
  title:       'Resources | RegisterDesk',
  description: 'Documentation, API reference, integrations, the blog, customer stories, FAQs, and our roadmap — everything to get the most out of RegisterDesk.',
  path:        '/resources',
})

export default function ResourcesPage() {
  const jsonLd = [
    organizationJsonLd(),
    breadcrumbJsonLd([{ name: 'Home', path: '/' }, { name: 'Resources', path: '/resources' }]),
  ]

  return (
    <>
      <MarketingPageLayout>
        <PlatformHero
          hero={{
            eyebrow:      'Resources',
            headline:     'Everything you need to get the most out of RegisterDesk',
            subheadline:  'Guides, API reference, integrations, customer stories, and what’s coming next.',
            primaryCta:   'startFree',
            secondaryCta: 'readDocs',
          }}
        />

        <PlatformSection id="resources" eyebrow="Explore" title="Browse the resources" subtitle="Find documentation, references, and stories." background="white">
          <ul className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {RESOURCES.map(item => {
              const Icon = item.iconKey ? MARKETING_ICONS[item.iconKey] : null
              return (
                <li key={item.id} className="flex">
                  <Card
                    as={Link}
                    href={item.href}
                    className="flex h-full flex-col focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                  >
                    {Icon && (
                      <IconChip className="size-11">
                        <Icon className="size-5 text-primary" aria-hidden />
                      </IconChip>
                    )}
                    <h3 className={cn(typography.cardTitle, 'mt-5 text-foreground')}>{item.title}</h3>
                    {item.description && <p className={`${typography.body} mt-2 text-muted-foreground`}>{item.description}</p>}
                    <span className="mt-4 inline-flex items-center gap-1 text-[var(--fs-sm)] font-medium text-primary">
                      Open <ArrowRight className="size-3" aria-hidden />
                    </span>
                  </Card>
                </li>
              )
            })}
          </ul>
        </PlatformSection>

        <PlatformCTA
          cta={{
            headline:     'Ready to run your next event?',
            subheadline:  'Start free and explore the platform.',
            primaryCta:   'startFree',
            secondaryCta: 'bookDemo',
          }}
        />
      </MarketingPageLayout>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
    </>
  )
}
