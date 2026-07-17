// Phase P.1.6.3 — Platform Overview content registry.
//
// RegisterDesk presented as ONE integrated platform — capabilities grouped into
// meaningful operational areas, not a flat feature grid. Every module is a
// shipped capability and links into the approved Platform IA (the exact hrefs
// used by the navigation registry — no dead links outside the IA). All modules
// are `available` today; the `status` field carries beta/coming-soon for the
// future without changing the components. No fake features.

import type { PlatformGroupDef } from '@/lib/marketing/types'

export const PLATFORM_OVERVIEW_HEADING = {
  eyebrow:  'The platform',
  title:    'One integrated platform, not a pile of tools',
  subtitle: 'Every capability shares the same data, so registrations, participants, payments, and payouts stay connected end to end.',
}

export const PLATFORM_GROUPS: PlatformGroupDef[] = [
  {
    id: 'registration', title: 'Registration & Tickets', iconKey: 'registration', href: '/platform/registration', status: 'available',
    description: 'Open registrations with custom forms, passes, and discounts.',
    modules: [
      { id: 'forms',    label: 'Registration forms', iconKey: 'registration', href: '/platform/registration', status: 'available' },
      { id: 'passes',   label: 'Tickets & passes',   iconKey: 'invoice',      href: '/platform/registration', status: 'available' },
      { id: 'coupons',  label: 'Coupons & waitlists', iconKey: 'fast',        href: '/platform/registration', status: 'available' },
    ],
  },
  {
    id: 'participants', title: 'Participants', iconKey: 'crm', href: '/platform/crm', status: 'available',
    description: 'A unified record of every attendee — contacts, identifiers, and credentials.',
    modules: [
      { id: 'crm',          label: 'CRM & audience',  iconKey: 'crm',          href: '/platform/crm',          status: 'available' },
      { id: 'identifiers',  label: 'Identifier engine', iconKey: 'identifier', href: '/platform/identifiers',  status: 'available' },
      { id: 'certificates', label: 'Certificates',    iconKey: 'certificates', href: '/platform/certificates', status: 'available' },
    ],
  },
  {
    id: 'operations', title: 'Event Operations', iconKey: 'checkin', href: '/platform/check-in', status: 'available',
    description: 'Run the day — check-in, sessions, and attendee communication.',
    modules: [
      { id: 'checkin',  label: 'Check-in & attendance', iconKey: 'checkin',        href: '/platform/check-in',      status: 'available' },
      { id: 'sessions', label: 'Sessions & agenda',     iconKey: 'sessions',       href: '/platform/sessions',      status: 'available' },
      { id: 'emails',   label: 'Attendee emails',       iconKey: 'communications', href: '/platform/communications', status: 'available' },
    ],
  },
  {
    id: 'finance', title: 'Finance', iconKey: 'finance', href: '/platform/finance', status: 'available',
    description: 'Collect payments, handle refunds, and get paid to your account.',
    modules: [
      { id: 'payments',    label: 'Payments & checkout',  iconKey: 'payments',    href: '/platform/payments', status: 'available' },
      { id: 'refunds',     label: 'Refunds',              iconKey: 'invoice',     href: '/platform/payments', status: 'available' },
      { id: 'settlements', label: 'Wallet & settlements', iconKey: 'settlements', href: '/platform/finance',  status: 'available' },
    ],
  },
  {
    id: 'insights', title: 'Insights', iconKey: 'reports', href: '/platform/finance', status: 'available',
    description: 'Real-time dashboards, financial reports, and a developer API.',
    modules: [
      { id: 'dashboards', label: 'Live dashboards',        iconKey: 'reports', href: '/platform/finance', status: 'available' },
      { id: 'revenue',    label: 'Revenue & payout reports', iconKey: 'finance', href: '/platform/finance', status: 'available' },
      { id: 'api',        label: 'Developer API & webhooks', iconKey: 'api',    href: '/platform/api',     status: 'available' },
    ],
  },
]
