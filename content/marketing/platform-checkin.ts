// Phase P.2 — /platform/check-in product page (CONFIG ONLY).

import { PLATFORM_PAGES } from '@/lib/marketing/platform/registry'
import type { PlatformPageConfig } from '@/lib/marketing/platform/types'

export const CHECKIN_PAGE: PlatformPageConfig = {
  slug:            'check-in',
  breadcrumbLabel: 'Check-in',
  seo: {
    title:       'Check-in | RegisterDesk',
    description: 'Fast attendee check-in and live attendance — QR scanning that works offline, walk-in registration, identifier lookup, and real-time attendance reports.',
  },
  hero: {
    eyebrow:      'Check-in',
    headline:     'Fast check-in and live attendance, online or off',
    subheadline:  'Scan QR tickets to admit attendees in seconds, register walk-ins on the spot, and track attendance live — even when the network drops.',
    primaryCta:   'startFree',
    secondaryCta: 'bookDemo',
    screenshotId: 'checkin',
  },
  sections: [
    {
      kind: 'product_showcase', id: 'showcase', eyebrow: 'Product',
      title: 'Move crowds without the chaos',
      subtitle: 'A fast, reliable gate — connected to the rest of the event.',
      screenshotId: 'event-home',
      highlights: [
        { iconKey: 'qr',      title: 'Scan and admit', description: 'QR check-in admits attendees in seconds.' },
        { iconKey: 'fast',    title: 'Works offline',  description: 'Keep checking in when the venue Wi-Fi drops.' },
        { iconKey: 'reports', title: 'Live attendance', description: 'Watch attendance update in real time.' },
      ],
    },
    {
      kind: 'capability_grid', id: 'capabilities', eyebrow: 'Capabilities',
      title: 'Everything you need at the gate',
      subtitle: 'One check-in system — fast, offline-capable, and connected.',
      items: [
        { iconKey: 'qr',           title: 'QR check-in',          description: 'Scan QR tickets for instant check-in.' },
        { iconKey: 'fast',         title: 'Offline check-in',     description: 'Keep checking in even without a network connection.' },
        { iconKey: 'registration', title: 'Walk-in registration', description: 'Register walk-ins on the spot at the gate.' },
        { iconKey: 'reports',      title: 'Attendance tracking',  description: 'Track who attended in real time.' },
        { iconKey: 'identifier',   title: 'Identifier lookup',    description: 'Look up attendees by bib, badge, or ID.' },
        { iconKey: 'security',     title: 'Duplicate prevention', description: 'Prevent double check-ins automatically.' },
        { iconKey: 'verify',       title: 'Manual check-in',      description: 'Check attendees in by hand when needed.' },
        { iconKey: 'sessions',     title: 'Session attendance',   description: 'Track attendance per session or track.' },
        { iconKey: 'workspace',    title: 'Real-time dashboard',  description: 'Watch check-ins live as the gate runs.' },
        { iconKey: 'finance',      title: 'Attendance reports',   description: 'Export attendance reports after the event.' },
      ],
    },
    {
      kind: 'dashboard_preview', id: 'preview', eyebrow: 'In the product',
      title: 'Scan on any device',
      subtitle: 'QR check-in that works offline and syncs when you reconnect.',
      screenshotId: 'checkin',
    },
    {
      kind: 'integrations', id: 'integrations', eyebrow: 'Integrations',
      title: 'Connected to the event',
      subtitle: 'Check-in draws on identifiers and feeds attendance.',
      items: [
        { iconKey: 'identifier', title: 'Identifiers',        description: 'Look up attendees by bib or badge.' },
        { iconKey: 'sessions',   title: 'Sessions',           description: 'Track per-session attendance.' },
        { iconKey: 'reports',    title: 'Attendance reports', description: 'Export attendance after the event.' },
      ],
    },
  ],
  cta: {
    headline:     'Run a fast, reliable gate.',
    subheadline:  'Start free and check attendees in — online or off.',
    primaryCta:   'startFree',
    secondaryCta: 'bookDemo',
  },
}

PLATFORM_PAGES['check-in'] = CHECKIN_PAGE
