// Phase P.2 — /platform/identifiers product page (CONFIG ONLY).
// Generic terminology — any participant identifier, never bib-only.

import { PLATFORM_PAGES } from '@/lib/marketing/platform/registry'
import type { PlatformPageConfig } from '@/lib/marketing/platform/types'

export const IDENTIFIERS_PAGE: PlatformPageConfig = {
  slug:            'identifiers',
  breadcrumbLabel: 'Identifiers',
  seo: {
    title:       'Identifier Engine | RegisterDesk',
    description: 'One engine for every participant identifier — bibs, badge IDs, volunteer IDs, attendee and seat numbers — with transaction-safe assignment, lookup, and full history.',
  },
  hero: {
    eyebrow:      'Identifier Engine',
    headline:     'One engine for every participant identifier',
    subheadline:  'Assign and manage bib numbers, badge IDs, volunteer IDs, attendee numbers, seat numbers, or any participant ID — from one transaction-safe engine that fits every event type.',
    primaryCta:   'startFree',
    secondaryCta: 'bookDemo',
    screenshotId: 'identifier-center',
  },
  sections: [
    {
      kind: 'product_showcase', id: 'showcase', eyebrow: 'Product',
      title: 'A universal identifier engine',
      subtitle: 'One system for any identifier — not a bib-only tool.',
      screenshotId: 'identifier-center',
      highlights: [
        { iconKey: 'identifier', title: 'Any identifier type', description: 'Bibs, badges, seats, or delegate IDs from one engine.' },
        { iconKey: 'lock',       title: 'Transaction-safe',    description: 'Atomic allocation prevents duplicate identifiers.' },
        { iconKey: 'verify',     title: 'Full history',        description: 'Every assignment, swap, and release is recorded.' },
      ],
    },
    {
      kind: 'capability_grid', id: 'capabilities', eyebrow: 'Capabilities',
      title: 'Complete control over every identifier',
      subtitle: 'Assign, manage, and audit identifiers at any scale.',
      items: [
        { iconKey: 'identifier',   title: 'Universal identifier engine', description: 'One engine for any participant identifier.' },
        { iconKey: 'workspace',    title: 'Custom labels',               description: 'Name identifiers anything: bibs, badges, seats, IDs.' },
        { iconKey: 'reuse',        title: 'Identifier pools',            description: 'Define number pools and ranges per event.' },
        { iconKey: 'fast',         title: 'Automatic assignment',        description: 'Assign identifiers automatically at registration.' },
        { iconKey: 'crm',          title: 'Manual assignment',           description: 'Assign or override specific identifiers by hand.' },
        { iconKey: 'integrations', title: 'Swap',                        description: 'Swap identifiers between participants safely.' },
        { iconKey: 'reports',      title: 'Release',                     description: 'Release an identifier back to its pool.' },
        { iconKey: 'lock',         title: 'Reserve',                     description: 'Reserve identifiers for VIPs or special cases.' },
        { iconKey: 'security',     title: 'Block',                       description: 'Block specific identifiers from being assigned.' },
        { iconKey: 'domains',      title: 'Retire',                      description: 'Retire identifiers that should no longer be used.' },
        { iconKey: 'verify',       title: 'Lookup',                      description: 'Look up who holds any identifier instantly.' },
        { iconKey: 'finance',      title: 'History',                     description: 'A full audit history of every change.' },
        { iconKey: 'integrations', title: 'Migration',                   description: 'Migrate legacy bib or badge numbers in.' },
        { iconKey: 'fast',         title: 'Bulk operations',             description: 'Assign, release, or update identifiers in bulk.' },
        { iconKey: 'reuse',        title: 'Reuse policies',              description: 'Control whether released identifiers can be reused.' },
        { iconKey: 'security',     title: 'Identifier integrity',        description: 'Transaction-safe allocation prevents duplicates.' },
      ],
    },
    {
      kind: 'dashboard_preview', id: 'preview', eyebrow: 'In the product',
      title: 'Assign and track from the Identifier Center',
      subtitle: 'Pools, assignments, lookups, and history in one place.',
      screenshotId: 'event-home',
    },
    {
      kind: 'integrations', id: 'integrations', eyebrow: 'Integrations',
      title: 'Built into the event flow',
      subtitle: 'Identifiers connect registration and check-in.',
      items: [
        { iconKey: 'checkin',      title: 'Check-in',     description: 'Identifiers drive fast gate check-in.' },
        { iconKey: 'registration', title: 'Registration', description: 'Assign identifiers at sign-up.' },
        { iconKey: 'reports',      title: 'Bulk & export', description: 'Bulk operations and CSV export.' },
      ],
    },
  ],
  cta: {
    headline:     'One engine for every identifier you assign.',
    subheadline:  'Start free and run bibs, badges, or any participant ID with confidence.',
    primaryCta:   'startFree',
    secondaryCta: 'bookDemo',
  },
}

PLATFORM_PAGES.identifiers = IDENTIFIERS_PAGE
