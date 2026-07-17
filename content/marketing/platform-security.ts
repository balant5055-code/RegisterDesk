// Phase P.2 — /platform/security product page (CONFIG ONLY).
// Every statement maps to a real control. NO compliance/certification claims,
// NO PCI/uptime claims, NO fabricated infrastructure.

import { PLATFORM_PAGES } from '@/lib/marketing/platform/registry'
import type { PlatformPageConfig } from '@/lib/marketing/platform/types'

export const SECURITY_PAGE: PlatformPageConfig = {
  slug:            'security',
  breadcrumbLabel: 'Security',
  seo: {
    title:       'Security & Trust | RegisterDesk',
    description: 'Security built into every event — workspace and event isolation, role-based access, audit history, data ownership, and secure payments.',
  },
  hero: {
    eyebrow:      'Security & Trust',
    headline:     'Security built into every event',
    subheadline:  'Workspace and event isolation, role-based access, audit history, and secure payments keep your operations and your attendees’ data protected.',
    primaryCta:   'startFree',
    secondaryCta: 'bookDemo',
    screenshotId: 'security-center',
  },
  sections: [
    {
      kind: 'product_showcase', id: 'showcase', eyebrow: 'Product',
      title: 'Trust built into the platform',
      subtitle: 'Protect sensitive data and large teams from day one.',
      screenshotId: 'security-center',
      highlights: [
        { iconKey: 'security', title: 'Isolated by default', description: 'Workspace and event-level data isolation.' },
        { iconKey: 'lock',     title: 'Role-based access',   description: 'Least-privilege roles for every member.' },
        { iconKey: 'verify',   title: 'Audited',             description: 'Timestamped history of key actions.' },
      ],
    },
    {
      kind: 'capability_grid', id: 'capabilities', eyebrow: 'Controls',
      title: 'Real controls, no buzzwords',
      subtitle: 'Everything below is shipped today.',
      items: [
        { iconKey: 'security',     title: 'Workspace isolation', description: "Every organizer's data is scoped to its own workspace." },
        { iconKey: 'lock',         title: 'Role-based access',   description: 'Granular roles keep members to exactly what they need.' },
        { iconKey: 'verify',       title: 'Audit logs',          description: 'Key actions are recorded with a timestamped history.' },
        { iconKey: 'reuse',        title: 'Data ownership',      description: 'Export participants and reports on demand.' },
        { iconKey: 'payments',     title: 'Secure payments',     description: 'Card data is never stored on RegisterDesk.' },
        { iconKey: 'domains',      title: 'Privacy',             description: 'Your data stays scoped and access-controlled.' },
        { iconKey: 'workspace',    title: 'Durable storage',     description: 'Data is held on managed, replicated cloud infrastructure.' },
        { iconKey: 'communications', title: 'Verified email',    description: 'Account sign-in uses verified email.' },
      ],
    },
    {
      kind: 'feature_highlights', id: 'highlights', eyebrow: 'Highlights',
      title: 'Built-in by default',
      subtitle: 'The controls that matter, on from day one.',
      items: [
        { iconKey: 'security', title: 'Workspace & event isolation', description: 'Data is scoped per organizer and per event.' },
        { iconKey: 'lock',     title: 'Granular roles',              description: 'Each member sees only what their role allows.' },
        { iconKey: 'verify',   title: 'Audit history',               description: 'A timestamped record of key actions.' },
      ],
    },
    {
      kind: 'integrations', id: 'integrations', eyebrow: 'Across the platform',
      title: 'Security throughout',
      subtitle: 'Controls apply across every part of the platform.',
      items: [
        { iconKey: 'lock',     title: 'Role-based access', description: 'Scoped team permissions.' },
        { iconKey: 'verify',   title: 'Audit history',     description: 'Timestamped record of key actions.' },
        { iconKey: 'payments', title: 'Payment security',  description: 'Card data never stored on RegisterDesk.' },
      ],
    },
  ],
  cta: {
    headline:     'Run events on a platform you can trust.',
    subheadline:  'Start free with security and access control built in.',
    primaryCta:   'startFree',
    secondaryCta: 'bookDemo',
  },
}

PLATFORM_PAGES.security = SECURITY_PAGE
