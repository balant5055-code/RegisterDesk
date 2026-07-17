// Phase P.2 — /platform/api product page (CONFIG ONLY).

import { PLATFORM_PAGES } from '@/lib/marketing/platform/registry'
import type { PlatformPageConfig } from '@/lib/marketing/platform/types'

export const API_PAGE: PlatformPageConfig = {
  slug:            'api',
  breadcrumbLabel: 'Developer API',
  seo: {
    title:       'Developer API & Webhooks | RegisterDesk',
    description: 'Build on RegisterDesk with a documented REST API, signed webhooks, API keys, integrations, and the metadata platform. Available on Pro and above.',
  },
  hero: {
    eyebrow:      'Developer API',
    headline:     'Build on RegisterDesk with a developer API',
    subheadline:  'A documented REST API and signed webhooks let you read registrations, donations, and events, and connect RegisterDesk to the rest of your stack.',
    primaryCta:   'startFree',
    secondaryCta: 'readDocs',
    screenshotId: 'developer-api',
  },
  sections: [
    {
      kind: 'product_showcase', id: 'showcase', eyebrow: 'Product',
      title: 'A developer platform, not just an export',
      subtitle: 'Read your data and react to events programmatically.',
      screenshotId: 'developer-api',
      highlights: [
        { iconKey: 'api',      title: 'REST API',         description: 'Read registrations, donations, and events.' },
        { iconKey: 'webhooks', title: 'Signed webhooks',  description: 'Real-time, verified event callbacks.' },
        { iconKey: 'reuse',    title: 'Metadata platform', description: 'Attach and read structured metadata.' },
      ],
    },
    {
      kind: 'capability_grid', id: 'capabilities', eyebrow: 'Capabilities',
      title: 'Everything a developer needs',
      subtitle: 'Read your data and react to events with confidence.',
      items: [
        { iconKey: 'api',          title: 'REST APIs',           description: 'Read registrations, donations, and events.' },
        { iconKey: 'webhooks',     title: 'Signed webhooks',     description: 'Receive verified, real-time event callbacks.' },
        { iconKey: 'lock',         title: 'API keys',            description: 'Manage API keys from your workspace.' },
        { iconKey: 'security',     title: 'Authentication',      description: 'Authenticate every request securely.' },
        { iconKey: 'integrations', title: 'Integrations',        description: 'Connect RegisterDesk to your own tools.' },
        { iconKey: 'reuse',        title: 'Metadata platform',   description: 'Attach and read structured metadata.' },
        { iconKey: 'verify',       title: 'Documentation',       description: 'Clear API reference and guides.' },
        { iconKey: 'workspace',    title: 'Developer experience', description: 'Predictable, well-structured endpoints.' },
      ],
    },
    {
      kind: 'feature_highlights', id: 'highlights', eyebrow: 'Highlights',
      title: 'Extend the platform to fit your workflow',
      subtitle: 'Automate and integrate with your existing systems.',
      items: [
        { iconKey: 'webhooks', title: 'Real-time webhooks', description: 'React the moment a registration or donation happens.' },
        { iconKey: 'reuse',    title: 'Metadata platform',  description: 'Extend records with structured metadata you can read back.' },
        { iconKey: 'security', title: 'Secure by design',   description: 'API keys and signed webhooks keep access controlled.' },
      ],
    },
    {
      kind: 'integrations', id: 'integrations', eyebrow: 'Integrations',
      title: 'Connect your stack',
      subtitle: 'Push and pull event data however you need.',
      items: [
        { iconKey: 'webhooks',     title: 'Webhooks', description: 'Push events to your endpoints.' },
        { iconKey: 'integrations', title: 'Your stack', description: 'Connect RegisterDesk to your own tools.' },
        { iconKey: 'reuse',        title: 'Metadata',  description: 'Read structured metadata via the API.' },
      ],
    },
  ],
  cta: {
    headline:     'Start building on RegisterDesk.',
    subheadline:  'Start free and connect your events to the rest of your stack.',
    primaryCta:   'startFree',
    secondaryCta: 'readDocs',
  },
}

PLATFORM_PAGES.api = API_PAGE
