// Phase P.2 — /platform/participants product page (CONFIG ONLY).

import { PLATFORM_PAGES } from '@/lib/marketing/platform/registry'
import type { PlatformPageConfig } from '@/lib/marketing/platform/types'

export const PARTICIPANTS_PAGE: PlatformPageConfig = {
  slug:            'participants',
  breadcrumbLabel: 'Participants',
  seo: {
    title:       'Participants | RegisterDesk',
    description: 'Manage participants beyond registrations — 360° profiles, custom attributes, identifiers, CRM, sessions, certificates, and a complete participant history.',
  },
  hero: {
    eyebrow:      'Participants',
    headline:     'Manage participants, not just registrations',
    subheadline:  'Every registrant becomes a managed participant — with a 360° profile, custom attributes, identifiers, sessions, certificates, and full history in one record.',
    primaryCta:   'startFree',
    secondaryCta: 'bookDemo',
    screenshotId: 'participant-360',
  },
  sections: [
    {
      kind: 'product_showcase', id: 'showcase', eyebrow: 'Product',
      title: 'One record for every attendee',
      subtitle: 'Registration, payments, identifiers, sessions, and history together.',
      screenshotId: 'participant-360',
      highlights: [
        { iconKey: 'crm',   title: '360° participant record', description: 'Registration, payments, identifiers, and history in one view.' },
        { iconKey: 'reuse', title: 'Custom data & metadata',  description: 'Attach any field or structured metadata per attendee.' },
        { iconKey: 'fast',  title: 'Find anyone fast',         description: 'Search and manage every attendee in seconds.' },
      ],
    },
    {
      kind: 'capability_grid', id: 'capabilities', eyebrow: 'Capabilities',
      title: 'A single home for every attendee',
      subtitle: 'One participant record — not scattered spreadsheets and tools.',
      items: [
        { iconKey: 'crm',          title: 'Participant profiles',   description: 'A 360° profile for every attendee.' },
        { iconKey: 'registration', title: 'Registration management', description: 'Manage every registration from one place.' },
        { iconKey: 'workspace',    title: 'Custom fields',          description: 'Capture custom data per participant.' },
        { iconKey: 'reuse',        title: 'Metadata platform',      description: 'Attach structured metadata to any participant.' },
        { iconKey: 'identifier',   title: 'Identifier assignment',  description: 'Assign bibs, badges, or any ID per participant.' },
        { iconKey: 'integrations', title: 'CRM integration',        description: 'Participants roll up into a unified CRM.' },
        { iconKey: 'sessions',     title: 'Session management',     description: 'Track session enrolment per participant.' },
        { iconKey: 'certificates', title: 'Certificate readiness',  description: 'See who is eligible for certificates.' },
        { iconKey: 'verify',       title: 'Participant timeline',   description: 'A complete history of every participant action.' },
        { iconKey: 'finance',      title: 'Exports',                description: 'Export participants and reports to CSV.' },
      ],
    },
    {
      kind: 'dashboard_preview', id: 'preview', eyebrow: 'In the product',
      title: 'Your whole audience in one place',
      subtitle: 'Contacts, timelines, and history across every event.',
      screenshotId: 'crm',
    },
    {
      kind: 'integrations', id: 'integrations', eyebrow: 'Integrations',
      title: 'Connected across the platform',
      subtitle: 'Participant records power identifiers, certificates, and more.',
      items: [
        { iconKey: 'identifier',   title: 'Identifiers',  description: 'Assign bibs or badges per participant.' },
        { iconKey: 'certificates', title: 'Certificates', description: 'Issue certificates to eligible participants.' },
        { iconKey: 'sessions',     title: 'Sessions',     description: 'Track session enrolment per participant.' },
        { iconKey: 'reports',      title: 'CSV export',   description: 'Export participant data on demand.' },
      ],
    },
  ],
  cta: {
    headline:     'Bring every participant into one record.',
    subheadline:  'Start free and manage your attendees the connected way.',
    primaryCta:   'startFree',
    secondaryCta: 'bookDemo',
  },
}

PLATFORM_PAGES.participants = PARTICIPANTS_PAGE
