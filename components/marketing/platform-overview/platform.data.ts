// "The Platform" section — data only. The 7 connected modules shown in the left
// navigation; each drives a different RegisterDesk preview in the BrowserFrame.

import type { MarketingIconKey } from '@/lib/marketing/icons'

export interface PlatformModuleData {
  id:      string
  title:   string
  navDesc: string
  iconKey: MarketingIconKey
  url:     string
}

export const PLATFORM_HEADING = {
  eyebrow:     'The platform',
  title:       'One integrated platform, not a pile of tools',
  description: 'Every capability shares the same data, so registrations, participants, payments, and payouts stay connected end to end.',
}

export const PLATFORM_MODULES: PlatformModuleData[] = [
  { id: 'events',        title: 'Events',        navDesc: 'Create and manage events',        iconKey: 'sessions',     url: 'app.registerdesk.in/events' },
  { id: 'registrations', title: 'Registrations', navDesc: 'Forms, coupons, and waitlists',    iconKey: 'registration', url: 'app.registerdesk.in/registrations' },
  { id: 'payments',      title: 'Payments',      navDesc: 'Collect securely with Razorpay',   iconKey: 'payments',     url: 'app.registerdesk.in/payments' },
  { id: 'participants',  title: 'Participants',  navDesc: 'Profiles, bibs, and history',      iconKey: 'crm',          url: 'app.registerdesk.in/participants' },
  { id: 'checkin',       title: 'Check-in',      navDesc: 'Fast QR check-in at the gate',     iconKey: 'checkin',      url: 'app.registerdesk.in/check-in' },
  { id: 'certificates',  title: 'Certificates',  navDesc: 'Generate and issue automatically', iconKey: 'certificates', url: 'app.registerdesk.in/certificates' },
  { id: 'finance',       title: 'Finance',       navDesc: 'Track payouts and settlements',    iconKey: 'finance',      url: 'app.registerdesk.in/finance' },
]
