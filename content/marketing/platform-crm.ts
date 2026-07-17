// Phase P.2 — /platform/crm product page (CONFIG ONLY).

import { PLATFORM_PAGES } from '@/lib/marketing/platform/registry'
import type { PlatformPageConfig } from '@/lib/marketing/platform/types'

export const CRM_PAGE: PlatformPageConfig = {
  slug:            'crm',
  breadcrumbLabel: 'CRM',
  seo: {
    title:       'CRM & Audience | RegisterDesk',
    description: 'A built-in CRM for your audience — unified contacts, participant timelines, notes, tags, communication history, search, and exports across every event.',
  },
  hero: {
    eyebrow:      'CRM & Audience',
    headline:     'A CRM built for your audience',
    subheadline:  'Every registration becomes a contact — with a unified profile, timeline, notes, tags, and communication history you can search and segment across events.',
    primaryCta:   'startFree',
    secondaryCta: 'bookDemo',
    screenshotId: 'crm',
  },
  sections: [
    {
      kind: 'product_showcase', id: 'showcase', eyebrow: 'Product',
      title: 'Your whole audience in one place',
      subtitle: 'Contacts, timelines, tags, and history across every event.',
      screenshotId: 'crm',
      highlights: [
        { iconKey: 'crm',    title: 'One audience',   description: 'Unified contacts across every event.' },
        { iconKey: 'reuse',  title: 'Tags & segments', description: 'Organize and target your audience.' },
        { iconKey: 'verify', title: 'Full timeline',  description: 'Every interaction a contact has had.' },
      ],
    },
    {
      kind: 'capability_grid', id: 'capabilities', eyebrow: 'Capabilities',
      title: 'Everything your audience needs, in one record',
      subtitle: 'Not a spreadsheet — a connected contact platform.',
      items: [
        { iconKey: 'crm',            title: 'Unified contacts',      description: 'One contact record across every event.' },
        { iconKey: 'verify',         title: 'Participant timeline',  description: 'A complete history of each contact.' },
        { iconKey: 'workspace',      title: 'Notes',                 description: 'Add private notes to any contact.' },
        { iconKey: 'reuse',          title: 'Tags',                  description: 'Tag and segment your audience.' },
        { iconKey: 'broadcast',      title: 'Audience',              description: 'Build audiences from tags and segments.' },
        { iconKey: 'communications', title: 'Communication history', description: 'See the emails a contact has received.' },
        { iconKey: 'fast',           title: 'Search',                description: 'Find any contact in seconds.' },
        { iconKey: 'finance',        title: 'Exports',               description: 'Export contacts and reports to CSV.' },
      ],
    },
    {
      kind: 'feature_highlights', id: 'highlights', eyebrow: 'Highlights',
      title: 'Turn registrations into relationships',
      subtitle: 'The parts that keep your audience close.',
      items: [
        { iconKey: 'verify', title: 'Participant timeline', description: 'See every registration, payment, and message for a contact over time.' },
        { iconKey: 'reuse',  title: 'Tags & audiences',     description: 'Segment contacts and build audiences you can act on.' },
        { iconKey: 'fast',   title: 'Instant search',       description: 'Find any contact across every event in seconds.' },
      ],
    },
    {
      kind: 'integrations', id: 'integrations', eyebrow: 'Integrations',
      title: 'Connected to how you reach people',
      subtitle: 'Contacts feed email, exports, and audiences.',
      items: [
        { iconKey: 'communications', title: 'Email',      description: 'Reach contacts with email.' },
        { iconKey: 'reports',        title: 'CSV export', description: 'Export contacts and reports.' },
        { iconKey: 'broadcast',      title: 'Audiences',  description: 'Build audiences from segments.' },
      ],
    },
  ],
  cta: {
    headline:     'Bring your whole audience together.',
    subheadline:  'Start free and turn registrations into lasting contacts.',
    primaryCta:   'startFree',
    secondaryCta: 'bookDemo',
  },
}

PLATFORM_PAGES.crm = CRM_PAGE
